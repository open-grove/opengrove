import type { AgentEvent, JsonObject, JsonValue, PlanningUpdate, UsageStats } from "../../core.js";

export interface AcpSessionProjectorOptions {
  runId: string;
  kernelId: string;
  diagnosticPrefix?: string;
  ignoreThoughts?: boolean;
  toolFailureMessage?: string;
  toolIdFromUpdate?: (update: Record<string, unknown>) => string | undefined;
  ignoreToolCall?: (update: Record<string, unknown>) => boolean;
  onAssistantText?: (text: string) => void;
}

interface AcpToolCallState {
  toolId: string;
  input: JsonValue;
}

export class AcpSessionProjector {
  private readonly toolCalls = new Map<string, AcpToolCallState>();
  private readonly ignoredToolCallIds = new Set<string>();
  private fallbackToolCallSequence = 0;
  private thoughtText = "";
  private thoughtFlushed = false;

  constructor(private readonly options: AcpSessionProjectorOptions) {}

  project(update: Record<string, unknown>): AgentEvent[] {
    const normalized = normalizeAcpUpdate(update);
    const sessionUpdate = normalized.kind;
    update = normalized.update;
    if (sessionUpdate === "agent_message_chunk") {
      const text = acpContentText(update.content);
      if (!text) return [];
      this.options.onAssistantText?.(text);
      return [{ type: "assistant.delta", runId: this.options.runId, text }];
    }

    if (sessionUpdate === "agent_thought_chunk") {
      if (!(this.options.ignoreThoughts ?? false)) {
        this.thoughtText += acpContentText(update.content ?? update);
      }
      return [];
    }

    if (sessionUpdate === "tool_call") {
      const toolCallId =
        readProjectorString(update, "toolCallId") ?? `${this.options.kernelId}_tool_${++this.fallbackToolCallSequence}`;
      if (this.options.ignoreToolCall?.(update)) {
        this.ignoredToolCallIds.add(toolCallId);
        return [];
      }
      const toolId = this.toolId(update);
      const input = toJsonValue(
        update.rawInput ??
          update.input ??
          update.parameters ??
          update.content ?? {
            title: readProjectorString(update, "title") ?? readProjectorString(update, "name") ?? toolId,
          },
      );
      this.toolCalls.set(toolCallId, { toolId, input });
      return [{ type: "tool.started", runId: this.options.runId, toolId, callId: toolCallId, input }];
    }

    if (sessionUpdate === "tool_call_update") {
      const toolCallId = readProjectorString(update, "toolCallId") ?? this.toolCalls.keys().next().value ?? "";
      if (toolCallId && this.ignoredToolCallIds.has(toolCallId)) {
        const status = readProjectorString(update, "status");
        if (status === "completed" || status === "failed") {
          this.ignoredToolCallIds.delete(toolCallId);
        }
        return [];
      }
      const current = this.toolCalls.get(toolCallId);
      const status = readProjectorString(update, "status");
      const toolId = current?.toolId ?? this.toolId(update);
      if (status !== "completed" && status !== "failed") {
        return [
          {
            type: "tool.progress",
            runId: this.options.runId,
            toolId,
            ...(toolCallId ? { callId: toolCallId } : {}),
            update: toJsonValue(update),
          },
        ];
      }
      const output = update.rawOutput ?? update.output ?? update.content ?? { status };
      const ok = status !== "failed";
      if (toolCallId) {
        this.toolCalls.delete(toolCallId);
      }
      return [
        {
          type: "tool.finished",
          runId: this.options.runId,
          toolId,
          ...(toolCallId ? { callId: toolCallId } : {}),
          result: {
            ok,
            value: ok ? toJsonValue(output) : undefined,
            error: ok
              ? undefined
              : toolOutputText(output) || this.options.toolFailureMessage || `${this.options.kernelId} tool failed`,
          },
        },
      ];
    }

    if (sessionUpdate === "usage_update") {
      return [
        {
          type: "runtime.diagnostic",
          runId: this.options.runId,
          at: new Date().toISOString(),
          name: `${this.diagnosticPrefix()}.usage`,
          data: toJsonObject(update),
        },
      ];
    }

    if (sessionUpdate === "plan_update") {
      return [
        {
          type: "planning.updated",
          runId: this.options.runId,
          plan: acpPlanningUpdate(update, this.options.kernelId),
        },
      ];
    }

    if (sessionUpdate) {
      return [
        {
          type: "runtime.diagnostic",
          runId: this.options.runId,
          at: new Date().toISOString(),
          name: `${this.diagnosticPrefix()}.${sessionUpdate}`,
          data: toJsonObject(update),
        },
      ];
    }

    return [];
  }

  flushReasoning(): AgentEvent[] {
    const thinkingText = this.thoughtText.trim();
    if (this.thoughtFlushed || !thinkingText) return [];
    this.thoughtFlushed = true;
    const id = `${this.options.runId}:reasoning:1`;
    return [
      {
        type: "reasoning.started",
        runId: this.options.runId,
        reasoning: { id, kind: "native", kernelId: this.options.kernelId },
      },
      {
        type: "reasoning.completed",
        runId: this.options.runId,
        reasoning: { id, kind: "native", kernelId: this.options.kernelId, text: thinkingText },
      },
    ];
  }

  private diagnosticPrefix(): string {
    return this.options.diagnosticPrefix ?? `${this.options.kernelId}.acp`;
  }

  private toolId(update: Record<string, unknown>): string {
    return this.options.toolIdFromUpdate?.(update) ?? defaultAcpToolId(this.options.kernelId, update);
  }
}

export function readAcpContextUsage(update: Record<string, unknown>):
  | {
      used?: number;
      size?: number;
    }
  | undefined {
  const normalized = normalizeAcpUpdate(update);
  if (normalized.kind !== "usage_update") return undefined;
  const value = normalized.update;
  const used = readProjectorNumber(value, "used") ?? readProjectorNumber(value, "contextUsedTokens");
  const size = readProjectorNumber(value, "size") ?? readProjectorNumber(value, "contextWindowSize");
  return used !== undefined || size !== undefined ? { used, size } : undefined;
}

function normalizeAcpUpdate(update: Record<string, unknown>): {
  kind: string | undefined;
  update: Record<string, unknown>;
} {
  const explicit = readProjectorString(update, "sessionUpdate") || readProjectorString(update, "type");
  if (explicit) {
    const kind = normalizeAcpUpdateKind(explicit);
    return { kind, update: mergeNestedAcpUpdate(kind, update) };
  }
  const entries = Object.entries(update);
  if (entries.length === 1) {
    const [key, value] = entries[0]!;
    return { kind: normalizeAcpUpdateKind(key), update: asProjectorObject(value) };
  }
  return { kind: undefined, update };
}

function mergeNestedAcpUpdate(kind: string | undefined, update: Record<string, unknown>): Record<string, unknown> {
  const nestedKey = {
    agent_message_chunk: "agentMessageChunk",
    agent_thought_chunk: "agentThoughtChunk",
    tool_call: "toolCall",
    tool_call_update: "toolCallUpdate",
    usage_update: "usageUpdate",
    plan_update: "planUpdate",
  }[kind ?? ""];
  if (!nestedKey) return update;
  const nested = asProjectorObject(update[nestedKey]);
  return Object.keys(nested).length ? { ...nested, ...update } : update;
}

function normalizeAcpUpdateKind(value: string): string | undefined {
  const key = value.trim().toLowerCase().replace(/[_-]+/g, "");
  if (key === "agentmessagechunk") return "agent_message_chunk";
  if (key === "agentthoughtchunk") return "agent_thought_chunk";
  if (key === "toolcall") return "tool_call";
  if (key === "toolcallupdate") return "tool_call_update";
  if (key === "usageupdate") return "usage_update";
  if (key === "plan") return "plan_update";
  if (key === "planupdate") return "plan_update";
  if (key === "turnend" || key === "endturn") return "turn_end";
  return key || undefined;
}

function acpPlanningUpdate(update: Record<string, unknown>, kernelId: string): PlanningUpdate {
  const plan = asProjectorObject(update.plan ?? update);
  const entries = Array.isArray(plan.entries) ? plan.entries.map(asProjectorObject) : [];
  const text = [
    readProjectorString(plan, "title"),
    ...entries.map((entry) => {
      const content = readProjectorString(entry, "content") ?? readProjectorString(entry, "text") ?? "";
      const status = readProjectorString(entry, "status");
      const priority = readProjectorString(entry, "priority");
      const prefix = [status, priority].filter(Boolean).join("/");
      return content ? `${prefix ? `[${prefix}] ` : ""}${content}` : "";
    }),
  ]
    .filter(Boolean)
    .join("\n");
  const firstActiveStatus = entries
    .map((entry) => readProjectorString(entry, "status"))
    .find((status) => status === "in_progress" || status === "pending");
  return {
    id: readProjectorString(plan, "id") ?? `${kernelId}-plan`,
    title: readProjectorString(plan, "title") ?? "Plan",
    text: text || JSON.stringify(toJsonValue(plan)),
    status: firstActiveStatus ?? readProjectorString(plan, "status"),
    raw: toJsonObject(update),
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId },
  };
}

export function readAcpUsage(response: JsonValue | undefined): UsageStats | undefined {
  const usage = asProjectorObject(asProjectorObject(response).usage);
  const inputTokens = readProjectorNumber(usage, "inputTokens");
  const outputTokens = readProjectorNumber(usage, "outputTokens");
  const totalTokens = readProjectorNumber(usage, "totalTokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function acpContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(acpContentText).filter(Boolean).join("");
  }
  const content = asProjectorObject(value);
  if (readProjectorString(content, "type") === "text") {
    return readProjectorString(content, "text") ?? "";
  }
  const nested = asProjectorObject(content.content);
  if (readProjectorString(nested, "type") === "text") {
    return readProjectorString(nested, "text") ?? "";
  }
  return "";
}

export function defaultAcpToolId(kernelId: string, update: Record<string, unknown>): string {
  const title =
    readProjectorString(update, "title") ||
    readProjectorString(update, "name") ||
    readProjectorString(update, "toolCallId") ||
    "tool";
  const guessedName = title.includes(":") ? title.slice(0, title.indexOf(":")) : title.split(/\s+/)[0] || "tool";
  const normalized = guessedName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${kernelId}.${normalized || "tool"}`;
}

export function toolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = Array.isArray(value)
    ? value
        .map((item) => acpContentText(asProjectorObject(item).content ?? item))
        .filter(Boolean)
        .join("\n")
    : acpContentText(value);
  return content || undefined;
}

export function asProjectorObject(value: unknown): Record<string, unknown> {
  return isProjectorRecord(value) ? value : {};
}

export function isProjectorRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readProjectorString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return isProjectorRecord(json) ? (json as JsonObject) : {};
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function readProjectorNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
