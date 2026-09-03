import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentEvent } from "../core.js";
import { GenericCliRuntime } from "../runtime/generic-cli-runtime.js";

const cwd = mkdtempSync(join(tmpdir(), "opengrove-generic-cli-cancel-"));
const producer = join(cwd, "partial-producer.mjs");
const readyMarker = join(cwd, "partial-ready");
writeFileSync(
  producer,
  [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyMarker)}, 'ready');`,
    "process.stdout.write('partial generic output');",
    "setInterval(() => {}, 1_000);",
  ].join("\n"),
  "utf8",
);

const runtime = new GenericCliRuntime({
  kernelId: "generic-harness",
  title: "Generic harness",
  command: process.execPath,
  args: [producer],
  cwd,
});
const controller = new AbortController();
const events: AgentEvent[] = [];
const abortPoll = setInterval(() => {
  if (existsSync(readyMarker)) controller.abort("user canceled");
}, 5);
for await (const event of runtime.runTurn({
  runId: "run-generic-cli-canceled-partial",
  input: "produce a partial response",
  context: { sessionId: "generic-cli-canceled-partial", activity: "chat" } as AgentContext,
  tools: [],
  skills: [],
  packs: [],
  capabilities: [],
  signal: controller.signal,
})) {
  events.push(event);
}
clearInterval(abortPoll);

assert.ok(
  events.some((event) => event.type === "assistant.final" && event.text === "partial generic output"),
  "a canceled generic CLI should preserve its partial text",
);
assert.equal(
  events.some((event) => event.type === "model.response"),
  false,
  "partial canceled output must not become a successful model.response",
);
assert.ok(events.some((event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_CANCELED"));

console.log("✓ generic CLI cancellation preserves partial output without fabricating success");
