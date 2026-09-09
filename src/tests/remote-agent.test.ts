import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRouterClient, remoteTaskText } from "../server/remote-agents/client.js";

test("remote calls keep explicit sender identity and carry stable conversation and message IDs", async () => {
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  const client = new AgentRouterClient("test", async (args, input) => {
    calls.push([...args]);
    inputs.push(input);
    if (args.includes("agent-current"))
      return {
        agent: { id: "sender-id", owner: "@owner:example.test", address: "owner/sender@example.test", name: "sender" },
      };
    return {
      id: "task-1",
      contextId: "context-1",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "answer" }] }],
    };
  });
  await client.verifySender("sender-id");
  const result = await client.send("owner/coder@example.test", "--help", "context-1", "message-1");
  assert.deepEqual(calls[1], [
    "--profile",
    "test",
    "send",
    "--context-id",
    "context-1",
    "--message-id",
    "message-1",
    "--",
    "owner/coder@example.test",
    "-",
  ]);
  assert.equal(inputs[1], "--help");
  assert.equal(remoteTaskText(result), "answer");
  await assert.rejects(client.verifySender("another-sender"), /remote_sender_changed/);
});
