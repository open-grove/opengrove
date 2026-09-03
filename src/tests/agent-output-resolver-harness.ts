import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantFinalEvent, resolveChatFinalAnswer, type AgentEvent, type AgentRuntime } from "../core.js";
import { hostMessage } from "../localization/host-messages.js";
import { createKernelRuntime, createRuntimeKernelAdapter } from "../kernel/adapter.js";

const runId = "run-agent-output-resolver";

const finalEvents: AgentEvent[] = [
  { type: "assistant.delta", runId, text: "working..." },
  { type: "tool.finished", runId, toolId: "room.ledger.read", result: { ok: true, value: { messages: [] } } },
  { type: "assistant.final", runId, text: "final answer", at: new Date(0).toISOString(), source: "runtime" },
];
assert.equal(resolveChatFinalAnswer(finalEvents), "final answer");

const multipleFinalEvents: AgentEvent[] = [
  { type: "assistant.final", runId, text: "first final", at: new Date(0).toISOString(), source: "runtime" },
  { type: "assistant.delta", runId, text: "ignored delta after first final" },
  { type: "assistant.final", runId, text: "second final", at: new Date(1).toISOString(), source: "runtime" },
];
assert.equal(resolveChatFinalAnswer(multipleFinalEvents), "second final");

const uncroppedFinalText = "我先读取记录。最终答案是 QA_LEDGER_FINAL_RAW_OK";
assert.equal(
  resolveChatFinalAnswer([
    { type: "assistant.delta", runId, text: "delta should stay out of the final answer" },
    { type: "assistant.final", runId, text: uncroppedFinalText, at: new Date(2).toISOString(), source: "runtime" },
  ]),
  uncroppedFinalText,
);

const noFinalEvents: AgentEvent[] = [
  { type: "assistant.delta", runId, text: "delta should not become the chat answer" },
  {
    type: "tool.finished",
    runId,
    toolId: "room.ledger.read",
    result: { ok: true, value: { messages: [{ text: "tool text" }] } },
  },
];
assert.equal(resolveChatFinalAnswer(noFinalEvents), hostMessage("en", "agent.final_missing"));
assert.equal(resolveChatFinalAnswer(noFinalEvents, { language: "zh-CN" }), hostMessage("zh-CN", "agent.final_missing"));
assert.equal(resolveChatFinalAnswer(noFinalEvents, { language: "en" }), hostMessage("en", "agent.final_missing"));
assert.doesNotMatch(resolveChatFinalAnswer(noFinalEvents), /delta should not become|tool text/);

const errorEvents: AgentEvent[] = [{ type: "error", runId, message: "room_not_found" }];
assert.equal(resolveChatFinalAnswer(errorEvents), hostMessage("en", "agent.run_failed"));
assert.equal(resolveChatFinalAnswer(errorEvents, { language: "zh-CN" }), hostMessage("zh-CN", "agent.run_failed"));
assert.equal(resolveChatFinalAnswer(errorEvents, { language: "en" }), hostMessage("en", "agent.run_failed"));

const synthesized = createAssistantFinalEvent(
  [
    { type: "assistant.delta", runId, text: "partial " },
    { type: "model.response", runId, response: { text: "model final" } },
  ],
  { runId, at: new Date(1).toISOString(), source: "adapter" },
);
assert.deepEqual(synthesized, {
  type: "assistant.final",
  runId,
  text: "model final",
  at: new Date(1).toISOString(),
  source: "adapter",
});

assert.deepEqual(
  createAssistantFinalEvent(
    [
      { type: "model.response", runId, response: { text: "first model final" } },
      { type: "model.response", runId, response: { text: "second model final" } },
    ],
    { runId, at: new Date(3).toISOString(), source: "adapter" },
  ),
  {
    type: "assistant.final",
    runId,
    text: "second model final",
    at: new Date(3).toISOString(),
    source: "adapter",
  },
);

assert.equal(createAssistantFinalEvent(finalEvents, { runId }), undefined);
assert.equal(
  createAssistantFinalEvent(
    [
      { type: "assistant.delta", runId, text: "partial text only" },
      {
        type: "tool.finished",
        runId,
        toolId: "room.ledger.read",
        result: { ok: true, value: { messages: [{ text: "tool-only candidate" }] } },
      },
    ],
    { runId },
  ),
  undefined,
);

const adapterRunId = "run-adapter-finalizer";
const adapterEvents: AgentEvent[] = [];
const mockRuntime: AgentRuntime = {
  async *runTurn(request) {
    const currentRunId = request.runId ?? adapterRunId;
    yield { type: "turn.started", runId: currentRunId, at: new Date(4).toISOString() };
    yield { type: "assistant.delta", runId: currentRunId, text: "streaming detail" };
    yield { type: "model.response", runId: currentRunId, response: { text: "adapter synthesized final" } };
    yield {
      type: "turn.finished",
      runId: currentRunId,
      at: new Date(5).toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  },
};
const adapter = createRuntimeKernelAdapter({
  id: "mock-finalizer",
  title: "Mock Finalizer",
  runtime: mockRuntime,
});
for await (const event of adapter.runTurn({
  input: "hello",
  runId: adapterRunId,
  context: { sessionId: "session-adapter-finalizer" },
  tools: [],
} as any)) {
  adapterEvents.push(event);
}
const adapterFinalEvents = adapterEvents.filter((event) => event.type === "assistant.final");
assert.equal(adapterFinalEvents.length, 1);
assert.equal(adapterFinalEvents[0]?.text, "adapter synthesized final");
assert.equal(adapterFinalEvents[0]?.source, "adapter");
assert.ok(
  adapterEvents.findIndex((event) => event.type === "assistant.final") <
    adapterEvents.findIndex((event) => event.type === "turn.finished"),
  "adapter should inject the final answer before turn.finished",
);

const runtimeFinalRunId = "run-runtime-final-no-duplicate";
const runtimeFinalEvents: AgentEvent[] = [];
const mockRuntimeWithFinal: AgentRuntime = {
  async *runTurn(request) {
    const currentRunId = request.runId ?? runtimeFinalRunId;
    yield { type: "turn.started", runId: currentRunId, at: new Date(6).toISOString() };
    yield {
      type: "assistant.final",
      runId: currentRunId,
      text: "runtime owned final",
      at: new Date(7).toISOString(),
      source: "runtime",
    };
    yield {
      type: "model.response",
      runId: currentRunId,
      response: { text: "model response should not duplicate final" },
    };
    yield {
      type: "turn.finished",
      runId: currentRunId,
      at: new Date(8).toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  },
};
const noDuplicateAdapter = createRuntimeKernelAdapter({
  id: "mock-runtime-final",
  title: "Mock Runtime Final",
  runtime: mockRuntimeWithFinal,
});
for await (const event of noDuplicateAdapter.runTurn({
  input: "hello",
  runId: runtimeFinalRunId,
  context: { sessionId: "session-runtime-final" },
  tools: [],
} as any)) {
  runtimeFinalEvents.push(event);
}
const runtimeOwnedFinals = runtimeFinalEvents.filter((event) => event.type === "assistant.final");
assert.equal(runtimeOwnedFinals.length, 1);
assert.equal(runtimeOwnedFinals[0]?.text, "runtime owned final");
assert.equal(runtimeOwnedFinals[0]?.source, "runtime");

const nativeNoOpCompactionRuntime: AgentRuntime = {
  async *runTurn() {
    return;
  },
  async compactSession() {
    return { ok: true, compacted: false };
  },
};
const compactRoundTrip = createKernelRuntime(
  createRuntimeKernelAdapter({
    id: "mock-native-compaction",
    title: "Mock Native Compaction",
    runtime: nativeNoOpCompactionRuntime,
  }),
);
assert.deepEqual(
  await compactRoundTrip.compactSession?.({ threadId: "native-no-op-session" }),
  { ok: true, compacted: false },
  "AgentRuntime -> KernelAdapter -> AgentRuntime must preserve a native no-op compaction result",
);

assertNoSourceMatches(
  ["src", "web/src", "package.json"],
  [
    "cleanRoomRunAnswer",
    "stripRoomProcessPrelude",
    "extractLedgerFullTextAnswer",
    "extractForcedLedgerFullTextAnswer",
    "extractOnlyReplyMarker",
    "extractOnlyReplyMarkers",
    "shouldSuppressRoomRunProcessParts",
    "roomRunVisibleAnswer",
  ],
  {
    excludeDirs: new Set(["src/tests"]),
  },
);

console.log("agent-output-resolver-harness ok");

function assertNoSourceMatches(roots: string[], needles: string[], options: { excludeDirs?: Set<string> } = {}): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = roots.flatMap((root) => sourceFiles(join(repoRoot, root), repoRoot, options.excludeDirs));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const needle of needles) {
      assert.equal(text.includes(needle), false, `${relativePath(file, repoRoot)} must not contain ${needle}`);
    }
  }
}

function sourceFiles(path: string, repoRoot: string, excludeDirs = new Set<string>()): string[] {
  const stat = statSync(path);
  const relative = relativePath(path, repoRoot);
  if (stat.isDirectory()) {
    if (excludeDirs.has(relative)) return [];
    return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry), repoRoot, excludeDirs));
  }
  return isTextSource(path) ? [path] : [];
}

function isTextSource(path: string): boolean {
  if (path.endsWith("package.json")) return true;
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].includes(extname(path));
}

function relativePath(path: string, repoRoot: string): string {
  return relative(repoRoot, path).replaceAll("\\", "/");
}
