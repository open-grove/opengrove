import assert from "node:assert/strict";
import type { AgentEvent } from "../core.js";
import { AsyncEventQueue } from "../runtime/codex/async-event-queue.js";
import { CodexEventProjector } from "../runtime/codex/event-projector.js";

const queue = new AsyncEventQueue<AgentEvent>();
const projector = new CodexEventProjector("run-projector", "thread-projector", queue);

const completed = projector.handleNotification(
  {
    method: "item/completed",
    params: {
      threadId: "thread-projector",
      turnId: "turn-projector",
      item: {
        id: "assistant-final",
        type: "agentMessage",
        text: "PROJECTOR_FINAL_OK",
      },
    },
  },
  "turn-projector",
);

assert.equal(completed, false, "agent message completion should not pretend the whole turn is finished");

queue.close();
const projectedEvents: AgentEvent[] = [];
for await (const event of queue) projectedEvents.push(event);
assert.equal(
  projectedEvents.some((event) => event.type === "model.response"),
  false,
  "The projector records native items; the outer runtime owns the single terminal model.response.",
);
assert.equal(projector.finalText(), "PROJECTOR_FINAL_OK");

{
  const queue = new AsyncEventQueue<AgentEvent>();
  const projector = new CodexEventProjector("run-commentary", "thread-projector", queue);
  projector.handleNotification(
    {
      method: "item/started",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        item: {
          id: "assistant-commentary",
          type: "agentMessage",
          phase: "commentary",
        },
      },
    },
    "turn-projector",
  );
  projector.handleNotification(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        itemId: "assistant-commentary",
        delta: "NATIVE ",
      },
    },
    "turn-projector",
  );
  projector.handleNotification(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        itemId: "assistant-commentary",
        delta: "COMMENTARY",
      },
    },
    "turn-projector",
  );
  projector.handleNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        item: {
          id: "assistant-commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "NATIVE COMMENTARY",
        },
      },
    },
    "turn-projector",
  );

  const iterator = queue[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "assistant.status");
  assert.equal(first.value.text, "NATIVE COMMENTARY");
  assert.deepEqual(first.value.data, {
    source: "codex",
    kind: "agent_message",
    phase: "commentary",
    itemId: "assistant-commentary",
  });
  assert.equal(projector.didStreamAssistantText(), false);
  assert.equal(projector.finalText(), "");
}

{
  const queue = new AsyncEventQueue<AgentEvent>();
  const projector = new CodexEventProjector("run-reasoning", "thread-projector", queue);
  projector.handleNotification(
    {
      method: "item/started",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        startedAtMs: 1_000_000,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          status: "inProgress",
        },
      },
    },
    "turn-projector",
  );
  projector.handleNotification(
    {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        itemId: "reasoning-1",
        delta: "Checked native event phases.",
      },
    },
    "turn-projector",
  );
  projector.handleNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-projector",
        turnId: "turn-projector",
        completedAtMs: 1_008_000,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          status: "completed",
        },
      },
    },
    "turn-projector",
  );

  const iterator = queue[Symbol.asyncIterator]();
  const started = await iterator.next();
  assert.equal(started.done, false);
  assert.equal(started.value.type, "reasoning.started");
  assert.equal((started.value as unknown as { reasoning: { id: string } }).reasoning.id, "reasoning-1");
  const finished = await iterator.next();
  assert.equal(finished.done, false);
  assert.equal(finished.value.type, "reasoning.completed");
  const reasoning = (
    finished.value as unknown as {
      reasoning: { id: string; kind: string; kernelId: string; text: string; elapsedMs?: number };
    }
  ).reasoning;
  assert.equal(reasoning.id, "reasoning-1");
  assert.equal(reasoning.kind, "summary");
  assert.equal(reasoning.kernelId, "codex");
  assert.equal(reasoning.text, "Checked native event phases.");
  // Per-reasoning elapsed time is captured from item/started + item/completed timestamps.
  assert.equal(reasoning.elapsedMs, 8000);
}

{
  // durationMs on item/completed takes precedence over recomputing from timestamps.
  const queue = new AsyncEventQueue<AgentEvent>();
  const projector = new CodexEventProjector("run-duration", "thread-duration", queue);
  projector.handleNotification(
    {
      method: "item/started",
      params: {
        threadId: "thread-duration",
        turnId: "turn-duration",
        startedAtMs: 500,
        item: { id: "cmd-1", type: "commandExecution", status: "inProgress" },
      },
    },
    "turn-duration",
  );
  projector.handleNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-duration",
        turnId: "turn-duration",
        durationMs: 4200,
        completedAtMs: 999_999,
        item: { id: "cmd-1", type: "commandExecution", status: "completed" },
      },
    },
    "turn-duration",
  );

  const iterator = queue[Symbol.asyncIterator]();
  await iterator.next();
  const finished = await iterator.next();
  assert.equal((finished.value.result.value as any).elapsedMs, 4200);
}

{
  // Context-window denominator + used tokens flow from thread/tokenUsage/updated into the
  // model.response usage, so the composer can render a usage ring. Shape mirrors the real
  // Codex RPC capture: tokenUsage.last is the active request context while total is
  // lifetime billing and must not drive the context-window ring.
  const queue = new AsyncEventQueue<AgentEvent>();
  const projector = new CodexEventProjector("run-usage", "thread-usage", queue);
  projector.handleNotification(
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        tokenUsage: {
          total: { totalTokens: 248971, inputTokens: 248678, outputTokens: 293 },
          last: { totalTokens: 48971, inputTokens: 48678, outputTokens: 293 },
          modelContextWindow: 258400,
        },
      },
    },
    "turn-usage",
  );
  projector.handleNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        item: { id: "assistant-usage", type: "agentMessage", text: "USAGE_OK" },
      },
    },
    "turn-usage",
  );

  const usage = projector.usage();
  assert.equal(usage?.contextWindowSize, 258400, "context-window denominator must survive normalization");
  assert.equal(usage?.contextUsedTokens, 48971, "last request tokens must be captured as active context usage");
}

console.log("codex-event-projector-harness ok");
