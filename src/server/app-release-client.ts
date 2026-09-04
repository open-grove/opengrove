import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { APP_RELEASE_ERROR_STATUSES } from "#protocol";
import type { AppReleaseJournalRecord } from "./app-release-journal.js";
import {
  isReleaseControlActions,
  isReleaseControlBuildFailure,
  isReleaseControlStatus,
  type ReleaseControlAction,
  type ReleaseControlBuildFailure,
  type ReleaseControlStatus,
} from "./app-release-status.js";
import { publicAppReleasePublishBase } from "./app-release-publish-base.js";
import { clientReleaseRequestHeader } from "./client-release.js";
import { record } from "./http-utils.js";

const MAX_RELEASE_RESPONSE_BYTES = 4 * 1024 * 1024;
const DECLARED_APP_RELEASE_ERROR_STATUSES = new Set<number>(APP_RELEASE_ERROR_STATUSES);
// Candidate creation uploads as many as 5,000 source blobs before the service
// can return the durable intent. Keep this above the production ingress budget
// so the client, proxy, and Release Control share one long-transaction window.
// Stay outside Release Control's 10-minute server budget and the 11-minute
// ingress budget so the inner layer can return the actionable failure first.
const RELEASE_REQUEST_TIMEOUT_MS = 12 * 60_000;
const RELEASE_CONTROL_ERROR_CODES = new Set([
  "app_release_admin_required",
  "app_release_request_invalid",
  "app_release_publish_base_stale",
  "app_release_identity_conflict",
  "app_release_version_conflict",
  "app_release_in_progress",
  "app_release_source_snapshot_invalid",
  "app_release_source_snapshot_mismatch",
  "app_release_secret_blocked",
  "app_release_not_found",
  "app_release_state_conflict",
  "app_release_trusted_artifact_invalid",
  "release_control_unauthorized",
  "release_control_identity_unavailable",
  "release_control_dependency_unavailable",
  "release_control_not_ready",
]);
const RELEASE_CONTROL_CANDIDATE_STAGES = new Set([
  "source_load",
  "repository_prepare",
  "repository_auth",
  "repository_lookup",
  "repository_create",
  "repository_main_lookup",
  "repository_bootstrap",
  "candidate_publish",
  "candidate_auth",
  "candidate_main_lookup",
  "candidate_workspace",
  "candidate_git_init",
  "candidate_main_fetch",
  "candidate_source_materialize",
  "candidate_object_write",
  "candidate_commit_create",
  "candidate_ref_push",
  "source_close",
  "candidate_record",
  "build_auth",
  "build_dispatch",
  "dispatch_record",
]);

export type {
  ReleaseControlAction,
  ReleaseControlBuildFailure,
  ReleaseControlStatus,
} from "./app-release-status.js";

export interface ReleaseControlIntent {
  /** Host-only correlation metadata; never persisted or exposed to the Web UI. */
  requestId?: string;
  id: string;
  status: ReleaseControlStatus;
  packageKey: string;
  packageId: string;
  appId: string;
  title: string;
  repositoryName: string;
  version: string;
  releaseNotes: string;
  visibility: "public" | "restricted";
  minHostReleaseNumber: number;
  expectedMainSha: string | null;
  publishBase: {
    releaseCommitSha: string;
    version: string;
    archiveSha256: string;
  };
  sourceSha256: string;
  sourceSize: number;
  sourceArchiveName: string;
  githubRepositoryId?: number;
  candidateRepository?: string;
  candidateSha?: string;
  candidateRef?: string;
  buildGeneration?: number;
  buildDispatchedAt?: string;
  buildFailure?: ReleaseControlBuildFailure;
  allowedActions: ReleaseControlAction[];
  gatedArchiveName?: string;
  gatedArchiveSize?: number;
  gatedArchiveSha256?: string;
  releaseTag?: string;
  githubReleaseId?: number;
  githubReleaseUrl?: string;
  publishedAt?: string;
  publishedByUserId: number;
  createdAt: string;
}

export interface ReleaseControlStartMetadata {
  idempotencyKey: string;
  packageKey: string;
  packageId: string;
  appId: string;
  title: string;
  repositoryName: string;
  version: string;
  releaseNotes: string;
  visibility: "public" | "restricted";
  minHostReleaseNumber: number;
  expectedMainSha: string | null;
  publishBase: ReleaseControlIntent["publishBase"];
  sourceSha256: string;
  sourceSize: number;
  sourceArchiveName: string;
}

export interface ReleaseControlConflict {
  id: string;
  status: ReleaseControlStatus;
  packageKey: string;
  version: string;
  sourceSha256: string;
  createdAt: string;
  allowedActions: ReleaseControlAction[];
  buildFailure?: ReleaseControlBuildFailure;
}

export class ReleaseControlClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
    readonly candidateStage?: string,
    readonly releaseConflict?: ReleaseControlConflict,
    readonly rejectedIntent?: ReleaseControlIntent,
  ) {
    super(message);
  }
}

export class ReleaseControlClient {
  private readonly baseUrl: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      accessToken: string;
      fetch?: typeof fetch;
    },
  ) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.baseUrl) || !safeHeaderValue(options.accessToken)) {
      throw new Error("app_release_client_config_invalid");
    }
  }

  async start(record: AppReleaseJournalRecord, sourceSnapshot: Buffer): Promise<ReleaseControlIntent> {
    if (sourceSnapshot.byteLength !== record.sourceSnapshot.size || sourceSnapshot.byteLength <= 0) {
      throw new Error("app_release_client_input_invalid");
    }
    const metadata = releaseControlStartMetadata(record);
    const body = new FormData();
    body.append("metadata", JSON.stringify(metadata));
    body.append(
      "source",
      new Blob([new Uint8Array(sourceSnapshot)], { type: "application/gzip" }),
      metadata.sourceArchiveName,
    );
    return this.requestIntent("/v1/app-releases", {
      method: "POST",
      body,
    });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<ReleaseControlIntent> {
    if (!/^og-app-release-[a-f0-9]{64}$/.test(idempotencyKey)) {
      throw new Error("app_release_client_input_invalid");
    }
    return this.requestIntent(`/v1/app-releases/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`, {
      method: "GET",
    });
  }

  findById(intentId: string): Promise<ReleaseControlIntent> {
    if (!safeIntentId(intentId)) throw new Error("app_release_client_input_invalid");
    return this.requestIntent(`/v1/app-releases/${encodeURIComponent(intentId)}`, { method: "GET" });
  }

  retryBuild(intentId: string): Promise<ReleaseControlIntent> {
    return this.intentAction(intentId, "build-retries");
  }

  retryCandidate(intentId: string): Promise<ReleaseControlIntent> {
    return this.intentAction(intentId, "candidate-retries");
  }

  abandon(intentId: string): Promise<ReleaseControlIntent> {
    return this.intentAction(intentId, "abandon");
  }

  finalize(intentId: string): Promise<ReleaseControlIntent> {
    return this.intentAction(intentId, "finalize");
  }

  private intentAction(
    intentId: string,
    action: "candidate-retries" | "build-retries" | "finalize" | "abandon",
  ): Promise<ReleaseControlIntent> {
    if (!safeIntentId(intentId)) throw new Error("app_release_client_input_invalid");
    return this.requestIntent(`/v1/app-releases/${encodeURIComponent(intentId)}/${action}`, { method: "POST" });
  }

  private async requestIntent(
    path: string,
    init: { method: "GET" | "POST"; body?: FormData },
  ): Promise<ReleaseControlIntent> {
    const request = this.options.fetch ?? fetch;
    const requestId = randomBytes(16).toString("hex");
    let response: Response;
    try {
      response = await request(`${this.baseUrl}${path}`, {
        method: init.method,
        redirect: "error",
        signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          accept: "application/json",
          "x-request-id": requestId,
          ...clientReleaseRequestHeader(),
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new ReleaseControlClientError(
        503,
        error instanceof Error && error.name === "TimeoutError"
          ? "app_release_request_timeout"
          : "app_release_request_unavailable",
        requestId,
      );
    }
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^application\/json(?:;|$)/i.test(contentType)) {
        throw new ReleaseControlClientError(502, "app_release_response_content_type_invalid");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_RESPONSE_BYTES) {
        throw new ReleaseControlClientError(502, "app_release_response_too_large");
      }
      const bytes = await readBoundedResponse(response);
      let payload: unknown;
      try {
        payload = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ReleaseControlClientError(502, "app_release_response_invalid");
      }
      if (!response.ok) {
        throw parseReleaseControlError(response.status, payload, response.headers.get("x-opengrove-candidate-stage"));
      }
      return { ...parseReleaseControlIntent(payload), requestId };
    } catch (error) {
      if (error instanceof ReleaseControlClientError && !error.requestId) {
        throw new ReleaseControlClientError(
          error.status,
          error.message,
          requestId,
          error.candidateStage,
          error.releaseConflict,
          error.rejectedIntent,
        );
      }
      if (error instanceof ReleaseControlClientError) throw error;
      throw new ReleaseControlClientError(
        503,
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "app_release_request_timeout"
          : "app_release_request_unavailable",
        requestId,
      );
    }
  }
}

export function releaseControlStartMetadata(record: AppReleaseJournalRecord): ReleaseControlStartMetadata {
  if (!record.packageId) throw new Error("app_release_client_input_invalid");
  const publishBase = publicAppReleasePublishBase(record.publishBase);
  return {
    idempotencyKey: record.idempotencyKey,
    packageKey: record.packageKey,
    packageId: record.packageId,
    appId: record.appId,
    title: record.release.app.title,
    repositoryName: record.appId,
    version: record.release.version,
    releaseNotes: record.release.releaseNotes,
    visibility: record.release.visibility,
    minHostReleaseNumber: record.release.minHostReleaseNumber ?? 0,
    expectedMainSha: record.expectedMainSha,
    publishBase: {
      releaseCommitSha: publishBase.releaseCommitSha ?? "",
      version: publishBase.version ?? "",
      archiveSha256: publishBase.archiveSha256 ?? "",
    },
    sourceSha256: record.sourceSnapshot.sha256,
    sourceSize: record.sourceSnapshot.size,
    sourceArchiveName: `${record.appId}-${record.release.version}-source.tgz`,
  };
}

export function assertReleaseControlIntentMatchesJournal(
  intent: ReleaseControlIntent,
  record: AppReleaseJournalRecord,
): void {
  const expected = releaseControlStartMetadata(record);
  const actual: ReleaseControlStartMetadata = {
    idempotencyKey: record.idempotencyKey,
    packageKey: intent.packageKey,
    packageId: intent.packageId,
    appId: intent.appId,
    title: intent.title,
    repositoryName: intent.repositoryName,
    version: intent.version,
    releaseNotes: intent.releaseNotes,
    visibility: intent.visibility,
    minHostReleaseNumber: intent.minHostReleaseNumber,
    expectedMainSha: intent.expectedMainSha,
    publishBase: intent.publishBase,
    sourceSha256: intent.sourceSha256,
    sourceSize: intent.sourceSize,
    sourceArchiveName: intent.sourceArchiveName,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new ReleaseControlClientError(502, "app_release_response_identity_mismatch", intent.requestId);
  }
}

function parseReleaseControlIntent(value: unknown): ReleaseControlIntent {
  const envelope = record(value);
  const intent = record(envelope.release);
  const status = stringValue(intent.status);
  const publishBase = record(intent.publishBase);
  if (
    Object.keys(envelope).length !== 1 ||
    !safeIntentId(stringValue(intent.id)) ||
    !isReleaseControlStatus(status) ||
    !safeIdentifier(stringValue(intent.packageKey)) ||
    !safeIdentifier(stringValue(intent.packageId)) ||
    !safeIdentifier(stringValue(intent.appId)) ||
    !stringValue(intent.title) ||
    !safeIdentifier(stringValue(intent.repositoryName)) ||
    !/^\d+\.\d+\.\d+$/.test(stringValue(intent.version)) ||
    (intent.visibility !== "public" && intent.visibility !== "restricted") ||
    !Number.isSafeInteger(intent.minHostReleaseNumber) ||
    Number(intent.minHostReleaseNumber) < 0 ||
    !nullableCommitSha(intent.expectedMainSha) ||
    !safePublishBase(publishBase) ||
    !/^[a-f0-9]{64}$/.test(stringValue(intent.sourceSha256)) ||
    !Number.isSafeInteger(intent.sourceSize) ||
    Number(intent.sourceSize) <= 0 ||
    !safeArchiveName(stringValue(intent.sourceArchiveName)) ||
    !Number.isSafeInteger(intent.publishedByUserId) ||
    Number(intent.publishedByUserId) <= 0 ||
    !validDateString(intent.createdAt) ||
    !optionalPositiveInteger(intent.githubRepositoryId) ||
    !optionalCommitSha(intent.candidateSha) ||
    !optionalPositiveInteger(intent.gatedArchiveSize) ||
    !optionalSha256(intent.gatedArchiveSha256) ||
    !optionalDateString(intent.publishedAt) ||
    !isReleaseControlActions(intent.allowedActions) ||
    (intent.buildFailure !== undefined &&
      (status !== "trusted_build_failed" || !isReleaseControlBuildFailure(intent.buildFailure)))
  ) {
    throw new ReleaseControlClientError(502, "app_release_response_invalid");
  }
  return intent as unknown as ReleaseControlIntent;
}

function parseReleaseControlError(
  status: number,
  value: unknown,
  candidateStageHeader: string | null,
): ReleaseControlClientError {
  const envelope = record(value);
  const message = stringValue(envelope.error);
  const releaseConflict =
    message === "app_release_in_progress" && status === 409 && Object.keys(envelope).length === 2
      ? parseReleaseControlConflict(envelope.release)
      : undefined;
  const rejectedIntent =
    message === "app_release_secret_blocked" &&
    status === 422 &&
    candidateStageHeader === "candidate_ref_push" &&
    Object.keys(envelope).length === 2
      ? parseRejectedIntent(envelope.release)
      : undefined;
  const validEnvelope =
    releaseConflict || rejectedIntent
      ? true
      : Object.keys(envelope).length === 1 &&
        message !== "app_release_secret_blocked" &&
        RELEASE_CONTROL_ERROR_CODES.has(message);
  return new ReleaseControlClientError(
    DECLARED_APP_RELEASE_ERROR_STATUSES.has(status) ? status : 502,
    validEnvelope ? message : "app_release_error_response_invalid",
    undefined,
    RELEASE_CONTROL_CANDIDATE_STAGES.has(candidateStageHeader ?? "") ? (candidateStageHeader ?? undefined) : undefined,
    releaseConflict,
    rejectedIntent,
  );
}

function parseRejectedIntent(value: unknown): ReleaseControlIntent | undefined {
  try {
    const intent = parseReleaseControlIntent({ release: value });
    return intent.status === "abandoned" && intent.allowedActions.length === 0 ? intent : undefined;
  } catch (error) {
    if (error instanceof ReleaseControlClientError) return undefined;
    throw error;
  }
}

function parseReleaseControlConflict(value: unknown): ReleaseControlConflict | undefined {
  const conflict = record(value);
  const status = stringValue(conflict.status);
  const actions = conflict.allowedActions;
  if (
    Object.keys(conflict).length !== (conflict.buildFailure === undefined ? 7 : 8) ||
    !safeIntentId(stringValue(conflict.id)) ||
    !isReleaseControlStatus(status) ||
    !safeIdentifier(stringValue(conflict.packageKey)) ||
    !/^\d+\.\d+\.\d+$/.test(stringValue(conflict.version)) ||
    !/^[a-f0-9]{64}$/.test(stringValue(conflict.sourceSha256)) ||
    !validDateString(conflict.createdAt) ||
    !isReleaseControlActions(actions) ||
    (conflict.buildFailure !== undefined &&
      (status !== "trusted_build_failed" || !isReleaseControlBuildFailure(conflict.buildFailure)))
  ) {
    return undefined;
  }
  return conflict as unknown as ReleaseControlConflict;
}

function safePublishBase(value: Record<string, unknown>): boolean {
  return (
    optionalCommitSha(value.releaseCommitSha) && optionalSemver(value.version) && optionalSha256(value.archiveSha256)
  );
}

function safeIntentId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

function safeIdentifier(value: string): boolean {
  return (
    value.length <= 255 &&
    value === value.trim() &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

function safeArchiveName(value: string): boolean {
  return value.length > 4 && value.endsWith(".tgz") && !value.includes("/") && !value.includes("\\");
}

function nullableCommitSha(value: unknown): boolean {
  return value === null || /^[a-f0-9]{40}$/.test(stringValue(value));
}

function optionalCommitSha(value: unknown): boolean {
  return value === undefined || value === "" || /^[a-f0-9]{40}$/.test(stringValue(value));
}

function optionalSha256(value: unknown): boolean {
  return value === undefined || value === "" || /^[a-f0-9]{64}$/.test(stringValue(value));
}

function optionalSemver(value: unknown): boolean {
  return value === undefined || value === "" || /^\d+\.\d+\.\d+$/.test(stringValue(value));
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) > 0);
}

function optionalDateString(value: unknown): boolean {
  return value === undefined || validDateString(value);
}

function validDateString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function safeHeaderValue(value: string): boolean {
  return Boolean(value) && !/[\u0000-\u0020\u007f]/.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) {
    throw new ReleaseControlClientError(502, "app_release_response_body_missing");
  }
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RELEASE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ReleaseControlClientError(502, "app_release_response_too_large");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}
