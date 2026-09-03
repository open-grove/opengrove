import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAppEnv } from "../identity.js";
import { defaultOpenGroveDataDir, LEGACY_JSON_STATE_FILE_NAME } from "./default-data-dir.js";
import { acquireStateFileLock } from "./state-file-lock.js";
import { canonicalizeStatePath } from "./state-identity.js";
import type {
  AgentEvent,
  ApprovalRequest,
  ArtifactRecord,
  ExecutionRecord,
  MemoryRecord,
  QuestionRequest,
  RunRecord,
  Routine,
  SessionRecord,
  WorkingStateRecord,
} from "../core.js";
import type {
  KnowledgeDeliveryRecord,
  KnowledgeDocument,
  KnowledgeEvidenceRecord,
  KnowledgeFeedbackEvent,
  KnowledgeRevision,
} from "../knowledge/types.js";
import type { RoomChannelEvent, RoomChannelSnapshot } from "../rooms/channel-store.js";
import {
  closeInterruptedRoomRunParts,
  interruptRoomRunMessage,
  resetInactiveRoomMember,
} from "../rooms/run-liveness.js";
import { hostMessage } from "../localization/host-messages.js";
import type { SupportedLocale } from "../localization/locale-registry.js";
import { lifecycleFromRunFact } from "#agent-protocol";
import { normalizePersistedRunLifecycle } from "../core/run-lifecycle.compat.js";

export const CURRENT_PERSISTED_AGENT_STATE_VERSION = 9 as const;

export interface PersistedAgentState {
  version: typeof CURRENT_PERSISTED_AGENT_STATE_VERSION;
  savedAt: string;
  knowledge: KnowledgeDocument[];
  knowledgeEvidence: KnowledgeEvidenceRecord[];
  knowledgeRevisions: KnowledgeRevision[];
  knowledgeDeliveries: KnowledgeDeliveryRecord[];
  knowledgeFeedback: KnowledgeFeedbackEvent[];
  memory: MemoryRecord[];
  artifacts: ArtifactRecord[];
  workingState: WorkingStateRecord;
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  events: AgentEvent[];
  routines: Routine[];
  sessions: SessionRecord[];
  runs: RunRecord[];
  executions: ExecutionRecord[];
  rooms: RoomChannelSnapshot;
}

export interface AgentStateStore {
  readonly path: string;
  readonly kind: "json" | "sqlite" | "memory";
  loadInto(app: PersistableAgentStatePorts, options?: PersistedStateLoadOptions): PersistedAgentState | undefined;
  restoreSnapshotInto?(
    app: PersistableAgentStatePorts,
    state: PersistedAgentState,
    options?: PersistedStateLoadOptions,
  ): PersistedAgentState;
  saveFrom(app: PersistableAgentStatePorts): PersistedAgentState;
  saveSnapshot?(state: PersistedAgentState): PersistedAgentState;
  storageStats?(): AgentStorageStats;
  cleanupOrphanedBlobs?(): AgentStorageCleanupResult;
  deleteRoomEvents?(eventSeqs: readonly number[]): number;
  clearRoomEventArchive?(): number;
  clearRuntimeEventArchive?(): number;
  clearMigrationBackups?(): AgentFileCleanupResult;
  readDiagnosticArchive?(scope: AgentDiagnosticArchiveScope): AgentDiagnosticArchive;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface AgentDiagnosticArchiveScope {
  runIds: readonly string[];
  roomId: string;
}

export interface AgentDiagnosticArchive {
  source: "sqlite";
  events: AgentEvent[];
  executions: ExecutionRecord[];
  roomEvents: RoomChannelEvent[];
  missingRecords: Array<{
    collection: "agent_events" | "executions" | "room_events";
    recordKey: string;
    reason: string;
  }>;
}

export interface PersistedStateLoadOptions {
  /** Run producers that are still alive in this process, across every surface. */
  activeRunIds?: ReadonlySet<string>;
  /**
   * Defined only for a same-process rebuild. A running Room message is kept
   * only when its producer is still registered under the same root state.
   */
  activeRoomRunIds?: ReadonlySet<string>;
  /** Same-process rebuilds may retain durable Routine approval continuations. */
  preserveResumablePendingRequests?: boolean;
  language?: SupportedLocale;
}

export interface AgentStorageCategoryStats {
  collection: string;
  records: number;
  payloadBytes: number;
  referencedBlobBytes: number;
}

export interface AgentStorageStats {
  kind: AgentStateStore["kind"];
  databaseBytes: number;
  blobBytes: number;
  orphanBlobBytes: number;
  migrationBackupBytes: number;
  categories: AgentStorageCategoryStats[];
}

export interface AgentStorageCleanupResult {
  removedBlobs: number;
  reclaimedBytes: number;
}

export interface AgentFileCleanupResult {
  removedFiles: number;
  reclaimedBytes: number;
}

export type JsonStateStore = AgentStateStore & { readonly kind: "json" };

export interface PersistableAgentStatePorts {
  knowledge: {
    restore(documents: KnowledgeDocument[]): void;
    restoreLedgers(snapshot: {
      evidence?: KnowledgeEvidenceRecord[];
      revisions?: KnowledgeRevision[];
      deliveries?: KnowledgeDeliveryRecord[];
      feedback?: KnowledgeFeedbackEvent[];
    }): void;
    snapshot(): KnowledgeDocument[];
    listEvidence(): KnowledgeEvidenceRecord[];
    listRevisions(): KnowledgeRevision[];
    listDeliveries(): KnowledgeDeliveryRecord[];
    listFeedback(): KnowledgeFeedbackEvent[];
  };
  memory: {
    restore(records: MemoryRecord[]): void;
    list(): MemoryRecord[];
  };
  artifacts: {
    restore(records: ArtifactRecord[]): void;
    list(): ArtifactRecord[];
  };
  workingState: {
    restore(snapshot: WorkingStateRecord): void;
    get(): WorkingStateRecord;
  };
  approvals: {
    restore(requests: ApprovalRequest[]): void;
    list(): ApprovalRequest[];
  };
  questions: {
    restore(requests: QuestionRequest[]): void;
    list(): QuestionRequest[];
  };
  events: {
    restore(events: AgentEvent[]): void;
    list(): AgentEvent[];
    setRetentionLimit?(limit: number | undefined): void;
  };
  routines: {
    restore(routines: Routine[]): void;
    list(): Routine[];
  };
  sessions: {
    restore(snapshot: { sessions?: SessionRecord[]; runs?: RunRecord[] }): void;
    list(): SessionRecord[];
    listRuns(): RunRecord[];
  };
  executions: {
    restore(records: ExecutionRecord[]): void;
    list(): ExecutionRecord[];
    setRetentionLimit?(limit: number | undefined): void;
  };
  rooms: {
    restore(snapshot: RoomChannelSnapshot | undefined): void;
    snapshot(): RoomChannelSnapshot;
  };
}

export function createJsonStateStore(path = defaultStatePath()): JsonStateStore {
  const resolved = canonicalizeStatePath(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const lock = acquireStateFileLock(resolved);

  return {
    path: resolved,
    kind: "json",
    loadInto(app, loadOptions) {
      if (!existsSync(resolved)) {
        return undefined;
      }

      const state = normalizeState(JSON.parse(readFileSync(resolved, "utf8")), loadOptions);
      restorePersistedAgentState(app, state);
      return state;
    },
    restoreSnapshotInto(app, state, loadOptions) {
      const normalized = normalizeState(state, loadOptions);
      restorePersistedAgentState(app, normalized);
      return normalized;
    },
    saveFrom(app) {
      const state = snapshotPersistedAgentState(app);

      mkdirSync(dirname(resolved), { recursive: true });
      const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      // Serialize without indentation: the state file is machine-owned, and the
      // pretty-print indent inflates both the on-disk size and the transient
      // string allocation (~30-40%) that the bridge holds in memory while saving.
      writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
      renameSync(tempPath, resolved);
      return state;
    },
    async close() {
      lock.release();
    },
  };
}

// Maximum number of high-frequency "volatile" events/executions to persist.
// Structural events (approvals, questions, errors, turn/run/skill lifecycle) are
// always kept in full — they drive restore-time reconstruction. Only the noisy
// streaming mirrors (assistant token deltas, tool progress, per-token model/status chatter) are
// tail-capped, since their only durable value is the final assembled message,
// which already lives in the room messages / assistant.final events.
const MAX_VOLATILE_EVENTS = 4_000;

const VOLATILE_EVENT_TYPES = new Set<string>([
  "assistant.delta",
  "assistant.status",
  "tool.progress",
  "model.requested",
  "model.response",
  "runtime.diagnostic",
  "context.assembled",
]);

function compactEventLog<T>(events: T[], getType: (event: T) => unknown, maxVolatile: number): T[] {
  const isVolatile = (event: T) => {
    const type = getType(event);
    return typeof type === "string" && VOLATILE_EVENT_TYPES.has(type);
  };
  const volatileCount = events.reduce((count, event) => (isVolatile(event) ? count + 1 : count), 0);
  if (volatileCount <= maxVolatile) return events;
  // Keep every structural event, plus the most recent `maxVolatile` volatile ones,
  // preserving the original chronological order.
  let allowedVolatile = volatileCount - maxVolatile; // number of oldest volatile events to drop
  return events.filter((event) => {
    if (!isVolatile(event)) return true;
    if (allowedVolatile > 0) {
      allowedVolatile -= 1;
      return false;
    }
    return true;
  });
}

export function snapshotPersistedAgentState(
  app: PersistableAgentStatePorts,
  options: { compactVolatile?: boolean } = {},
): PersistedAgentState {
  const compactVolatile = options.compactVolatile ?? true;
  return {
    version: CURRENT_PERSISTED_AGENT_STATE_VERSION,
    savedAt: new Date().toISOString(),
    knowledge: app.knowledge.snapshot(),
    knowledgeEvidence: app.knowledge.listEvidence(),
    knowledgeRevisions: app.knowledge.listRevisions(),
    knowledgeDeliveries: app.knowledge.listDeliveries(),
    knowledgeFeedback: app.knowledge.listFeedback(),
    memory: app.memory.list(),
    artifacts: app.artifacts.list(),
    workingState: app.workingState.get(),
    approvals: app.approvals.list(),
    questions: app.questions.list(),
    events: compactVolatile
      ? compactEventLog(app.events.list(), (event) => event.type, MAX_VOLATILE_EVENTS)
      : app.events.list(),
    routines: app.routines.list(),
    sessions: app.sessions.list(),
    runs: app.sessions.listRuns(),
    executions: compactVolatile
      ? compactEventLog(app.executions.list(), (execution) => execution.eventType, MAX_VOLATILE_EVENTS)
      : app.executions.list(),
    rooms: app.rooms.snapshot(),
  };
}

export function restorePersistedAgentState(app: PersistableAgentStatePorts, state: PersistedAgentState): void {
  app.knowledge.restore(state.knowledge);
  app.memory.restore(state.memory);
  app.artifacts.restore(state.artifacts);
  app.knowledge.restoreLedgers({
    evidence: state.knowledgeEvidence,
    revisions: state.knowledgeRevisions,
    deliveries: state.knowledgeDeliveries,
    feedback: state.knowledgeFeedback,
  });
  app.workingState.restore(state.workingState);
  app.events.restore(state.events);
  app.approvals.restore(mergeApprovalRequestsFromEvents(state.approvals, state.events));
  app.questions.restore(mergeQuestionRequestsFromEvents(state.questions, state.events));
  app.routines.restore(state.routines);
  app.sessions.restore({
    sessions: state.sessions,
    runs: state.runs,
  });
  app.executions.restore(state.executions);
  app.rooms.restore(state.rooms);
}

function mergeApprovalRequestsFromEvents(approvals: ApprovalRequest[], events: AgentEvent[]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const approval of approvals) {
    upsertLatestRequest(byId, approval);
  }
  for (const event of events) {
    if (event.type === "approval.requested" || event.type === "approval.resolved") {
      upsertLatestRequest(byId, event.request);
    }
  }
  return [...byId.values()];
}

function mergeQuestionRequestsFromEvents(questions: QuestionRequest[], events: AgentEvent[]): QuestionRequest[] {
  const byId = new Map<string, QuestionRequest>();
  for (const question of questions) {
    upsertLatestRequest(byId, question);
  }
  for (const event of events) {
    if (event.type === "question.requested" || event.type === "question.answered") {
      upsertLatestRequest(byId, event.question);
    }
  }
  return [...byId.values()];
}

function upsertLatestRequest<T extends { id: string; updatedAt: string }>(byId: Map<string, T>, request: T): void {
  if (!request.id) return;
  const existing = byId.get(request.id);
  if (!existing || Date.parse(request.updatedAt) >= Date.parse(existing.updatedAt)) {
    byId.set(request.id, request);
  }
}

function defaultStatePath(): string {
  return readAppEnv("STATE_PATH") ?? join(defaultOpenGroveDataDir(), LEGACY_JSON_STATE_FILE_NAME);
}

export function normalizePersistedAgentState(
  input: unknown,
  options: PersistedStateLoadOptions = {},
): PersistedAgentState {
  const object = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const restartedAt = new Date().toISOString();
  const rawApprovals = Array.isArray(object.approvals) ? (object.approvals as ApprovalRequest[]) : [];
  const rawQuestions = Array.isArray(object.questions) ? (object.questions as QuestionRequest[]) : [];
  const durableContinuationRunIds = new Set(
    options.preserveResumablePendingRequests === true
      ? rawApprovals.flatMap((request) =>
          request.status === "pending" && request.resume?.type === "routine.step" ? [request.resume.runId] : [],
        )
      : [],
  );
  const reconciledRunIds = new Set<string>();
  const runs = (Array.isArray(object.runs) ? object.runs : []).map((value) => {
    const stored = value as RunRecord & { status?: unknown };
    const lifecycle = normalizePersistedRunLifecycle(stored.lifecycle, stored.status);
    const { status: _legacyStatus, ...withoutLegacyStatus } = stored;
    const producerIsLive = options.activeRunIds?.has(stored.id) === true;
    const needsLiveProducer =
      lifecycle.taskState === "TASK_STATE_SUBMITTED" ||
      lifecycle.taskState === "TASK_STATE_WORKING" ||
      ((lifecycle.taskState === "TASK_STATE_INPUT_REQUIRED" || lifecycle.taskState === "TASK_STATE_AUTH_REQUIRED") &&
        !durableContinuationRunIds.has(stored.id));
    if (!producerIsLive && needsLiveProducer) {
      reconciledRunIds.add(stored.id);
      return {
        ...withoutLegacyStatus,
        lifecycle: lifecycleFromRunFact({ kind: "producer_lost" }),
        endedAt: restartedAt,
        updatedAt: restartedAt,
      } satisfies RunRecord;
    }
    return { ...withoutLegacyStatus, lifecycle } satisfies RunRecord;
  });
  const restoredWorkingState =
    object.workingState && typeof object.workingState === "object"
      ? (object.workingState as Partial<WorkingStateRecord>)
      : undefined;
  const approvals = rawApprovals.length
    ? rawApprovals.map((approval) =>
        shouldPreservePendingRequest(approval, options) ? approval : expireStaleApproval(approval, restartedAt),
      )
    : [];
  const questions = rawQuestions.length
    ? rawQuestions.map((question) =>
        shouldPreservePendingRequest(question, options) ? question : expireStaleQuestion(question, restartedAt),
      )
    : [];
  const liveApprovalIds = new Set(
    approvals.filter((request) => request.status === "pending").map((request) => request.id),
  );
  const liveQuestionIds = new Set(
    questions.filter((request) => request.status === "pending").map((request) => request.id),
  );
  return {
    version: CURRENT_PERSISTED_AGENT_STATE_VERSION,
    savedAt: typeof object.savedAt === "string" ? object.savedAt : new Date().toISOString(),
    knowledge: Array.isArray(object.knowledge) ? (object.knowledge as KnowledgeDocument[]) : [],
    knowledgeEvidence: Array.isArray(object.knowledgeEvidence)
      ? (object.knowledgeEvidence as KnowledgeEvidenceRecord[])
      : [],
    knowledgeRevisions: Array.isArray(object.knowledgeRevisions)
      ? (object.knowledgeRevisions as KnowledgeRevision[])
      : [],
    knowledgeDeliveries: Array.isArray(object.knowledgeDeliveries)
      ? (object.knowledgeDeliveries as KnowledgeDeliveryRecord[])
      : [],
    knowledgeFeedback: Array.isArray(object.knowledgeFeedback)
      ? (object.knowledgeFeedback as KnowledgeFeedbackEvent[])
      : [],
    memory: Array.isArray(object.memory) ? (object.memory as MemoryRecord[]) : [],
    artifacts: Array.isArray(object.artifacts) ? (object.artifacts as ArtifactRecord[]) : [],
    workingState: restoredWorkingState
      ? {
          ...restoredWorkingState,
          pinnedArtifactIds: Array.isArray(restoredWorkingState.pinnedArtifactIds)
            ? restoredWorkingState.pinnedArtifactIds
            : [],
          workingArtifactIds: Array.isArray(restoredWorkingState.workingArtifactIds)
            ? restoredWorkingState.workingArtifactIds
            : [],
          pendingApprovalIds: Array.isArray(restoredWorkingState.pendingApprovalIds)
            ? restoredWorkingState.pendingApprovalIds.filter((id) => liveApprovalIds.has(id))
            : [],
          pendingQuestionIds: Array.isArray(restoredWorkingState.pendingQuestionIds)
            ? restoredWorkingState.pendingQuestionIds.filter((id) => liveQuestionIds.has(id))
            : [],
          activeToolCallIds: Array.isArray(restoredWorkingState.activeToolCallIds)
            ? restoredWorkingState.activeToolCallIds
            : [],
          discoveredSkillIds: Array.isArray(restoredWorkingState.discoveredSkillIds)
            ? restoredWorkingState.discoveredSkillIds
            : [],
          discoveredSkillNames: Array.isArray(restoredWorkingState.discoveredSkillNames)
            ? restoredWorkingState.discoveredSkillNames
            : [],
          expandedSkillIds: Array.isArray(restoredWorkingState.expandedSkillIds)
            ? restoredWorkingState.expandedSkillIds
            : [],
          invokedSkills: Array.isArray(restoredWorkingState.invokedSkills) ? restoredWorkingState.invokedSkills : [],
          loadedNestedMemoryPaths: Array.isArray(restoredWorkingState.loadedNestedMemoryPaths)
            ? restoredWorkingState.loadedNestedMemoryPaths
            : [],
          toolSchemaCache:
            restoredWorkingState.toolSchemaCache &&
            typeof restoredWorkingState.toolSchemaCache === "object" &&
            !Array.isArray(restoredWorkingState.toolSchemaCache)
              ? restoredWorkingState.toolSchemaCache
              : {},
          updatedAt:
            options.activeRoomRunIds === undefined
              ? restartedAt
              : typeof restoredWorkingState.updatedAt === "string"
                ? restoredWorkingState.updatedAt
                : restartedAt,
        }
      : {
          pinnedArtifactIds: [],
          workingArtifactIds: [],
          pendingApprovalIds: [],
          pendingQuestionIds: [],
          activeToolCallIds: [],
          discoveredSkillIds: [],
          discoveredSkillNames: [],
          expandedSkillIds: [],
          invokedSkills: [],
          loadedNestedMemoryPaths: [],
          toolSchemaCache: {},
          updatedAt: restartedAt,
        },
    approvals,
    questions,
    events: [
      ...(Array.isArray(object.events) ? (object.events as AgentEvent[]) : []),
      ...Array.from(
        reconciledRunIds,
        (runId): AgentEvent => ({
          type: "turn.finished",
          runId,
          at: restartedAt,
          outcome: lifecycleFromRunFact({ kind: "producer_lost" }),
          synthetic: true,
        }),
      ),
    ],
    routines: Array.isArray(object.routines) ? (object.routines as Routine[]) : [],
    sessions: Array.isArray(object.sessions) ? (object.sessions as SessionRecord[]) : [],
    runs,
    executions: Array.isArray(object.executions) ? (object.executions as ExecutionRecord[]) : [],
    rooms: normalizeRoomChannelState(
      object.rooms,
      runs,
      Array.isArray(object.events) ? (object.events as AgentEvent[]) : [],
      options,
    ),
  };
}

function shouldPreservePendingRequest(
  request: ApprovalRequest | QuestionRequest,
  options: PersistedStateLoadOptions,
): boolean {
  if (request.status !== "pending") return false;
  const runId = request.resume && "runId" in request.resume ? request.resume.runId : undefined;
  if (typeof runId === "string" && options.activeRunIds?.has(runId)) return true;
  return options.preserveResumablePendingRequests === true && request.resume?.type === "routine.step";
}

const normalizeState = normalizePersistedAgentState;

function expireStaleApproval(approval: ApprovalRequest, restartedAt: string): ApprovalRequest {
  if (approval.status !== "pending") return approval;
  return {
    ...approval,
    status: "canceled",
    response: { system: true, reasonCode: "producer_lost" },
    updatedAt: restartedAt,
  };
}

function expireStaleQuestion(question: QuestionRequest, restartedAt: string): QuestionRequest {
  if (question.status !== "pending") return question;
  return {
    ...question,
    status: "canceled",
    response: { system: true, reasonCode: "producer_lost" },
    updatedAt: restartedAt,
  };
}

function normalizeRoomChannelState(
  input: unknown,
  runs: RunRecord[] = [],
  events: AgentEvent[] = [],
  options: PersistedStateLoadOptions = {},
): RoomChannelSnapshot {
  const object =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Partial<RoomChannelSnapshot>) : {};
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const roomRunErrors = roomRunErrorsById(events);
  const messages = Array.isArray(object.messages) ? (object.messages as RoomChannelSnapshot["messages"]) : [];
  const activeRoomRunIds = options.activeRoomRunIds ?? new Set<string>();
  const language = options.language ?? "zh-CN";
  const interruptedText = hostMessage(language, "room.run_host_restarted");
  const idleText = hostMessage(language, "room.member_idle");
  const transientLastActiveTexts = [
    hostMessage(language, "room.member_running"),
    hostMessage(language, "room.member_waiting"),
  ];
  const activeMemberIds = new Set(
    messages
      .filter(
        (message) => message.status === "running" && Boolean(message.runId && activeRoomRunIds.has(message.runId)),
      )
      .map((message) => message.senderId),
  );
  return {
    version: 1,
    currentEventSeq: typeof object.currentEventSeq === "number" ? object.currentEventSeq : 0,
    rooms: Array.isArray(object.rooms) ? (object.rooms as RoomChannelSnapshot["rooms"]) : [],
    members: Array.isArray(object.members)
      ? (object.members as RoomChannelSnapshot["members"]).map((member) =>
          activeMemberIds.has(member.id)
            ? member
            : resetInactiveRoomMember(member, { idleText, transientLastActiveTexts }),
        )
      : [],
    messages: messages.length
      ? messages.map((originalMessage) => {
          if (originalMessage.runId && activeRoomRunIds.has(originalMessage.runId)) return originalMessage;
          const message = Array.isArray(originalMessage.parts)
            ? {
                ...originalMessage,
                parts: closeInterruptedRoomRunParts(originalMessage.parts, interruptedText, "host_restarted"),
              }
            : originalMessage;
          if (message.status === "running") {
            return interruptRoomRunMessage(message, {
              fallbackText: interruptedText,
              reason: "host_restarted",
            });
          }
          if (textOrEmpty(message.text).trim() || !message.runId) return message;
          if (message.status !== "failed" && message.status !== "done") return message;
          const error = roomRunErrors.get(message.runId) || String(runsById.get(message.runId)?.error || "").trim();
          return error ? { ...message, text: error, status: "failed" } : message;
        })
      : [],
    // Room cursors use the persisted numeric sequence, so the retained event
    // tail must travel with currentEventSeq across both hot rebuilds and cold
    // restores. Dropping one without the other would force avoidable resets.
    events: Array.isArray(object.events) ? (object.events as RoomChannelSnapshot["events"]) : [],
    deletedMemberIds: Array.isArray(object.deletedMemberIds) ? object.deletedMemberIds.map(String).filter(Boolean) : [],
  };
}

function roomRunErrorsById(events: AgentEvent[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const event of events) {
    if (!event.runId?.startsWith("room_run_")) continue;
    const eventMessage = textOrEmpty(event.type === "error" ? event.message : "");
    if (event.type === "error" && eventMessage.trim()) {
      errors.set(event.runId, eventMessage.trim());
      continue;
    }
    if (event.type === "runtime.diagnostic" && event.name === "hermes.acp.empty_response_diagnostic") {
      const data =
        event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      const diagnostic = typeof data.diagnostic === "string" ? data.diagnostic.trim() : "";
      if (diagnostic) {
        errors.set(event.runId, diagnostic);
      }
    }
  }
  return errors;
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
