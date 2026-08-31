import type { AgentTurnRequest, ModelMessage, RunRecord } from "../core.js";

export function recentSessionMessages(request: AgentTurnRequest, limit = 6): ModelMessage[] {
  if (request.sessionHistoryMode === "native") {
    return [];
  }
  const runs = request.context.sessions?.listRuns?.({ sessionId: request.context.sessionId, limit: limit + 4 }) ?? [];
  const priorRuns = runs
    .filter((run) => run.id !== request.runId && (run.input.trim() || run.summary?.trim()))
    .reverse()
    .slice(-limit);

  const messages: ModelMessage[] = [];
  for (const run of priorRuns) {
    appendRunMessages(messages, run);
  }
  return messages;
}

export function recentSessionPromptBlock(request: AgentTurnRequest, limit = 6): string {
  const messages = recentSessionMessages(request, limit);
  if (!messages.length) return "";
  return [
    "Recent OpenGrove thread history:",
    ...messages.map((message) => {
      const speaker = message.role === "assistant" ? "Assistant" : "User";
      return `${speaker}: ${message.content}`;
    }),
  ].join("\n");
}

function appendRunMessages(messages: ModelMessage[], run: RunRecord): void {
  const input = compactText(run.input);
  if (input) {
    messages.push({ role: "user", content: input });
  }
  const summary = compactText(run.summary);
  if (summary) {
    messages.push({ role: "assistant", content: summary });
  }
}

function compactText(value: string | undefined): string {
  const text = value?.trim() ?? "";
  return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
}
