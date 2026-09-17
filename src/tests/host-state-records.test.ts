import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import { agentEventSchema, artifactRecordSchema, workingStateRecordSchema } from "#protocol";
import type { AgentEvent, ArtifactRecord, WorkingStateRecord } from "../core.js";

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
