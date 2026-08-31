import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentEvent, JsonObject, JsonValue, PlanningUpdate, UsageStats } from "../../core.js";
import type { AsyncEventQueue } from "./async-event-queue.js";
import { isJsonObject, readNumber, readString } from "./json.js";

export class CodexEventProjector {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly planTextByItem = new Map<string, string>();
  private readonly agentMessagePhaseByItem = new Map<string, string>();
  private readonly commentaryTextByItem = new Map<string, string>();
  private readonly reasoningSummaryTextByItem = new Map<string, string>();
  private readonly itemStartedAtMsByItem = new Map<string, number>();
  private readonly generatedImages: Array<{ alt: string; src: string }> = [];
  private streamedAssistantText = false;
  private error?: string;
  private tokenUsage?: UsageStats;

  constructor(
    private readonly runId: string,
    private readonly threadId: string,
    private readonly queue: AsyncEventQueue<AgentEvent>,
  ) {}

  handleNotification(notification: { method: string; params?: JsonValue }, turnId: string): boolean {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || !this.isForTurn(params, turnId)) {
      return false;
    }

    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const phase = readString(params, "phase") ?? this.agentMessagePhaseByItem.get(itemId);
      if (phase) {
        this.agentMessagePhaseByItem.set(itemId, phase);
      }
      const delta = readString(params, "delta") ?? "";
      if (delta) {
        if (!isFinalAgentMessagePhase(phase)) {
          this.commentaryTextByItem.set(itemId, `${this.commentaryTextByItem.get(itemId) ?? ""}${delta}`);
          return false;
        }
        this.rememberAssistantItem(itemId);
        this.assistantTextByItem.set(itemId, `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`);
        this.streamedAssistantText = true;
        this.queue.push({ type: "assistant.delta", runId: this.runId, text: delta });
      }
      return false;
    }

    if (notification.method === "item/reasoning/summaryTextDelta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id");
      const delta =
        readString(params, "delta") ??
        readString(params, "textDelta") ??
        readString(params, "summaryDelta") ??
        readString(params, "text") ??
        "";
      if (itemId && delta) {
        this.reasoningSummaryTextByItem.set(itemId, `${this.reasoningSummaryTextByItem.get(itemId) ?? ""}${delta}`);
      }
      return false;
    }

    if (notification.method === "thread/tokenUsage/updated") {
      this.tokenUsage = normalizeCodexUsage(params);
      return false;
    }

    if (notification.method === "turn/plan/updated") {
      const plan = planUpdateFromTurnPlan(params);
      this.queue.push({ type: "planning.updated", runId: this.runId, plan });
      return false;
    }

    if (notification.method === "item/reasoning/summaryPartAdded") {
      const data: JsonObject = {
        itemId: readString(params, "itemId") ?? readString(params, "id") ?? "reasoning",
      };
      if (typeof params.summaryIndex === "number") {
        data.summaryIndex = params.summaryIndex;
      }
      this.queue.push({
        type: "runtime.diagnostic",
        runId: this.runId,
        at: new Date().toISOString(),
        name: "codex.reasoning.summary_part",
        data,
      });
      return false;
    }

    if (notification.method === "item/plan/delta") {
      const plan = planUpdateFromDelta(params, this.planTextByItem);
      this.queue.push({ type: "planning.updated", runId: this.runId, plan });
      return false;
    }

    if (notification.method === "item/started") {
      const item = readItem(params);
      if (item) {
        const startedAtMs = readNumber(params, "startedAtMs");
        if (startedAtMs !== undefined) {
          this.itemStartedAtMsByItem.set(item.id, startedAtMs);
        }
      }
      if (item?.type === "agentMessage") {
        const phase = readAgentMessagePhase(item);
        if (phase) {
          this.agentMessagePhaseByItem.set(item.id, phase);
        }
      }
      if (item?.type === "contextCompaction") {
        this.queue.push({
          type: "compaction.started",
          runId: this.runId,
          at: new Date().toISOString(),
          reason: readString(item, "reason") ?? readString(item, "status"),
          item,
        });
      }
      const processEvent = itemToReasoningStarted(this.runId, item) ?? itemToToolStarted(this.runId, item);
      if (processEvent) {
        this.queue.push(processEvent);
      }
      return false;
    }

    if (notification.method === "item/completed") {
      const item = readItem(params);
      if (item?.type === "agentMessage") {
        const phase = readAgentMessagePhase(item) ?? this.agentMessagePhaseByItem.get(item.id);
        if (phase) {
          this.agentMessagePhaseByItem.set(item.id, phase);
        }
        const text = (
          typeof item.text === "string" ? item.text : (this.commentaryTextByItem.get(item.id) ?? "")
        ).trim();
        if (text) {
          if (!isFinalAgentMessagePhase(phase)) {
            this.commentaryTextByItem.set(item.id, text);
            this.queue.push({
              type: "assistant.status",
              runId: this.runId,
              at: new Date().toISOString(),
              text,
              data: {
                source: "codex",
                kind: "agent_message",
                phase: phase ?? "commentary",
                itemId: item.id,
              },
            });
          } else {
            this.rememberAssistantItem(item.id);
            this.assistantTextByItem.set(item.id, text);
          }
        }
      }
      if (item?.type === "imageGeneration") {
        this.rememberGeneratedImage(item);
      }
      if (item?.type === "contextCompaction") {
        this.queue.push({
          type: "compaction.finished",
          runId: this.runId,
          at: new Date().toISOString(),
          summary: readString(item, "summary") ?? readString(item, "status"),
          item,
        });
        if (turnId === "*") {
          return true;
        }
      }
      const timedItem = this.withElapsedMs(this.withReasoningSummary(item), params);
      const processEvent = itemToReasoningCompleted(this.runId, timedItem) ?? itemToToolFinished(this.runId, timedItem);
      if (processEvent) {
        this.queue.push(processEvent);
      }
      if (item) {
        this.itemStartedAtMsByItem.delete(item.id);
      }
      return false;
    }

    if (notification.method === "error") {
      if (params.willRetry === true) {
        return false;
      }
      const error = isJsonObject(params.error) ? params.error : undefined;
      this.error = readString(params, "message") ?? readString(error ?? {}, "message") ?? "codex app-server error";
      return false;
    }

    if (notification.method === "turn/completed") {
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      if (!turn || (turnId !== "*" && readString(turn, "id") !== turnId)) {
        return false;
      }
      const status = readString(turn, "status");
      if (status === "failed") {
        const turnError = isJsonObject(turn.error) ? turn.error : undefined;
        this.error = readString(turnError ?? {}, "message") ?? "codex turn failed";
      }
      const items = Array.isArray(turn.items) ? turn.items : [];
      let completedCompactionInTurn = false;
      for (const item of items) {
        const object = isJsonObject(item) ? item : undefined;
        if (object?.type === "agentMessage" && typeof object.text === "string" && object.text) {
          const itemId = typeof object.id === "string" ? object.id : "assistant";
          const phase = readAgentMessagePhase(object) ?? this.agentMessagePhaseByItem.get(itemId);
          if (phase) {
            this.agentMessagePhaseByItem.set(itemId, phase);
          }
          if (isFinalAgentMessagePhase(phase)) {
            this.rememberAssistantItem(itemId);
            this.assistantTextByItem.set(itemId, object.text);
          } else {
            this.commentaryTextByItem.set(itemId, object.text);
          }
        }
        if (object?.type === "imageGeneration") {
          this.rememberGeneratedImage(object as JsonObject & { id: string; type: string });
        }
        if (turnId === "*" && object?.type === "contextCompaction") {
          completedCompactionInTurn = true;
          this.queue.push({
            type: "compaction.finished",
            runId: this.runId,
            at: new Date().toISOString(),
            summary: readString(object, "summary") ?? readString(object, "status"),
            item: object,
          });
        }
      }
      return turnId === "*" ? completedCompactionInTurn : true;
    }

    if (notification.method === "thread/compacted") {
      this.queue.push({
        type: "compaction.finished",
        runId: this.runId,
        at: new Date().toISOString(),
        summary: "Codex compaction finished.",
        item: params,
      });
      return turnId === "*";
    }

    return false;
  }

  finalText(): string {
    const imageMarkdown = this.generatedImages
      .map((image) => `![${image.alt}](${image.src})`)
      .filter((line, index, lines) => lines.indexOf(line) === index);
    for (let index = this.assistantItemOrder.length - 1; index >= 0; index -= 1) {
      const itemId = this.assistantItemOrder[index];
      const text = itemId ? this.assistantTextByItem.get(itemId)?.trim() : "";
      if (text) {
        const missingImages = imageMarkdown.filter((line) => !text.includes(line));
        return missingImages.length ? `${text}\n\n${missingImages.join("\n")}` : text;
      }
    }
    return imageMarkdown.join("\n");
  }

  didStreamAssistantText(): boolean {
    return this.streamedAssistantText;
  }

  errorMessage(): string | undefined {
    return this.error;
  }

  usage(): UsageStats | undefined {
    return this.tokenUsage;
  }

  generatedImageCount(): number {
    return this.generatedImages.length;
  }

  private rememberAssistantItem(itemId: string): void {
    if (!itemId || this.assistantItemOrder.includes(itemId)) {
      return;
    }
    this.assistantItemOrder.push(itemId);
  }

  private rememberGeneratedImage(item: JsonObject & { id: string; type: string }): void {
    const status = readString(item, "status") ?? "";
    const hasImagePayload =
      Boolean(readString(item, "savedPath") ?? readString(item, "saved_path")) || Boolean(readString(item, "result"));
    if (status && status !== "completed" && !hasImagePayload) {
      return;
    }
    const src = persistCodexGeneratedImage(item);
    if (!src || this.generatedImages.some((image) => image.src === src)) {
      return;
    }
    const revisedPrompt = readString(item, "revisedPrompt") ?? readString(item, "revised_prompt");
    this.generatedImages.push({
      alt: revisedPrompt ? truncateImageAlt(revisedPrompt) : `Codex generated image ${this.generatedImages.length + 1}`,
      src,
    });
  }

  private withReasoningSummary(
    item: (JsonObject & { id: string; type: string }) | undefined,
  ): (JsonObject & { id: string; type: string }) | undefined {
    if (!item || item.type !== "reasoning") {
      return item;
    }
    const summaryText = this.reasoningSummaryTextByItem.get(item.id)?.trim() || readReasoningSummaryText(item);
    return summaryText ? { ...item, summaryText } : item;
  }

  private withElapsedMs(
    item: (JsonObject & { id: string; type: string }) | undefined,
    params: JsonObject,
  ): (JsonObject & { id: string; type: string }) | undefined {
    if (!item) {
      return item;
    }
    const elapsedMs = this.resolveElapsedMs(item.id, params);
    return elapsedMs !== undefined ? { ...item, elapsedMs } : item;
  }

  private resolveElapsedMs(itemId: string, params: JsonObject): number | undefined {
    const durationMs = readNumber(params, "durationMs");
    if (durationMs !== undefined && durationMs >= 0) {
      return durationMs;
    }
    const completedAtMs = readNumber(params, "completedAtMs");
    const startedAtMs = this.itemStartedAtMsByItem.get(itemId) ?? readNumber(params, "startedAtMs");
    if (completedAtMs !== undefined && startedAtMs !== undefined && completedAtMs >= startedAtMs) {
      return completedAtMs - startedAtMs;
    }
    return undefined;
  }

  private isForTurn(params: JsonObject, turnId: string): boolean {
    const notificationThreadId = readString(params, "threadId");
    const notificationTurnId = readString(params, "turnId");
    return (
      (!notificationThreadId || notificationThreadId === this.threadId) &&
      (turnId === "*" || !notificationTurnId || notificationTurnId === turnId)
    );
  }
}

function planUpdateFromDelta(params: JsonObject, planTextByItem: Map<string, string>): PlanningUpdate {
  const id = readString(params, "itemId") ?? readString(params, "id") ?? "plan";
  const delta =
    readString(params, "delta") ?? readString(params, "textDelta") ?? readString(params, "summaryDelta") ?? "";
  const explicitText = readString(params, "text") ?? readString(params, "plan") ?? "";
  const nextText = explicitText || `${planTextByItem.get(id) ?? ""}${delta}`;
  if (nextText) {
    planTextByItem.set(id, nextText);
  }
  return {
    id,
    title: readString(params, "title") ?? "Plan",
    text: nextText,
    status: readString(params, "status") ?? "updated",
    raw: params,
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId: "codex" },
  };
}

function planUpdateFromTurnPlan(params: JsonObject): PlanningUpdate {
  const rawSteps = Array.isArray(params.plan) ? params.plan : [];
  const steps = rawSteps
    .map((item) => (isJsonObject(item) ? item : undefined))
    .filter((item): item is JsonObject => Boolean(item))
    .map((item) => ({
      step: readString(item, "step") ?? "",
      status: readString(item, "status") ?? "pending",
    }))
    .filter((item) => item.step);
  const explanation = readString(params, "explanation");
  const stepText = steps.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`).join("\n");
  const text = [explanation, stepText].filter(Boolean).join("\n\n");
  return {
    id: readString(params, "turnId") ?? "turn-plan",
    title: "Plan",
    text,
    status: planStatus(steps),
    raw: params,
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId: "codex" },
  };
}

function planStatus(steps: Array<{ status: string }>): string {
  if (steps.some((item) => item.status === "inProgress")) {
    return "inProgress";
  }
  if (steps.length && steps.every((item) => item.status === "completed")) {
    return "completed";
  }
  return "updated";
}

function itemToReasoningStarted(
  runId: string,
  item: (JsonObject & { id: string; type: string }) | undefined,
): AgentEvent | undefined {
  if (item?.type !== "reasoning") return undefined;
  return {
    type: "reasoning.started",
    runId,
    reasoning: { id: item.id, kind: "summary", kernelId: "codex" },
  };
}

function itemToReasoningCompleted(
  runId: string,
  item: (JsonObject & { id: string; type: string }) | undefined,
): AgentEvent | undefined {
  if (item?.type !== "reasoning") return undefined;
  const elapsedMs = readNumber(item, "elapsedMs");
  return {
    type: "reasoning.completed",
    runId,
    reasoning: {
      id: item.id,
      kind: "summary",
      kernelId: "codex",
      text: readReasoningSummaryText(item),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    },
  };
}

function itemToToolStarted(
  runId: string,
  item: (JsonObject & { id: string; type: string }) | undefined,
): AgentEvent | undefined {
  if (!item || item.type === "dynamicToolCall" || item.type === "agentMessage" || item.type === "userMessage") {
    return undefined;
  }
  const toolId = codexItemToolId(item);
  if (!toolId) {
    return undefined;
  }
  return {
    type: "tool.started",
    runId,
    toolId,
    callId: item.id,
    input: item,
  };
}

function itemToToolFinished(
  runId: string,
  item: (JsonObject & { id: string; type: string }) | undefined,
): AgentEvent | undefined {
  if (!item || item.type === "dynamicToolCall" || item.type === "agentMessage" || item.type === "userMessage") {
    return undefined;
  }
  const toolId = codexItemToolId(item);
  if (!toolId) {
    return undefined;
  }
  const status = typeof item.status === "string" ? item.status : "completed";
  const value = item.type === "imageGeneration" ? sanitizeImageGenerationItem(item) : item;
  return {
    type: "tool.finished",
    runId,
    toolId,
    callId: item.id,
    result: {
      ok: status !== "failed" && status !== "declined",
      value,
      error: status === "failed" || status === "declined" ? status : undefined,
    },
  };
}

function sanitizeImageGenerationItem(item: JsonObject & { id: string; type: string }): JsonObject {
  const src = persistCodexGeneratedImage(item);
  const sanitized: JsonObject = {
    ...item,
    result: readString(item, "result") ? "[omitted image binary]" : "",
  };
  if (src) {
    sanitized.generatedSrc = src;
  }
  return sanitized;
}

function codexItemToolId(item: JsonObject & { type: string }): string | undefined {
  if (
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall" ||
    item.type === "webSearch" ||
    item.type === "collabToolCall" ||
    item.type === "imageView" ||
    item.type === "imageGeneration" ||
    item.type === "contextCompaction" ||
    item.type === "plan"
  ) {
    return `codex.${item.type}`;
  }
  return undefined;
}

function readAgentMessagePhase(item: JsonObject): string | undefined {
  return readString(item, "phase") ?? undefined;
}

function isFinalAgentMessagePhase(phase: string | undefined): boolean {
  return !phase || phase === "final_answer";
}

function readReasoningSummaryText(item: JsonObject): string {
  const directSummary =
    readString(item, "summaryText") ?? readString(item, "summary_text") ?? readString(item, "summary");
  if (directSummary?.trim()) {
    return directSummary.trim();
  }
  const summary = item.summary;
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .map((entry) => reasoningSummaryEntryText(entry))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function reasoningSummaryEntryText(entry: JsonValue): string {
  if (typeof entry === "string") {
    return entry.trim();
  }
  if (!isJsonObject(entry)) {
    return "";
  }
  return (
    readString(entry, "text") ??
    readString(entry, "summaryText") ??
    readString(entry, "summary_text") ??
    readString(entry, "message") ??
    ""
  ).trim();
}

function readItem(params: JsonObject): (JsonObject & { id: string; type: string }) | undefined {
  const item = isJsonObject(params.item) ? params.item : undefined;
  const id = item ? readString(item, "id") : undefined;
  const type = item ? readString(item, "type") : undefined;
  if (!item || !id || !type) {
    return undefined;
  }
  return { ...item, id, type };
}

function persistCodexGeneratedImage(item: JsonObject): string | undefined {
  const generatedRoot = resolve(process.cwd(), "data/generated");
  mkdirSync(generatedRoot, { recursive: true });
  const itemId = sanitizeGeneratedImageId(readString(item, "id") ?? `image_${Date.now()}`);
  const savedPath = readString(item, "savedPath") ?? readString(item, "saved_path");
  const extension = imageExtensionFromPath(savedPath) ?? "png";
  const filename = `codex-${itemId}.${extension}`;
  const outputPath = resolve(generatedRoot, filename);

  try {
    if (savedPath && existsSync(savedPath)) {
      copyFileSync(savedPath, outputPath);
      return `/generated/${filename}`;
    }

    const result = readString(item, "result");
    if (result && /^[A-Za-z0-9+/=\s]+$/.test(result)) {
      writeFileSync(outputPath, Buffer.from(result.replace(/\s+/g, ""), "base64"));
      return `/generated/${filename}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function sanitizeGeneratedImageId(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `image_${Date.now()}`
  );
}

function imageExtensionFromPath(value: string | undefined): "png" | "jpg" | "jpeg" | "webp" | undefined {
  const match = value?.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
  const ext = match?.[1];
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" ? ext : undefined;
}

function truncateImageAlt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function normalizeCodexUsage(params: JsonObject): UsageStats | undefined {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : params;
  const current = readFirstJsonObject(tokenUsage, ["last", "current", "lastCall", "lastCallUsage"]) ?? tokenUsage;
  const inputTokens =
    readNumberAlias(current, ["inputTokens", "input_tokens", "input", "promptTokens", "prompt_tokens"]) ?? undefined;
  const outputTokens =
    readNumberAlias(current, ["outputTokens", "output_tokens", "output", "completionTokens", "completion_tokens"]) ??
    undefined;
  const totalTokens =
    readNumberAlias(current, ["totalTokens", "total_tokens", "total"]) ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  // `tokenUsage.total` is lifetime/cumulative thread billing. `last` is the active
  // request context and therefore the only safe numerator for a context-window ring.
  const contextWindowSize =
    readNumberAlias(tokenUsage, ["modelContextWindow", "model_context_window", "contextWindow", "context_window"]) ??
    undefined;
  const contextUsedTokens = readNumberAlias(current, ["totalTokens", "total_tokens", "total"]) ?? undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    contextWindowSize === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
  };
}

function readFirstJsonObject(record: JsonObject, keys: string[]): JsonObject | undefined {
  for (const key of keys) {
    if (isJsonObject(record[key])) {
      return record[key] as JsonObject;
    }
  }
  return undefined;
}

function readNumberAlias(record: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}
