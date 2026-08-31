import type {
  ActivitySpace,
  AgentEvent,
  JsonObject,
  RunFilter,
  RunRecord,
  SessionFilter,
  SessionRecord,
  SessionStatus,
} from "../types.js";
import { sanitizeDiagnosticProblemRef } from "../../diagnostics/problem-schema.js";
import { MutationRevision } from "./mutation-revision.js";

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly mutationRevision = new MutationRevision();

  restore(snapshot: { sessions?: SessionRecord[]; runs?: RunRecord[] } = {}): void {
    this.sessions.clear();
    this.runs.clear();

    for (const session of snapshot.sessions ?? []) {
      this.sessions.set(session.id, normalizeSession(session));
    }
    for (const run of snapshot.runs ?? []) {
      this.runs.set(run.id, normalizeRun(run));
    }
    this.reconcile();
    this.mutationRevision.advance();
  }

  ensureSession(input: {
    id: string;
    title?: string;
    activity?: ActivitySpace;
    status?: SessionStatus;
    metadata?: JsonObject;
    lastUserInput?: string;
  }): SessionRecord {
    const current = this.sessions.get(input.id);
    const now = new Date().toISOString();
    const session = normalizeSession({
      ...(current ?? {
        id: input.id,
        createdAt: now,
        runIds: [],
      }),
      ...current,
      id: input.id,
      title: input.title ?? current?.title,
      activity: input.activity ?? current?.activity,
      status: input.status ?? current?.status ?? "idle",
      metadata: input.metadata ?? current?.metadata,
      lastUserInput: input.lastUserInput ?? current?.lastUserInput,
      updatedAt: now,
    });
    this.sessions.set(session.id, session);
    this.mutationRevision.advance();
    return this.get(session.id)!;
  }

  list(filter: SessionFilter = {}): SessionRecord[] {
    const ids = filter.ids ? new Set(filter.ids) : undefined;
    const sessions = Array.from(this.sessions.values())
      .filter((session) => {
        if (ids && !ids.has(session.id)) return false;
        if (filter.status && session.status !== filter.status) return false;
        if (filter.activity && session.activity !== filter.activity) return false;
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({ ...session, runIds: [...session.runIds] }));
    return typeof filter.limit === "number" ? sessions.slice(0, filter.limit) : sessions;
  }

  get(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session, runIds: [...session.runIds] } : undefined;
  }

  listRuns(filter: RunFilter = {}): RunRecord[] {
    const ids = filter.ids ? new Set(filter.ids) : undefined;
    const runs = Array.from(this.runs.values())
      .filter((run) => {
        if (ids && !ids.has(run.id)) return false;
        if (filter.sessionId && run.sessionId !== filter.sessionId) return false;
        if (filter.status && run.status !== filter.status) return false;
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return (typeof filter.limit === "number" ? runs.slice(0, filter.limit) : runs).map((run) => ({
      ...run,
      ...(run.problem ? { problem: { ...run.problem } } : {}),
      approvalIds: [...run.approvalIds],
      questionIds: [...run.questionIds],
      toolIds: [...run.toolIds],
    }));
  }

  getRun(id: string): RunRecord | undefined {
    return this.listRuns({ ids: [id], limit: 1 })[0];
  }

  startRun(input: {
    id: string;
    sessionId: string;
    activity: ActivitySpace;
    input: string;
    title?: string;
  }): RunRecord {
    const now = new Date().toISOString();
    this.ensureSession({
      id: input.sessionId,
      title: input.title,
      activity: input.activity,
      status: "active",
      lastUserInput: input.input,
    });
    const run = normalizeRun({
      id: input.id,
      sessionId: input.sessionId,
      activity: input.activity,
      status: "running",
      input: input.input,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      approvalIds: [],
      questionIds: [],
      toolIds: [],
      eventCount: 0,
    });
    this.runs.set(run.id, run);
    this.syncSessionFromRun(run);
    this.mutationRevision.advance();
    return this.getRun(run.id)!;
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, "id" | "sessionId" | "createdAt" | "startedAt">>): RunRecord {
    const current = this.runs.get(id);
    if (!current) {
      throw new Error(`Run not found: ${id}`);
    }
    const updated = normalizeRun({
      ...current,
      ...patch,
      id: current.id,
      sessionId: current.sessionId,
      createdAt: current.createdAt,
      startedAt: current.startedAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    });
    this.runs.set(id, updated);
    this.syncSessionFromRun(updated);
    this.mutationRevision.advance();
    return this.getRun(id)!;
  }

  recordEvent(
    event: AgentEvent,
    fallback: {
      sessionId?: string;
      activity?: ActivitySpace;
      input?: string;
    } = {},
  ): RunRecord | undefined {
    const existing = this.runs.get(event.runId);
    const sessionId = existing?.sessionId || sessionIdFromEvent(event) || fallback.sessionId;
    const activity = existing?.activity ?? fallback.activity ?? "chat";
    const input = inputFromEvent(event) ?? fallback.input ?? existing?.input ?? "";

    if (!existing && sessionId) {
      this.startRun({
        id: event.runId,
        sessionId,
        activity,
        input,
      });
    }

    const run = this.runs.get(event.runId);
    if (!run) {
      return undefined;
    }

    const patch: Partial<Omit<RunRecord, "id" | "sessionId" | "createdAt" | "startedAt">> = {
      eventCount: run.eventCount + 1,
    };

    switch (event.type) {
      case "model.requested":
        patch.modelId = event.request.modelId;
        patch.summary = summarizeRunText(run.summary, event.request.userInput);
        break;
      case "model.response":
        patch.summary = summarizeRunText(event.response.text, run.summary);
        break;
      case "assistant.final":
        patch.summary = summarizeRunText(event.text, run.summary);
        break;
      case "tool.started":
        patch.toolIds = uniqueStrings([...run.toolIds, event.toolId]);
        break;
      case "tool.finished":
        patch.toolIds = uniqueStrings([...run.toolIds, event.toolId]);
        if (run.status === "waiting_for_approval" || run.endedAt) {
          patch.status = event.result.ok ? "succeeded" : "failed";
          patch.endedAt = new Date().toISOString();
          if (!event.result.ok) {
            patch.error = event.result.error ?? "tool_failed";
          }
        }
        break;
      case "approval.requested":
        patch.approvalIds = uniqueStrings([...run.approvalIds, event.request.id]);
        patch.status = "waiting_for_approval";
        patch.lastApprovalId = event.request.id;
        break;
      case "question.requested":
        patch.questionIds = uniqueStrings([...run.questionIds, event.question.id]);
        patch.status = "waiting_for_user";
        patch.pausedAt = event.question.createdAt;
        patch.pauseReason = event.question.prompt;
        patch.lastQuestionId = event.question.id;
        break;
      case "question.answered":
        patch.status = "running";
        patch.resumedAt = event.question.updatedAt;
        patch.pauseReason = undefined;
        patch.lastQuestionId = event.question.id;
        break;
      case "run.paused":
        patch.status = "waiting_for_approval";
        patch.pausedAt = event.at;
        patch.pauseReason = event.reason;
        patch.lastApprovalId = event.approvalId ?? run.lastApprovalId;
        break;
      case "run.resumed":
        patch.status = "running";
        patch.resumedAt = event.at;
        patch.pauseReason = undefined;
        patch.endedAt = undefined;
        patch.lastApprovalId = event.approvalId ?? run.lastApprovalId;
        patch.resumeCount = run.resumeCount + 1;
        break;
      case "approval.resolved":
        patch.lastApprovalId = event.request.id;
        if (event.request.status === "rejected") {
          patch.status = "failed";
          patch.error = event.request.reason;
          patch.endedAt = event.request.updatedAt;
        }
        break;
      case "error":
        patch.status = "failed";
        patch.error = event.message;
        if (event.problem) patch.problem = event.problem;
        break;
      case "turn.finished":
        patch.endedAt = event.at;
        patch.status =
          run.status === "waiting_for_approval" || run.status === "waiting_for_user"
            ? run.status
            : run.status === "failed"
              ? "failed"
              : "succeeded";
        break;
      default:
        break;
    }

    return this.updateRun(event.runId, patch);
  }

  clear(): void {
    this.sessions.clear();
    this.runs.clear();
    this.mutationRevision.advance();
  }

  revision(): string {
    return this.mutationRevision.current();
  }

  private reconcile(): void {
    for (const [id, session] of this.sessions) {
      this.sessions.set(id, normalizeSession(session));
    }
    for (const [id, run] of this.runs) {
      this.runs.set(id, normalizeRun(run));
    }
    for (const run of this.runs.values()) {
      this.syncSessionFromRun(run);
    }
  }

  private syncSessionFromRun(run: RunRecord): void {
    const current =
      this.sessions.get(run.sessionId) ??
      normalizeSession({
        id: run.sessionId,
        activity: run.activity,
        status: "idle",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        runIds: [],
      });
    const runIds = uniqueStrings([...current.runIds, run.id]);
    const activeRunId =
      run.status === "running" || run.status === "waiting_for_approval" || run.status === "waiting_for_user"
        ? run.id
        : current.activeRunId === run.id
          ? undefined
          : current.activeRunId;
    const session = normalizeSession({
      ...current,
      activity: run.activity,
      status: activeRunId ? "active" : current.status === "archived" ? "archived" : "idle",
      latestRunId: run.id,
      activeRunId,
      runIds,
      lastUserInput: run.input || current.lastUserInput,
      updatedAt: run.updatedAt,
    });
    this.sessions.set(session.id, session);
  }
}

function normalizeSession(input: Partial<SessionRecord> & Pick<SessionRecord, "id">): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    title: typeof input.title === "string" ? input.title : undefined,
    activity: input.activity,
    status: input.status ?? "idle",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
    activeRunId: typeof input.activeRunId === "string" ? input.activeRunId : undefined,
    latestRunId: typeof input.latestRunId === "string" ? input.latestRunId : undefined,
    runIds: uniqueStrings(input.runIds),
    lastUserInput: typeof input.lastUserInput === "string" ? input.lastUserInput : undefined,
    metadata: isJsonObject(input.metadata) ? input.metadata : undefined,
  };
}

function normalizeRun(input: Partial<RunRecord> & Pick<RunRecord, "id" | "sessionId">): RunRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    sessionId: input.sessionId,
    activity: input.activity ?? "chat",
    status: input.status ?? "running",
    input: typeof input.input === "string" ? input.input : "",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
    startedAt: typeof input.startedAt === "string" ? input.startedAt : now,
    endedAt: typeof input.endedAt === "string" ? input.endedAt : undefined,
    modelId: typeof input.modelId === "string" ? input.modelId : undefined,
    summary: typeof input.summary === "string" ? input.summary : undefined,
    error: typeof input.error === "string" ? input.error : undefined,
    problem: sanitizeDiagnosticProblemRef(input.problem),
    pausedAt: typeof input.pausedAt === "string" ? input.pausedAt : undefined,
    resumedAt: typeof input.resumedAt === "string" ? input.resumedAt : undefined,
    pauseReason: typeof input.pauseReason === "string" ? input.pauseReason : undefined,
    lastApprovalId: typeof input.lastApprovalId === "string" ? input.lastApprovalId : undefined,
    lastQuestionId: typeof input.lastQuestionId === "string" ? input.lastQuestionId : undefined,
    resumeCount: typeof input.resumeCount === "number" ? input.resumeCount : 0,
    approvalIds: uniqueStrings(input.approvalIds),
    questionIds: uniqueStrings(input.questionIds),
    toolIds: uniqueStrings(input.toolIds),
    eventCount: typeof input.eventCount === "number" ? input.eventCount : 0,
  };
}

function sessionIdFromEvent(event: AgentEvent): string | undefined {
  return event.type === "model.requested" ? event.request.session?.sessionId : undefined;
}

function inputFromEvent(event: AgentEvent): string | undefined {
  if (event.type === "model.requested") {
    return event.request.userInput;
  }
  return undefined;
}

function summarizeRunText(primary?: string, fallback?: string): string | undefined {
  const text = (primary ?? fallback ?? "").trim();
  return text ? (text.length > 240 ? `${text.slice(0, 237)}...` : text) : undefined;
}

function uniqueStrings(value: unknown): string[] {
  return [...new Set(normalizeStringArray(value))];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
