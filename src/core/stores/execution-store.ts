import type { AgentEvent, ExecutionFilter, ExecutionKind, ExecutionRecord, JsonObject } from "../types.js";
import { MutationRevision } from "./mutation-revision.js";

export class ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly mutationRevision = new MutationRevision();
  private retentionLimit?: number;
  private sequence = 0;

  restore(records: ExecutionRecord[] = []): void {
    this.records.clear();
    this.sequence = 0;

    for (const record of records) {
      this.records.set(record.id, normalizeExecutionRecord(record));
      const match = record.id.match(/^exec_(\d+)$/);
      if (match) {
        this.sequence = Math.max(this.sequence, Number(match[1]));
      }
      this.trimToRetentionLimit();
    }
    this.mutationRevision.advance();
  }

  setRetentionLimit(limit: number | undefined): void {
    this.retentionLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
    this.trimToRetentionLimit();
  }

  appendFromEvent(event: AgentEvent, options: { sessionId?: string; recordedAt?: string } = {}): ExecutionRecord {
    const record = normalizeExecutionRecord({
      id: `exec_${++this.sequence}`,
      runId: event.runId,
      sessionId: options.sessionId,
      kind: inferExecutionKind(event),
      eventType: event.type,
      title: executionTitle(event),
      at: inferExecutionTimestamp(event, options.recordedAt),
      status: executionStatus(event),
      toolId: "toolId" in event ? event.toolId : undefined,
      approvalId: approvalIdFromEvent(event),
      questionId: questionIdFromEvent(event),
      artifactId: inferArtifactId(event),
      data: executionData(event),
    });
    this.records.set(record.id, record);
    this.trimToRetentionLimit();
    this.mutationRevision.advance();
    return { ...record };
  }

  revision(): string {
    return this.mutationRevision.current();
  }

  list(filter: ExecutionFilter = {}): ExecutionRecord[] {
    const records = Array.from(this.records.values())
      .filter((record) => {
        if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
        if (filter.runId && record.runId !== filter.runId) return false;
        if (filter.kind && record.kind !== filter.kind) return false;
        return true;
      })
      .sort((left, right) => right.at.localeCompare(left.at))
      .map((record) => ({ ...record }));
    return typeof filter.limit === "number" ? records.slice(0, filter.limit) : records;
  }

  clear(): void {
    this.records.clear();
    this.sequence = 0;
    this.mutationRevision.advance();
  }

  private trimToRetentionLimit(): void {
    if (this.retentionLimit === undefined) return;
    while (this.records.size > this.retentionLimit) {
      const oldestId = this.records.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.records.delete(oldestId);
    }
  }
}

function normalizeExecutionRecord(input: ExecutionRecord): ExecutionRecord {
  return {
    ...input,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    status: typeof input.status === "string" ? input.status : undefined,
    toolId: typeof input.toolId === "string" ? input.toolId : undefined,
    approvalId: typeof input.approvalId === "string" ? input.approvalId : undefined,
    questionId: typeof input.questionId === "string" ? input.questionId : undefined,
    artifactId: typeof input.artifactId === "string" ? input.artifactId : undefined,
    data: isJsonObject(input.data) ? input.data : undefined,
  };
}

function inferExecutionKind(event: AgentEvent): ExecutionKind {
  switch (event.type) {
    case "turn.started":
    case "turn.finished":
    case "context.assembled":
    case "compaction.started":
    case "compaction.finished":
      return "loop";
    case "model.requested":
    case "model.response":
    case "assistant.delta":
    case "assistant.final":
    case "assistant.status":
      return "model";
    case "reasoning.started":
    case "reasoning.completed":
      return "reasoning";
    case "skill.discovered":
    case "skill.invoked":
    case "skill.loaded":
    case "skill.forked":
    case "skill.cleared":
      return "loop";
    case "approval.requested":
    case "approval.resolved":
    case "run.paused":
    case "run.resumed":
      return "approval";
    case "question.requested":
    case "question.answered":
      return "question";
    case "planning.updated":
      return "planning";
    case "error":
      return "error";
    case "tool.finished":
      return event.toolId === "artifact.annotation" || Boolean(inferArtifactId(event)) ? "artifact" : "tool_call";
    case "tool.started":
    case "tool.progress":
      return "tool_call";
    case "memory.written":
      return "memory";
    default:
      return "tool_call";
  }
}

function executionTitle(event: AgentEvent): string {
  switch (event.type) {
    case "turn.started":
      return "Turn started";
    case "turn.finished":
      return "Turn finished";
    case "context.assembled":
      return "Context assembled";
    case "compaction.started":
      return "Compaction started";
    case "compaction.finished":
      return "Compaction finished";
    case "model.requested":
      return `Model requested${event.request.modelId ? ` · ${event.request.modelId}` : ""}`;
    case "model.response":
      return "Model responded";
    case "assistant.delta":
      return "Assistant delta";
    case "assistant.final":
      return "Assistant final";
    case "assistant.status":
      return "Assistant status";
    case "reasoning.started":
      return `Reasoning started · ${event.reasoning.kind}`;
    case "reasoning.completed":
      return `Reasoning completed · ${event.reasoning.kind}`;
    case "skill.discovered":
      return `Skills discovered · ${event.skills.length}`;
    case "skill.invoked":
      return `Skill invoked · ${event.skill.name}`;
    case "skill.loaded":
      return `Skill loaded · ${event.skillId}`;
    case "skill.forked":
      return `Skill forked · ${event.skillId}`;
    case "skill.cleared":
      return `Skill cleared${event.skillId ? ` · ${event.skillId}` : ""}`;
    case "tool.started":
      return `Tool started · ${event.toolId}`;
    case "tool.progress":
      return `Tool progress · ${event.toolId}`;
    case "tool.finished":
      return `Tool finished · ${event.toolId}`;
    case "approval.requested":
      return `Approval requested · ${event.request.title || event.request.toolId || event.request.id}`;
    case "approval.resolved":
      return `Approval ${event.request.status}`;
    case "question.requested":
      return `Question requested · ${event.question.title || event.question.id}`;
    case "question.answered":
      return `Question ${event.question.status}`;
    case "planning.updated":
      return `Plan updated · ${event.plan.title || event.plan.id}`;
    case "run.paused":
      return "Run paused";
    case "run.resumed":
      return "Run resumed";
    case "memory.written":
      return `Memory written · ${event.record.kind}`;
    case "error":
      return "Run error";
    default:
      return "Event";
  }
}

function inferExecutionTimestamp(event: AgentEvent, recordedAt = new Date().toISOString()): string {
  switch (event.type) {
    case "turn.started":
    case "turn.finished":
    case "compaction.started":
    case "compaction.finished":
      return event.at;
    case "approval.requested":
      return event.request.createdAt;
    case "approval.resolved":
      return event.request.updatedAt;
    case "question.requested":
      return event.question.createdAt;
    case "question.answered":
      return event.question.updatedAt;
    case "planning.updated":
      return event.plan.updatedAt;
    case "run.paused":
    case "run.resumed":
      return event.at;
    case "memory.written":
      return event.record.updatedAt;
    default:
      return recordedAt;
  }
}

function executionStatus(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "approval.requested":
    case "approval.resolved":
      return event.request.status;
    case "question.requested":
    case "question.answered":
      return event.question.status;
    case "planning.updated":
      return event.plan.status || "updated";
    case "run.paused":
      return "paused";
    case "run.resumed":
      return "running";
    case "skill.forked":
      return event.status;
    case "reasoning.started":
      return "running";
    case "reasoning.completed":
      return "complete";
    case "tool.finished":
      return event.result.ok ? "ok" : (event.result.error ?? "error");
    case "tool.progress":
      return "running";
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

function inferArtifactId(event: AgentEvent): string | undefined {
  if (
    event.type === "tool.finished" &&
    isJsonObject(event.result.value) &&
    typeof event.result.value.artifactId === "string"
  ) {
    return event.result.value.artifactId;
  }
  return undefined;
}

function approvalIdFromEvent(event: AgentEvent): string | undefined {
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    return event.request.id;
  }
  if (event.type === "run.paused" || event.type === "run.resumed") {
    return event.approvalId;
  }
  return undefined;
}

function questionIdFromEvent(event: AgentEvent): string | undefined {
  if (event.type === "question.requested" || event.type === "question.answered") {
    return event.question.id;
  }
  return undefined;
}

function executionData(event: AgentEvent): JsonObject | undefined {
  switch (event.type) {
    case "context.assembled":
      return { summary: event.context.summary };
    case "compaction.started":
      return {
        reason: event.reason ?? "",
      };
    case "compaction.finished":
      return {
        summary: event.summary ?? "",
      };
    case "model.requested":
      return {
        modelId: event.request.modelId ?? "",
        userInput: event.request.userInput,
      };
    case "model.response":
      return event.response.text ? { text: summarizeRunText(event.response.text) ?? "" } : undefined;
    case "assistant.final":
      return event.text ? { text: summarizeRunText(event.text) ?? "", source: event.source ?? "" } : undefined;
    case "assistant.status":
      return {
        text: event.text,
        ...(event.data ?? {}),
      };
    case "reasoning.started":
      return {
        reasoningId: event.reasoning.id,
        kind: event.reasoning.kind,
        kernelId: event.reasoning.kernelId,
      };
    case "reasoning.completed":
      return {
        reasoningId: event.reasoning.id,
        kind: event.reasoning.kind,
        kernelId: event.reasoning.kernelId,
        text: event.reasoning.text,
        redacted: event.reasoning.redacted ?? false,
        elapsedMs: event.reasoning.elapsedMs ?? 0,
      };
    case "skill.discovered":
      return { skillIds: event.skills.map((skill) => skill.id).join(", ") };
    case "skill.invoked":
      return {
        skillId: event.skill.id,
        skillName: event.skill.name,
        origin: event.invocation.origin,
        args: event.invocation.args ?? "",
      };
    case "skill.loaded":
      return {
        skillId: event.skillId,
        contentPreview: event.contentPreview,
        allowedTools: event.allowedTools.join(", "),
        model: event.model ?? "",
        effort: event.effort ?? "",
        context: event.context,
      };
    case "skill.forked":
      return {
        skillId: event.skillId,
        forkSessionId: event.forkSessionId,
        status: event.status,
        result: summarizeRunText(event.result) ?? "",
      };
    case "skill.cleared":
      return {
        skillId: event.skillId ?? "",
        reason: event.reason,
      };
    case "tool.started":
      return isJsonObject(event.input) ? event.input : undefined;
    case "tool.progress":
      return isJsonObject(event.update) ? event.update : { update: event.update };
    case "tool.finished":
      return isJsonObject(event.result.value) ? event.result.value : undefined;
    case "approval.requested":
    case "approval.resolved":
      return isJsonObject(event.request.input) ? event.request.input : undefined;
    case "question.requested":
    case "question.answered":
      return isJsonObject(event.question.input) ? event.question.input : undefined;
    case "planning.updated":
      return {
        planId: event.plan.id,
        text: event.plan.text,
        title: event.plan.title ?? "",
        status: event.plan.status ?? "",
        raw: event.plan.raw ?? {},
      };
    case "run.paused":
      return {
        reason: event.reason,
        approvalId: event.approvalId ?? "",
      };
    case "run.resumed":
      return {
        reason: event.reason ?? "",
        approvalId: event.approvalId ?? "",
      };
    case "memory.written":
      return event.record.data;
    case "error":
      return { message: event.message };
    default:
      return undefined;
  }
}

function summarizeRunText(primary?: string, fallback?: string): string | undefined {
  const text = (primary ?? fallback ?? "").trim();
  return text ? (text.length > 240 ? `${text.slice(0, 237)}...` : text) : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
