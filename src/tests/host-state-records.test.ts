import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import {
  agentEventSchema,
  artifactRecordSchema,
  listRunEventsOperation,
  parseHostOperationResponse,
  workingStateRecordSchema,
} from "#protocol";
import type { AgentEvent, ArtifactRecord, ContextEnvelope, WorkingStateRecord } from "../core.js";

const schemas: {
  event: z.ZodType<AgentEvent>;
  artifact: z.ZodType<ArtifactRecord>;
  workingState: z.ZodType<WorkingStateRecord>;
} = {
  event: agentEventSchema,
  artifact: artifactRecordSchema,
  workingState: workingStateRecordSchema,
};
function eventInput(event: AgentEvent): z.input<typeof agentEventSchema> {
  return event;
}

test("Protocol preserves native interaction continuations and arbitrary JSON event values", () => {
  const event: AgentEvent = {
    type: "approval.requested",
    runId: "run",
    request: {
      id: "approval",
      title: "Run command",
      kind: "command",
      reason: "Requested",
      status: "pending",
      createdAt: "now",
      updatedAt: "now",
      input: { nested: [null, true, { command: "echo test" }] },
      resume: { type: "kernel.native", kernelId: "codex", runId: "run", continuation: "same-loop" },
      nativeRequestId: "native-request",
      isBlocking: true,
    },
  };
  assert.deepEqual(schemas.event.parse(eventInput(event)), event);
  assert.equal(schemas.event.safeParse({ type: "unknown.event", runId: "run" }).success, false);
});

test("Host event responses preserve state and turn instructions in assembled context and model traces", () => {
  const context: ContextEnvelope = {
    id: "context",
    createdAt: "now",
    summary: "Room context",
    promptBlock: "User materials",
    items: [],
    budget: { maxItems: 8, usedItems: 0, maxCharacters: 6000, usedCharacters: 14, truncated: false },
    hostState: [
      { id: "room", text: "Room: design" },
      { id: "response-language", text: "" },
    ],
    turnInstructions: [{ id: "selected-skill", text: "Use the review skill for this Turn." }],
  };
  const events: AgentEvent[] = [
    { type: "context.assembled", runId: "run", context },
    {
      type: "model.requested",
      runId: "run",
      request: {
        systemPrompt: "Session rules",
        userInput: "Review this",
        context,
        tools: [],
        skills: [],
        packs: [],
        capabilities: [],
      },
    },
  ];
  const page = {
    ok: true,
    events,
    cursor: "2",
    oldestCursor: "1",
    hasMore: false,
    hasOlder: false,
    historyTruncated: false,
    resetRequired: false,
    longPollSupported: true,
    snapshot: true,
  };
  const { result } = parseHostOperationResponse(listRunEventsOperation, listRunEventsOperation.success.body, page);
  assert.ok(result.success);
  assert.deepEqual(result.data, page);

  const { hostState: _hostState, turnInstructions: _turnInstructions, ...legacyContext } = context;
  assert.deepEqual(agentEventSchema.parse({ type: "context.assembled", runId: "run", context: legacyContext }), {
    type: "context.assembled",
    runId: "run",
    context: legacyContext,
  });
  assert.equal(
    agentEventSchema.safeParse({
      type: "context.assembled",
      runId: "run",
      context: { ...context, turnInstructions: [{ id: "selected-skill", text: 42 }] },
    }).success,
    false,
  );
});
