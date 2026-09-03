import type { AgentEvent } from "./types.js";

const DURABLE_AGENT_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "turn.started",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
  "tool.started",
  "tool.finished",
  "run.cancel_requested",
  "assistant.final",
  "error",
  "turn.finished",
]);

const HIGH_FREQUENCY_AGENT_EVENT_TYPES = new Set<AgentEvent["type"]>(["assistant.delta", "tool.progress"]);

export interface AgentEventCheckpointPolicy {
  shouldCheckpoint(
    event: AgentEvent,
    options?: { now?: number; maxIntervalMs?: number; maxPendingEvents?: number },
  ): boolean;
}

/**
 * Semantic events define the recoverable Run state and must be checkpointed
 * promptly. High-frequency presentation events such as assistant.delta and
 * tool.progress may remain in memory until the next semantic checkpoint.
 */
export function isDurableAgentEvent(event: AgentEvent): boolean {
  return DURABLE_AGENT_EVENT_TYPES.has(event.type);
}

/**
 * Semantic events persist immediately. Streaming presentation events are
 * periodically materialized into the existing StateStore snapshot so a crash
 * loses only a bounded tail without introducing a second RunJournal.
 */
export function createAgentEventCheckpointPolicy(): AgentEventCheckpointPolicy {
  const checkpointsByRun = new Map<string, { persistedAt: number; pendingEvents: number }>();
  return {
    shouldCheckpoint(event, options = {}) {
      const now = options.now ?? Date.now();
      if (isDurableAgentEvent(event)) {
        if (event.type === "turn.finished") checkpointsByRun.delete(event.runId);
        else checkpointsByRun.set(event.runId, { persistedAt: now, pendingEvents: 0 });
        return true;
      }
      if (!HIGH_FREQUENCY_AGENT_EVENT_TYPES.has(event.type)) return false;

      const current = checkpointsByRun.get(event.runId) ?? { persistedAt: now, pendingEvents: 0 };
      const next = { persistedAt: current.persistedAt, pendingEvents: current.pendingEvents + 1 };
      const checkpointDue =
        now - current.persistedAt >= (options.maxIntervalMs ?? 5_000) ||
        next.pendingEvents >= (options.maxPendingEvents ?? 100);
      checkpointsByRun.set(event.runId, checkpointDue ? { persistedAt: now, pendingEvents: 0 } : next);
      return checkpointDue;
    },
  };
}
