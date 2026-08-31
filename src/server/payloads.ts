import type { ArtifactCreateRequest, ArtifactRecord, MemoryRecord, WorkingStateRecord } from "../core.js";
import { normalizeComputerSnapshot } from "../environment/computer-adapter.js";
import type { BrowserPageAttachmentSnapshot, BrowserPageSnapshot } from "../environment/browser-adapter.js";
import type { ComputerStateSnapshot } from "../environment/computer-adapter.js";
import {
  BRIDGE_KERNEL_IDS,
  DEFAULT_BRIDGE_MODEL_ID,
  type BridgeAskPayload,
  type BridgeKernelId,
  type BridgeModelId,
} from "./bridge-types.js";
import {
  booleanValue,
  jsonObjectValue,
  numberValue,
  record,
  sourceRefArray,
  stringArray,
  stringValue,
} from "./http-utils.js";

export function normalizeAskPayload(input: unknown): BridgeAskPayload {
  const object = record(input);
  const snapshot = record(object.snapshot);
  const normalizedSnapshot = {
    title: stringValue(snapshot.title),
    url: stringValue(snapshot.url),
    selection: stringValue(snapshot.selection),
    visibleText: stringValue(snapshot.visibleText),
    locator: stringValue(snapshot.locator),
    attachments: normalizeSnapshotAttachments(snapshot.attachments),
  };
  const normalizedComputerSnapshot = normalizeComputerSnapshot(record(object.computerSnapshot));

  return {
    question: stringValue(object.question) || "Please help me understand this passage.",
    model: normalizeBridgeModelId(object.model),
    kernel: normalizeBridgeKernelId(object.kernel),
    providerId: stringValue(object.providerId).trim() || undefined,
    effort: normalizeReasoningEffort(object.effort),
    responseSpeed: normalizeResponseSpeed(object.responseSpeed),
    budgetLimitUsd: normalizeBudgetLimitUsd(object.budgetLimitUsd),
    accessMode: normalizeRuntimeAccessMode(object.accessMode),
    planMode: booleanValue(object.planMode),
    goalMode: booleanValue(object.goalMode),
    threadId: normalizeThreadId(object.threadId, normalizedSnapshot),
    appId: stringValue(object.appId).trim() || undefined,
    allowMemory: booleanValue(object.allowMemory),
    saveCandidateNote: booleanValue(object.saveCandidateNote),
    requestedSkill: normalizeRequestedSkill(object.requestedSkill),
    snapshot: normalizedSnapshot,
    computerSnapshot: normalizedComputerSnapshot,
  };
}

function normalizeBudgetLimitUsd(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number === undefined || number <= 0) return undefined;
  return Math.round(Math.min(number, 100) * 100) / 100;
}

function normalizeBridgeKernelId(input: unknown): BridgeKernelId | undefined {
  const value = stringValue(input);
  return BRIDGE_KERNEL_IDS.includes(value as BridgeKernelId) ? (value as BridgeKernelId) : undefined;
}

function normalizeRequestedSkill(input: unknown): BridgeAskPayload["requestedSkill"] {
  const object = record(input);
  const name = stringValue(object.name).trim();
  if (!name) {
    return undefined;
  }
  const args = stringValue(object.args).trim();
  return {
    name,
    args: args || undefined,
  };
}

function normalizeResponseSpeed(input: unknown): "standard" | "fast" | undefined {
  return input === "standard" || input === "fast" ? input : undefined;
}

function normalizeRuntimeAccessMode(input: unknown): "default" | "auto-review" | "full-access" | undefined {
  return input === "default" || input === "auto-review" || input === "full-access" ? input : undefined;
}

function normalizeReasoningEffort(input: unknown): string | undefined {
  if (
    input === "low" ||
    input === "medium" ||
    input === "high" ||
    input === "xhigh" ||
    input === "max" ||
    input === "minimal" ||
    input === "off"
  ) {
    return input;
  }
  return undefined;
}

export function normalizeMemoryPatchPayload(
  input: unknown,
): Partial<Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">> {
  const object = record(input);
  const patch: Partial<Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">> = {};

  if (typeof object.scope === "string" && isMemoryScope(object.scope)) {
    patch.scope = object.scope;
  }
  if (typeof object.kind === "string") {
    patch.kind = object.kind;
  }
  if (typeof object.text === "string") {
    patch.text = object.text;
  }
  if (object.confidence === "asserted" || object.confidence === "observed" || object.confidence === "inferred") {
    patch.confidence = object.confidence;
  }
  if (Array.isArray(object.tags)) {
    patch.tags = object.tags.filter((value): value is string => typeof value === "string");
  }
  if (object.expiresAt === null) {
    patch.expiresAt = undefined;
  } else if (typeof object.expiresAt === "string") {
    patch.expiresAt = object.expiresAt;
  }

  return patch;
}

export function normalizeArtifactCreatePayload(input: unknown): ArtifactCreateRequest {
  const object = record(input);
  return {
    id: stringValue(object.id) || undefined,
    type: stringValue(object.type) || "note",
    title: stringValue(object.title) || undefined,
    status: stringValue(object.status) || undefined,
    version: typeof object.version === "number" ? object.version : undefined,
    tags: stringArray(object.tags),
    data: jsonObjectValue(object.data),
    assets: artifactAssetArray(object.assets),
    preview: artifactPreviewValue(object.preview),
    sourceRefs: sourceRefArray(object.sourceRefs),
    parentId: stringValue(object.parentId) || undefined,
    variantOf: stringValue(object.variantOf) || undefined,
    derivedFrom: stringArray(object.derivedFrom),
    lineage: stringArray(object.lineage),
    provenance: jsonObjectValue(object.provenance),
  };
}

export function normalizeArtifactPatchPayload(
  input: unknown,
): Partial<Omit<ArtifactRecord, "id" | "createdAt" | "updatedAt">> {
  const object = record(input);
  const patch: Partial<Omit<ArtifactRecord, "id" | "createdAt" | "updatedAt">> = {};

  if (typeof object.type === "string") patch.type = object.type;
  if ("title" in object) patch.title = stringValue(object.title) || undefined;
  if ("status" in object) patch.status = stringValue(object.status) || undefined;
  if (typeof object.version === "number") patch.version = object.version;
  if (Array.isArray(object.tags)) patch.tags = stringArray(object.tags);
  if ("data" in object) patch.data = jsonObjectValue(object.data);
  if ("sourceRefs" in object) patch.sourceRefs = sourceRefArray(object.sourceRefs);
  if ("parentId" in object) patch.parentId = stringValue(object.parentId) || undefined;
  if ("variantOf" in object) patch.variantOf = stringValue(object.variantOf) || undefined;
  if (Array.isArray(object.derivedFrom)) patch.derivedFrom = stringArray(object.derivedFrom);
  if (Array.isArray(object.lineage)) patch.lineage = stringArray(object.lineage);
  if ("provenance" in object) patch.provenance = jsonObjectValue(object.provenance);

  return patch;
}

export function normalizeArtifactAnnotationPayload(input: unknown) {
  const object = record(input);
  const text = stringValue(object.text);
  if (!text) {
    throw new Error("annotation_text_required");
  }
  return {
    text,
    title: stringValue(object.title) || undefined,
    tags: stringArray(object.tags),
  };
}

export function normalizeComputerStatePatchPayload(input: unknown): {
  snapshot: ComputerStateSnapshot;
  recordArtifact: boolean;
} {
  const object = record(input);
  return {
    snapshot: normalizeComputerSnapshot(record(object.snapshot ?? input)),
    recordArtifact: booleanValue(object.recordArtifact),
  };
}

export function normalizeWorkingStatePatchPayload(input: unknown): Partial<Omit<WorkingStateRecord, "updatedAt">> {
  const object = record(input);
  const patch: Partial<Omit<WorkingStateRecord, "updatedAt">> = {};

  if ("sessionId" in object) patch.sessionId = stringValue(object.sessionId) || undefined;
  if ("taskSummary" in object) patch.taskSummary = stringValue(object.taskSummary) || undefined;
  if ("activeGoal" in object) patch.activeGoal = stringValue(object.activeGoal) || undefined;
  if ("selectedModel" in object) patch.selectedModel = stringValue(object.selectedModel) || undefined;
  if (Array.isArray(object.pinnedArtifactIds)) patch.pinnedArtifactIds = stringArray(object.pinnedArtifactIds);
  if (Array.isArray(object.workingArtifactIds)) patch.workingArtifactIds = stringArray(object.workingArtifactIds);
  if (Array.isArray(object.pendingApprovalIds)) patch.pendingApprovalIds = stringArray(object.pendingApprovalIds);
  if (Array.isArray(object.pendingQuestionIds)) patch.pendingQuestionIds = stringArray(object.pendingQuestionIds);
  if (Array.isArray(object.activeToolCallIds)) patch.activeToolCallIds = stringArray(object.activeToolCallIds);

  return patch;
}

export function normalizeRoutineDraftPayload(input: unknown) {
  const object = record(input);
  const capabilityIds = Array.isArray(object.capabilityIds)
    ? object.capabilityIds.filter((value): value is string => typeof value === "string")
    : undefined;

  return {
    title: stringValue(object.title) || undefined,
    description: stringValue(object.description) || undefined,
    capabilityIds,
    runId: stringValue(object.runId) || undefined,
    maxSteps: typeof object.maxSteps === "number" ? object.maxSteps : undefined,
  };
}

export function isMemoryScope(value: string): value is "user" | "workspace" | "page" | "session" {
  return value === "user" || value === "workspace" || value === "page" || value === "session";
}

export function isActivitySpace(value: string): value is "browser" | "chat" | "local" | "api" | "computer" {
  return value === "browser" || value === "chat" || value === "local" || value === "api" || value === "computer";
}

export function isSessionStatus(value: string): value is "active" | "idle" | "archived" {
  return value === "active" || value === "idle" || value === "archived";
}

export function isRunStatus(
  value: string,
): value is "running" | "waiting_for_approval" | "waiting_for_user" | "succeeded" | "failed" {
  return (
    value === "running" ||
    value === "waiting_for_approval" ||
    value === "waiting_for_user" ||
    value === "succeeded" ||
    value === "failed"
  );
}

export function isExecutionKind(
  value: string,
): value is "loop" | "model" | "tool_call" | "approval" | "question" | "planning" | "artifact" | "memory" | "error" {
  return (
    value === "loop" ||
    value === "model" ||
    value === "tool_call" ||
    value === "approval" ||
    value === "question" ||
    value === "planning" ||
    value === "artifact" ||
    value === "memory" ||
    value === "error"
  );
}

function normalizeSnapshotAttachments(value: unknown): BrowserPageSnapshot["attachments"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const attachments: BrowserPageAttachmentSnapshot[] = [];
  for (const item of value) {
    const object = record(item);
    const name = stringValue(object.name).slice(0, 240);
    if (!name) {
      continue;
    }
    const kind: BrowserPageAttachmentSnapshot["kind"] =
      object.kind === "image" || object.kind === "text" || object.kind === "file" ? object.kind : "file";
    const mimeType = stringValue(object.mimeType).slice(0, 160);
    const size =
      typeof object.size === "number" && Number.isFinite(object.size) ? Math.max(0, Math.trunc(object.size)) : 0;
    attachments.push({
      id: stringValue(object.id).slice(0, 120) || undefined,
      name,
      kind,
      mimeType,
      size,
      text: stringValue(object.text).slice(0, 120_000) || undefined,
      dataUrl: normalizeAttachmentDataUrl(object.dataUrl, kind),
    });
    if (attachments.length >= 8) {
      break;
    }
  }
  return attachments;
}

function normalizeAttachmentDataUrl(value: unknown, kind: BrowserPageAttachmentSnapshot["kind"]): string | undefined {
  const text = stringValue(value);
  if (!text || text.length > 12_000_000 || !/^data:[a-z0-9.+/-]+;base64,/i.test(text)) {
    return undefined;
  }
  if (kind === "image" && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
    return undefined;
  }
  return text;
}

function normalizeThreadId(value: unknown, snapshot: BrowserPageSnapshot): string {
  const explicit = typeof value === "string" ? value.trim() : "";
  if (explicit) {
    return explicit.slice(0, 240);
  }

  const source = snapshot.url || snapshot.title || "local";
  return `thread:${source}`.slice(0, 240);
}

function normalizeBridgeModelId(value: unknown): BridgeModelId {
  const model = stringValue(value).trim();
  return model || DEFAULT_BRIDGE_MODEL_ID;
}

function artifactAssetArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => {
          const object = record(item);
          const metadata = jsonObjectValue(object.metadata);
          const asset = {
            kind: artifactAssetKind(object.kind),
            uri: stringValue(object.uri) || undefined,
            path: stringValue(object.path) || undefined,
            title: stringValue(object.title) || undefined,
            mimeType: stringValue(object.mimeType) || undefined,
            metadata: Object.keys(metadata).length ? metadata : undefined,
          };
          return asset.uri || asset.path || asset.title || asset.mimeType || asset.metadata ? asset : undefined;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;
}

function artifactAssetKind(value: unknown): "image" | "video" | "file" | "url" | "text" {
  if (value === "image" || value === "video" || value === "file" || value === "url" || value === "text") {
    return value;
  }
  return "file";
}

function artifactPreviewValue(value: unknown) {
  const object = record(value);
  const preview = {
    title: stringValue(object.title) || undefined,
    text: stringValue(object.text) || undefined,
    imageUri: stringValue(object.imageUri) || undefined,
    status: stringValue(object.status) || undefined,
  };
  return Object.values(preview).some(Boolean) ? preview : undefined;
}
