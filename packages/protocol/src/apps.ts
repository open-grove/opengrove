import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";

const appIdentifierSchema = z.string().trim().min(1).describe("Mounted App identifier.");
const semanticVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/u)
  .describe("Formal App version in X.Y.Z form.");

const appReleaseCheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    severity: z.enum(["blocking", "warning"]),
    status: z.enum(["passed", "blocked", "warning"]),
    detail: z.string(),
  })
  .passthrough();

const appReleaseEmployeeSchema = z.object({
  memberId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  avatarMode: z.enum(["generated", "initials", "upload"]).optional(),
  avatarSeed: z.string().trim().max(512).optional(),
  avatarDataUrl: z.string().trim().max(1_500_000).optional(),
  role: z.string().trim().max(40_000),
  kernel: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(240),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  contextTokenBudget: z.number().int().positive().optional(),
  accessMode: z.enum(["default", "auto-review", "full-access"]).optional(),
  color: z.string().trim().min(1).max(64),
  availableSkillIds: z.array(z.string()),
  defaultSkillIds: z.array(z.string()),
  visibility: z.enum(["private", "public"]),
  publicDescription: z.string().trim().max(4_000).optional(),
  publicSkills: z.array(z.string()),
  inputSpec: z.string().trim().max(8_000).optional(),
  outputSpec: z.string().trim().max(8_000).optional(),
});

const appReleaseIdentitySchema = z
  .object({
    appId: z.string(),
    packageId: z.string().optional(),
    packageKey: z.string().optional(),
    source: z.enum(["mounted", "registry"]),
    appRoot: z.string(),
    workspaceRoot: z.string(),
  })
  .passthrough();

const appReleaseMetadataSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4_000),
  icon: z.string().trim().max(1_500_000).optional(),
});

export const mountedAppReleaseSchema = z
  .object({
    identity: appReleaseIdentitySchema,
    app: appReleaseMetadataSchema,
    version: semanticVersionSchema,
    latestPublishedVersion: semanticVersionSchema.optional(),
    releaseNotes: z.string().trim().max(800),
    visibility: z.enum(["public", "restricted"]),
    minHostReleaseNumber: z.number().int().nonnegative(),
    employees: z.array(appReleaseEmployeeSchema),
    checks: z.array(appReleaseCheckSchema),
  })
  .passthrough();

export const RELEASE_CONTROL_FAILURE_STAGES = ["trusted_build", "artifact_pack", "artifact_gate", "workflow"] as const;
export const RELEASE_CONTROL_ACTIONS = ["retry_candidate", "retry_build", "abandon"] as const;
export const RELEASE_CONTROL_STATUSES = [
  "awaiting_candidate",
  "building",
  "trusted_build_failed",
  "artifact_accepted",
  "finalizing",
  "published",
  "abandoned",
] as const;

const releaseControlBuildFailureSchema = z
  .object({
    stage: z.enum(RELEASE_CONTROL_FAILURE_STAGES),
    code: z.string(),
    retryable: z.boolean(),
    workflowRunId: z.string(),
  })
  .passthrough();

const releaseControlActionSchema = z.enum(RELEASE_CONTROL_ACTIONS);
const releaseControlStatusSchema = z.enum(RELEASE_CONTROL_STATUSES);

export const appReleaseProgressSchema = z
  .object({
    localAppId: z.string(),
    appId: z.string(),
    packageKey: z.string(),
    version: semanticVersionSchema,
    title: z.string(),
    visibility: z.enum(["public", "restricted"]),
    phase: z.enum([
      "draft_saved",
      "intent_created",
      "source_snapshot_uploaded",
      "remote_blocked",
      "remote_conflict",
      "remote_pending",
      "remote_closed",
      "registry_ready",
      "local_preserved",
      "local_finalized",
    ]),
    remoteIntentId: z.string().optional(),
    remoteStatus: z.union([releaseControlStatusSchema, z.literal("publish_base_stale")]).optional(),
    buildFailure: releaseControlBuildFailureSchema.optional(),
    allowedActions: z.array(releaseControlActionSchema),
    blockedRelease: z
      .object({
        id: z.string(),
        status: releaseControlStatusSchema,
        packageKey: z.string(),
        version: semanticVersionSchema,
        sourceSha256: z.string(),
        createdAt: z.string(),
        allowedActions: z.array(releaseControlActionSchema),
        requestId: z.string().optional(),
        matchesCurrentSource: z.boolean(),
        matchesCurrentRequest: z.boolean(),
        buildFailure: releaseControlBuildFailureSchema.optional(),
      })
      .passthrough()
      .optional(),
    requestId: z.string().optional(),
    applyToCurrentApp: z.boolean(),
    state: z.enum(["publishing", "blocked", "needs-retry", "registry-ready", "closed", "published"]),
    retryable: z.boolean(),
    updatedAt: z.string(),
  })
  .passthrough();

export type AppReleaseCheck = z.output<typeof appReleaseCheckSchema>;
export type AppReleaseCheckSeverity = AppReleaseCheck["severity"];
export type AppReleaseCheckStatus = AppReleaseCheck["status"];
export type AppReleaseEmployeeDefaults = z.output<typeof appReleaseEmployeeSchema>;
export type MountedAppReleaseDraft = z.output<typeof mountedAppReleaseSchema>;
export type AppReleaseProgress = z.output<typeof appReleaseProgressSchema>;
export type AppReleaseProgressPhase = AppReleaseProgress["phase"];
export type AppReleaseBuildFailure = NonNullable<AppReleaseProgress["buildFailure"]>;
export type AppReleaseAction = AppReleaseProgress["allowedActions"][number];
export type ReleaseControlBuildFailure = z.output<typeof releaseControlBuildFailureSchema>;
export type ReleaseControlAction = (typeof RELEASE_CONTROL_ACTIONS)[number];
export type ReleaseControlStatus = (typeof RELEASE_CONTROL_STATUSES)[number];

export function appReleaseNeedsAutomaticRecovery(progress: AppReleaseProgress | undefined): boolean {
  if (!progress?.retryable || (progress.state !== "publishing" && progress.state !== "registry-ready")) return false;
  if (progress.state === "registry-ready") return true;
  return (
    progress.remoteStatus === "awaiting_candidate" ||
    progress.remoteStatus === "artifact_accepted" ||
    progress.remoteStatus === "finalizing"
  );
}

export function appReleaseAutomaticRecoveryBudget(
  progress: AppReleaseProgress | undefined,
): Readonly<{ key: string; limit: number }> {
  const remoteStatus = progress?.remoteStatus;
  return {
    key: progress?.remoteIntentId && remoteStatus ? `${progress.remoteIntentId}:${remoteStatus}:${progress.phase}` : "",
    limit: remoteStatus === "artifact_accepted" ? 2 : 1,
  };
}

const prepareAppReleaseResponseSchema = z.object({ ok: z.literal(true), release: mountedAppReleaseSchema });
const appReleaseProgressResponseSchema = z.object({ ok: z.literal(true), progress: appReleaseProgressSchema });
const appReleaseErrorSchema = z
  .object({
    ok: z.literal(false).optional(),
    error: z.string(),
    requestId: z.string().optional(),
    candidateStage: z.string().optional(),
    progress: appReleaseProgressSchema.optional(),
    detail: z.unknown().optional(),
    traceId: z.string().optional(),
  })
  .passthrough();

export const APP_RELEASE_ERROR_STATUSES = [
  400, 401, 403, 404, 408, 409, 413, 422, 425, 429, 500, 502, 503, 504,
] as const;

function appReleaseErrors(description: string) {
  return APP_RELEASE_ERROR_STATUSES.map((status) => ({
    status,
    body: appReleaseErrorSchema,
    description,
    schemaId: "AppReleaseError",
  }));
}

function appReleaseParams() {
  return z.object({ appId: appIdentifierSchema });
}

function progressSuccess(status = 200) {
  return {
    status,
    body: appReleaseProgressResponseSchema,
    schemaId: "AppReleaseProgressResponse",
  } as const;
}

export const prepareAppReleaseOperation = defineHostOperation({
  id: "app.release.prepare",
  summary: "Prepare an App release",
  description: "Inspect a mounted App and return the editable release baseline and readiness checks.",
  method: "GET",
  path: "/apps/{appId}/publish/prepare",
  risk: "read",
  params: appReleaseParams(),
  success: {
    status: 200,
    body: prepareAppReleaseResponseSchema,
    schemaId: "AppReleasePrepareResponse",
  },
  errors: appReleaseErrors("The App release baseline could not be prepared."),
});

export const publishAppReleaseOperation = defineHostOperation({
  id: "app.release.publish",
  summary: "Publish an App release",
  description: "Save, validate, build, and start publishing a formal version of a mounted App.",
  method: "POST",
  path: "/apps/{appId}/publish",
  risk: "high-risk-write",
  params: appReleaseParams(),
  body: z.object({
    version: semanticVersionSchema,
    releaseNotes: z.string().trim().max(800).optional().describe("Release notes; omitted notes remain empty."),
    visibility: z.enum(["public", "restricted"]).optional().describe("Store visibility; defaults to the App baseline."),
    app: appReleaseMetadataSchema.optional().describe("App metadata override; defaults to the mounted App."),
    employees: z
      .array(appReleaseEmployeeSchema)
      .optional()
      .describe("Complete Employee defaults override; defaults to the mounted App Employees."),
    applyToCurrentApp: z
      .boolean()
      .default(true)
      .describe(
        "Activate the exact published artifact locally after publishing. Defaults to true; pass false to keep the current local App untouched.",
      ),
  }),
  success: progressSuccess(),
  additionalSuccesses: [progressSuccess(202)],
  errors: appReleaseErrors("The App release could not be published."),
});

export const getAppReleaseStatusOperation = defineHostOperation({
  id: "app.release.status",
  summary: "Refresh App release status",
  description: "Refresh the remote state of the current App release intent and return its progress.",
  method: "GET",
  path: "/apps/{appId}/publish/status",
  risk: "read",
  params: appReleaseParams(),
  success: progressSuccess(),
  errors: appReleaseErrors("The App release status could not be refreshed."),
});

export const getAppReleaseProgressOperation = defineHostOperation({
  id: "app.release.progress",
  summary: "Get local App release progress",
  description:
    "Read the locally persisted progress for the current App release intent without contacting Release Control.",
  method: "GET",
  path: "/apps/{appId}/publish",
  risk: "read",
  params: appReleaseParams(),
  success: progressSuccess(),
  errors: appReleaseErrors("The local App release progress could not be read."),
});

export const reconcileAppReleaseOperation = defineHostOperation({
  id: "app.release.reconcile",
  summary: "Reconcile an App release",
  description: "Resume the current App release intent and optionally retry a failed trusted build.",
  method: "POST",
  path: "/apps/{appId}/publish/reconcile",
  risk: "write",
  params: appReleaseParams(),
  body: z.object({
    retryFailedBuild: z.boolean().default(false).describe("Retry the failed trusted build when the intent permits it."),
  }),
  success: progressSuccess(),
  additionalSuccesses: [progressSuccess(202)],
  errors: appReleaseErrors("The App release could not be reconciled."),
});

export const abandonAppReleaseOperation = defineHostOperation({
  id: "app.release.abandon",
  summary: "Abandon an App release",
  description: "End a blocked or failed App release intent when Release Control permits abandonment.",
  method: "POST",
  path: "/apps/{appId}/publish/abandon",
  risk: "high-risk-write",
  params: appReleaseParams(),
  success: progressSuccess(),
  additionalSuccesses: [progressSuccess(202)],
  errors: appReleaseErrors("The App release could not be abandoned."),
});

export const keepLocalAppReleaseOperation = defineHostOperation({
  id: "app.release.keep-local",
  summary: "Keep local App changes",
  description:
    "Finish a published release while preserving local App changes instead of activating the released artifact.",
  method: "POST",
  path: "/apps/{appId}/publish/keep-local",
  risk: "high-risk-write",
  params: appReleaseParams(),
  success: progressSuccess(),
  errors: appReleaseErrors("The App release could not preserve local changes."),
});

export const appReleaseOperations = [
  prepareAppReleaseOperation,
  publishAppReleaseOperation,
  getAppReleaseStatusOperation,
  getAppReleaseProgressOperation,
  reconcileAppReleaseOperation,
  abandonAppReleaseOperation,
  keepLocalAppReleaseOperation,
] as const;

export const appReleaseOperationResource = defineHostOperationResource({
  id: "release",
  title: "App releases",
  description: "Formal App publication and recovery through the local OpenGrove Host.",
  operations: appReleaseOperations,
});

export const appOperationGroup = defineHostOperationGroup({
  id: "app",
  title: "Apps",
  description: "Mounted OpenGrove App operations.",
  resources: [appReleaseOperationResource] as const,
});

export type PrepareAppReleaseOperation = typeof prepareAppReleaseOperation;
export type PublishAppReleaseOperation = typeof publishAppReleaseOperation;
export type GetAppReleaseStatusOperation = typeof getAppReleaseStatusOperation;
export type GetAppReleaseProgressOperation = typeof getAppReleaseProgressOperation;
export type ReconcileAppReleaseOperation = typeof reconcileAppReleaseOperation;
export type AbandonAppReleaseOperation = typeof abandonAppReleaseOperation;
export type KeepLocalAppReleaseOperation = typeof keepLocalAppReleaseOperation;
