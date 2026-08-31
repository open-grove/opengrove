import type { AgentTurnRequest } from "./types.js";

/**
 * Preserve the full Host contract for runtimes that do not expose a distinct
 * native session-instructions channel.
 */
export function agentTurnHostContextPromptBlock(request: AgentTurnRequest): string {
  return [request.sessionInstructions?.trim(), request.assembledContext?.promptBlock?.trim()]
    .filter(Boolean)
    .join("\n\n");
}
