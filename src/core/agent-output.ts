import type { AgentEvent, AssistantFinalEvent, AssistantFinalSource } from "./types.js";
import { hostMessage } from "../localization/host-messages.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../localization/locale-registry.js";

export function createAssistantFinalEvent(
  events: AgentEvent[],
  options: {
    runId?: string;
    at?: string;
    source?: AssistantFinalSource;
  } = {},
): AssistantFinalEvent | undefined {
  if (events.some((event) => event.type === "assistant.final")) {
    return undefined;
  }
  const candidate = latestModelResponseText(events);
  if (!candidate.trim()) {
    return undefined;
  }
  const runId = options.runId || latestRunId(events);
  if (!runId) {
    return undefined;
  }
  return {
    type: "assistant.final",
    runId,
    text: candidate,
    at: options.at || new Date().toISOString(),
    source: options.source ?? "adapter",
  };
}

export function resolveChatFinalAnswer(events: AgentEvent[], options: { language?: SupportedLocale } = {}): string {
  const language = options.language ?? DEFAULT_LOCALE;
  const finalText = latestAssistantFinalText(events);
  if (finalText.trim()) {
    return finalText;
  }
  const errorText = collectRunErrorText(events);
  if (errorText) {
    return hostMessage(language, "agent.run_failed");
  }
  return hostMessage(language, "agent.final_missing");
}

export function latestAssistantFinalText(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant.final" && typeof event.text === "string" && event.text.trim()) {
      return event.text;
    }
  }
  return "";
}

export function latestModelResponseText(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "model.response" && typeof event.response.text === "string" && event.response.text.trim()) {
      return event.response.text;
    }
  }
  return "";
}

// 解析助手已产出的文本:优先 assistant.final,其次 model.response,最后拼接已吐出的
// assistant.delta。delta 兜底对"流式 runtime 被 abort 时只留下 delta,既无 model.response
// 也无 final"的取消场景尤其重要。群聊的 events 是多 run 累积的,传入 runId 时只拼该 run 的
// delta,避免混入上一轮的残留(/ask 单 run 场景可不传)。
export function collectAssistantText(events: AgentEvent[], runId?: string): string {
  const finalText = latestAssistantFinalText(events);
  if (finalText.trim()) {
    return finalText;
  }
  const modelText = latestModelResponseText(events);
  if (modelText.trim()) {
    return modelText;
  }
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "assistant.delta" }> =>
        event.type === "assistant.delta" && (!runId || event.runId === runId),
    )
    .map((event) => event.text)
    .join("");
}

export function collectRunErrorText(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "error" && typeof event.message === "string" && event.message.trim()) {
      return event.message.trim();
    }
  }
  return "";
}

export function hasRunError(events: AgentEvent[]): boolean {
  return Boolean(collectRunErrorText(events));
}

function latestRunId(events: AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runId = events[index]?.runId;
    if (typeof runId === "string" && runId.trim()) {
      return runId;
    }
  }
  return "";
}
