#!/usr/bin/env node
// Deterministic process boundary for the Rooms integration test. Never used by the application.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const path = process.env.OPENGROVE_REMOTE_TEST_STATE;
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { tasks: {}, calls: [], memories: {} };
const args = process.argv.slice(2);
const command = args[2];
const sender = { id: "sender-id", owner: "@owner:example.test", address: "owner/sender@example.test", name: "sender" };
state.calls.push(args);
const save = () => writeFileSync(path, JSON.stringify(state));
let result;
if (command === "agent-current")
  result = { agent: { ...sender, id: state.changedSender ? "another-sender" : sender.id } };
else if (command === "connect") result = { status: "ready" };
else if (command === "agent-resolve") result = { address: args[3], matrixId: "@remote:example.test" };
else if (command === "send") {
  const option = (name) => args[args.indexOf(name) + 1];
  const messageId = option("--message-id");
  const contextId = args.includes("--context-id") ? option("--context-id") : "context-" + messageId;
  const text = args[args.indexOf("--") + 2] === "-" ? readFileSync(0, "utf8") : args[args.indexOf("--") + 2];
  if (!state.tasks[messageId]) {
    if (text.startsWith("remember:")) state.memories[contextId] = text.slice(9);
    const phase = text === "HOLD" ? "WORKING" : text === "INPUT" ? "INPUT_REQUIRED" : "COMPLETED";
    state.tasks[messageId] = {
      id: "task-" + messageId,
      contextId,
      status: { state: "TASK_STATE_" + phase },
      artifacts:
        phase === "WORKING"
          ? []
          : [{ parts: [{ text: text === "recall" ? state.memories[contextId] || "unknown" : "reply:" + text }] }],
    };
    // Simulate acceptance on the server followed by a lost HTTP/CLI response.
    if (text === "RECOVER") {
      save();
      process.exit(1);
    }
  }
  result = state.tasks[messageId];
} else if (command === "get" || command === "cancel") {
  result = Object.values(state.tasks).find((task) => task.id === args[4]);
  if (command === "cancel") result.status.state = "TASK_STATE_CANCELED";
} else throw new Error("unexpected_test_command:" + command);
save();
process.stdout.write(JSON.stringify(result));
