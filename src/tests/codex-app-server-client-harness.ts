import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  buildCodexAppServerEnv,
  CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS,
} from "../runtime/codex/app-server-client.js";
import { handleCodexApprovalRequest, matchesCurrentCodexTurn } from "../runtime/codex/approval-bridge.js";
import { AsyncEventQueue } from "../runtime/codex/async-event-queue.js";
import {
  codexRuntimeBindingFingerprint,
  codexThreadConfig,
  readCodexModelContextWindow,
  shouldExposeCodexDynamicTools,
} from "../runtime/codex-runtime.js";
import { CodexRuntime } from "../runtime/codex-runtime.js";
import {
  estimateTextTokens,
  hardContextWindowExceeded,
  resolveContextTokenBudget,
} from "../runtime/context-token-budget.js";
import {
  CODEX_OPTIONAL_DISABLE_FEATURE_FLAGS,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  stripDisableFeatureFlags,
  unknownCodexFeatureFlagsFromStderr,
} from "../runtime/codex/types.js";
import type { AgentEvent, AgentTurnRequest } from "../core.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import { inspectAgentTurnEvents } from "./harnesses/kernel-event-contract.js";

const optOutMethods: readonly string[] = CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS;

const canceledApprovalRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-canceled-approval-`);
const canceledApprovalApp = createOpenGrove({
  cwd: canceledApprovalRoot,
  readPage: async () => ({}),
  runtime: { async *runTurn() {} },
});
const canceledApprovalController = new AbortController();
const canceledApprovalQueue = new AsyncEventQueue<AgentEvent>();
const canceledApprovalResponse = handleCodexApprovalRequest(
  {
    id: "native-canceled-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-canceled-approval",
      turnId: "turn-canceled-approval",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  },
  {
    threadId: "thread-canceled-approval",
    turnId: "turn-canceled-approval",
    runId: "run-canceled-approval",
    request: {
      runId: "run-canceled-approval",
      input: "cancel the native request",
      context: {
        sessionId: "session-canceled-approval",
        activity: "chat",
        memory: canceledApprovalApp.memory,
        artifacts: canceledApprovalApp.artifacts,
        skills: canceledApprovalApp.skills,
        packs: canceledApprovalApp.packs,
        sessions: canceledApprovalApp.sessions,
        executions: canceledApprovalApp.executions,
        workingState: canceledApprovalApp.workingState,
        approvals: canceledApprovalApp.approvals,
        questions: canceledApprovalApp.questions,
      },
      tools: [],
      signal: canceledApprovalController.signal,
    },
    queue: canceledApprovalQueue,
  },
);
canceledApprovalController.abort();
assert.deepEqual(
  await canceledApprovalResponse,
  { decision: "cancel" },
  "a system-canceled native approval must preserve Codex cancel instead of collapsing to decline",
);
assert.equal(
  matchesCurrentCodexTurn({ threadId: "thread-owned", turnId: "turn-owned" }, "thread-owned", "turn-owned"),
  true,
);
assert.equal(
  matchesCurrentCodexTurn({ threadId: "thread-other", turnId: "turn-owned" }, "thread-owned", "turn-owned"),
  false,
  "a request from a sibling Run must not be claimed by the first registered handler",
);
assert.equal(
  matchesCurrentCodexTurn({ turnId: "turn-owned" }, "thread-owned", "turn-owned"),
  false,
  "an unscoped native request must fail closed on a shared app-server",
);

assert.equal(
  optOutMethods.includes("item/agentMessage/delta"),
  false,
  "Codex assistant message deltas must stay enabled so OpenGrove can stream assistant text.",
);
assert.equal(
  codexThreadConfig(undefined, { contextTokenBudget: 150_000 }).model_auto_compact_token_limit,
  150_000,
  "Codex thread/start and thread/resume config must receive the native auto-compact limit.",
);
assert.equal(
  "model_auto_compact_token_limit" in codexThreadConfig(undefined),
  false,
  "An undeclared employee budget must preserve Codex's native default compaction behavior.",
);
assert.equal(
  codexThreadConfig(undefined, { reasoningEffort: "xhigh", reasoningSummary: "detailed" }).model_reasoning_summary,
  "detailed",
  "Codex reasoning turns must request the readable summary surface that OpenGrove projects as diagnostics.",
);
assert.equal(
  "model_reasoning_summary" in codexThreadConfig(undefined),
  false,
  "Turns without an explicit reasoning request must preserve Codex's native summary default.",
);
assert.deepEqual(
  resolveContextTokenBudget(150_000, 128_000),
  {
    requestedBudget: 150_000,
    effectiveBudget: 128_000,
    modelContextWindow: 128_000,
    budgetSource: "configured",
  },
  "The model's confirmed context window must cap the employee budget.",
);
assert.deepEqual(
  resolveContextTokenBudget(undefined, 128_000),
  {
    modelContextWindow: 128_000,
    budgetSource: "unconfigured",
  },
  "An undeclared budget must preserve only the model-window fact, not invent a product budget.",
);
assert.equal(resolveContextTokenBudget(undefined, 1_000_000).effectiveBudget, undefined);
assert.deepEqual(resolveContextTokenBudget(undefined), { budgetSource: "unconfigured" });
assert.equal(hardContextWindowExceeded(160_000, resolveContextTokenBudget(150_000, 200_000)), false);
assert.equal(hardContextWindowExceeded(200_000, resolveContextTokenBudget(150_000, 200_000)), true);
assert.equal(
  estimateTextTokens("abc中文한글😀"),
  6,
  "token estimation should handle Latin, CJK, and astral UTF-8 without regexes",
);

const codexModelCacheHome = mkdtempSync(`${tmpdir()}/opengrove-codex-model-cache-`);
writeFileSync(
  join(codexModelCacheHome, "models_cache.json"),
  JSON.stringify({
    models: [{ slug: "gpt-test-small", context_window: 128_000 }],
  }),
);
assert.equal(
  readCodexModelContextWindow("gpt-test-small", { CODEX_HOME: codexModelCacheHome }),
  128_000,
  "Codex should derive an undeclared budget from its own selected-model cache before the first turn.",
);
assert.equal(
  optOutMethods.includes("command/exec/outputDelta"),
  true,
  "High-volume command output deltas should remain opted out unless the UI consumes them directly.",
);
assert.equal(
  optOutMethods.includes("item/reasoning/summaryTextDelta"),
  false,
  "Codex reasoning summary deltas should stay enabled so OpenGrove can display native safe reasoning summaries.",
);
assert.equal(
  optOutMethods.includes("item/reasoning/textDelta"),
  true,
  "Raw Codex reasoning text deltas must stay opted out; only safe summaries may be displayed.",
);

const codexCommand = `${mkdtempSync(`${tmpdir()}/opengrove-codex-path-`)}/codex`;
writeFileSync(codexCommand, "#!/usr/bin/env sh\necho codex-test\n", "utf8");
chmodSync(codexCommand, 0o755);
const runtimeEnv = buildCodexAppServerEnv(codexCommand, {
  PATH: ["/usr/bin", "/bin", "/usr/bin"].join(delimiter),
});
const pathEntries = runtimeEnv.PATH?.split(delimiter) ?? [];

assert.deepEqual(pathEntries.slice(0, 2), ["/usr/bin", "/bin"], "Existing runtime PATH order should be preserved.");
assert.equal(
  pathEntries.filter((entry) => entry === "/usr/bin").length,
  1,
  "PATH augmentation should de-duplicate existing entries.",
);
assert.equal(
  pathEntries.includes(dirname(codexCommand)),
  true,
  "Codex app-server PATH should include the Codex resource directory so bundled tools such as rg are visible.",
);

assert.equal(
  shouldExposeCodexDynamicTools({
    input: "Plain request without dynamic-tool keywords.",
    context: {} as AgentTurnRequest["context"],
    tools: [
      {
        spec: {
          id: "host.echo",
          title: "Host Echo",
          description: "Echo host input.",
          activity: "local",
          risk: "read",
          input: { type: "json-schema", schema: { type: "object", properties: {} } },
          permission: { mode: "allow", reason: "Harness tool." },
        },
        async execute() {
          return { ok: true };
        },
      },
    ],
  }),
  true,
  "Explicit OpenGrove tools must be exposed to Codex even when the prompt does not match heuristic keywords.",
);

assert.equal(
  shouldExposeCodexDynamicTools({
    input: "Plain request with an explicit tool but dynamic tools disabled.",
    context: {} as AgentTurnRequest["context"],
    dynamicToolsMode: "disabled",
    tools: [
      {
        spec: {
          id: "host.echo",
          title: "Host Echo",
          description: "Echo host input.",
          activity: "local",
          risk: "read",
          input: { type: "json-schema", schema: { type: "object", properties: {} } },
          permission: { mode: "allow", reason: "Harness tool." },
        },
        async execute() {
          return { ok: true };
        },
      },
    ],
  }),
  false,
  "Codex dynamic tools must stay hidden when the request explicitly disables them.",
);

// Version-adaptive feature flags: defaults carry the optional `--disable` flag so older
// Codex builds that still need it keep working; the fallback drops it when a newer build
// rejects it. The real stderr below was captured from codex-cli 0.138.0-alpha.7.
assert.equal(
  DEFAULT_CODEX_APP_SERVER_ARGS.includes("responses_websocket_response_processed"),
  true,
  "Default args must keep the optional disable flag so older Codex builds still suppress the feature.",
);
const realUnknownFlagStderr =
  "WARNING: proceeding...\nError: Unknown feature flag: responses_websocket_response_processed\n";
assert.deepEqual(
  unknownCodexFeatureFlagsFromStderr(realUnknownFlagStderr),
  ["responses_websocket_response_processed"],
  "Unknown feature flag names must be parsed from Codex app-server stderr.",
);
assert.deepEqual(
  unknownCodexFeatureFlagsFromStderr("codex app-server exited normally\n"),
  [],
  "Clean stderr must not report any rejected feature flags.",
);
const strippedArgs = stripDisableFeatureFlags(DEFAULT_CODEX_APP_SERVER_ARGS, [...CODEX_OPTIONAL_DISABLE_FEATURE_FLAGS]);
assert.equal(
  strippedArgs.includes("responses_websocket_response_processed"),
  false,
  "Rejected feature flags must be removed before retrying the launch.",
);
assert.equal(
  strippedArgs.includes("responses_websockets") && strippedArgs.includes("responses_websockets_v2"),
  true,
  "Stripping a rejected flag must not remove the other --disable flags.",
);
assert.deepEqual(
  strippedArgs.slice(-2),
  ["--listen", "stdio://"],
  "Stripping must preserve the listen transport arguments.",
);
assert.equal(
  stripDisableFeatureFlags(DEFAULT_CODEX_APP_SERVER_ARGS, []),
  DEFAULT_CODEX_APP_SERVER_ARGS,
  "Stripping nothing must return the same array reference so callers can detect a no-op.",
);

assert.equal(
  codexRuntimeBindingFingerprint({
    base: "binding",
    model: "gpt-5",
    modelProvider: "openai",
    dynamicToolsFingerprint: "tools",
    developerInstructionsFingerprint: "instructions",
    cwd: "/workspace",
    runtimeEnvFingerprint: "env",
  }),
  "binding:openai:tools:instructions:/workspace:normal:env",
  "Static developer-instruction changes must rotate an existing Codex binding.",
);

const compactHarnessRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-compact-`);
const compactServerPath = join(compactHarnessRoot, "fake-codex-app-server.mjs");
const compactStatePath = join(compactHarnessRoot, "bindings.json");
writeFileSync(
  compactServerPath,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli/99.0.0" } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: "native-compact-thread" } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: { turn: { id: "compact-turn" } } });
    queueMicrotask(() => {
      send({ method: "item/started", params: { threadId: "native-compact-thread", turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction", status: "inProgress" } } });
      send({ method: "item/completed", params: { threadId: "native-compact-thread", turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction", status: "completed", summary: "compact ok" } } });
      send({ method: "turn/completed", params: { threadId: "native-compact-thread", turn: { id: "compact-turn", status: "completed", items: [{ id: "compact-item", type: "contextCompaction", status: "completed", summary: "compact ok" }] } } });
    });
    return;
  }
});
`,
  "utf8",
);
writeFileSync(
  compactStatePath,
  JSON.stringify({
    "compact-harness:native": {
      threadId: "native-compact-thread",
      dynamicToolsFingerprint: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }),
  "utf8",
);
const compactRuntime = new CodexRuntime({
  command: process.execPath,
  args: [compactServerPath],
  statePath: compactStatePath,
  requestTimeoutMs: 2_000,
});
assert.deepEqual(
  await compactRuntime.compactSession({ threadId: "compact-harness", reason: "harness" }),
  { ok: true, compacted: true },
  "Codex compactSession must use the official thread/compact/start lifecycle and observe contextCompaction completion.",
);
compactRuntime.close();

const wrongThreadCompactRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-compact-thread-filter-`);
const wrongThreadCompactServerPath = join(wrongThreadCompactRoot, "fake-codex-app-server.mjs");
const wrongThreadCompactStatePath = join(wrongThreadCompactRoot, "bindings.json");
writeFileSync(
  wrongThreadCompactServerPath,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli/99.0.0" } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: "expected-thread" } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: { turn: { id: "expected-compact-turn" } } });
    send({ method: "thread/compacted", params: { threadId: "other-thread" } });
    setTimeout(() => {
      const item = { id: "expected-item", type: "contextCompaction", status: "completed", summary: "expected compact" };
      send({ method: "item/completed", params: { threadId: "expected-thread", turnId: "expected-compact-turn", item } });
      send({ method: "turn/completed", params: { threadId: "expected-thread", turn: { id: "expected-compact-turn", status: "completed", items: [item] } } });
    }, 40);
  }
});
`,
  "utf8",
);
writeFileSync(
  wrongThreadCompactStatePath,
  JSON.stringify({
    "compact-filter:native": {
      threadId: "expected-thread",
      dynamicToolsFingerprint: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }),
  "utf8",
);
const wrongThreadCompactRuntime = new CodexRuntime({
  command: process.execPath,
  args: [wrongThreadCompactServerPath],
  statePath: wrongThreadCompactStatePath,
  requestTimeoutMs: 1_000,
});
const wrongThreadCompactStartedAt = Date.now();
assert.deepEqual(
  await wrongThreadCompactRuntime.compactSession({ threadId: "compact-filter", reason: "thread filter" }),
  { ok: true, compacted: true },
);
assert.ok(
  Date.now() - wrongThreadCompactStartedAt >= 30,
  "thread/compacted from another shared-client thread must not complete this compact operation",
);
wrongThreadCompactRuntime.close();

const producerLostRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-producer-lost-`);
const producerLostServerPath = join(producerLostRoot, "fake-codex-app-server.mjs");
writeFileSync(
  producerLostServerPath,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli/99.0.0" } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "producer-lost-thread" }, model: "gpt-test" } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "producer-lost-turn" } } });
    setTimeout(() => process.exit(23), 20);
  }
});
`,
  "utf8",
);
const producerLostApp = createOpenGrove({
  cwd: producerLostRoot,
  readPage: async () => ({}),
  runtime: { async *runTurn() {} },
});
const producerLostRuntime = new CodexRuntime({
  command: process.execPath,
  args: [producerLostServerPath],
  statePath: join(producerLostRoot, "bindings.json"),
  cwd: producerLostRoot,
  configuredModel: "gpt-test",
  requestTimeoutMs: 1_000,
});
const producerLostEvents = await Promise.race([
  (async () => {
    const events: AgentEvent[] = [];
    for await (const event of producerLostRuntime.runTurn({
      runId: "run-producer-lost",
      input: "wait for producer loss",
      context: {
        sessionId: "session-producer-lost",
        activity: "chat",
        memory: producerLostApp.memory,
        artifacts: producerLostApp.artifacts,
        skills: producerLostApp.skills,
        packs: producerLostApp.packs,
        sessions: producerLostApp.sessions,
        executions: producerLostApp.executions,
        workingState: producerLostApp.workingState,
        approvals: producerLostApp.approvals,
        questions: producerLostApp.questions,
      },
      tools: [],
    }))
      events.push(event);
    return events;
  })(),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("producer_lost_run_hung")), 2_000)),
]);
producerLostRuntime.close();
assert.ok(
  producerLostEvents.some(
    (event) => event.type === "error" && event.message.includes("codex_app_server_producer_lost"),
  ),
);
assert.ok(
  producerLostEvents.some(
    (event) =>
      event.type === "turn.finished" &&
      event.outcome.taskState === "TASK_STATE_FAILED" &&
      event.outcome.reasonCode === "codex_runtime_failed",
  ),
  "app-server loss after turn/start ACK must deterministically close the Run",
);

const terminalHarnessRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-terminal-`);
const terminalServerPath = join(terminalHarnessRoot, "fake-codex-app-server.mjs");
const terminalStatePath = join(terminalHarnessRoot, "bindings.json");
writeFileSync(
  terminalServerPath,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let threadStartCount = 0;
let turnCount = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli/99.0.0" } });
  if (message.method === "thread/start") {
    threadStartCount += 1;
    if (threadStartCount > 1) return send({ id: message.id, error: { code: -32000, message: "unexpected second thread/start" } });
    const developerInstructions = message.params?.developerInstructions ?? "";
    if (!developerInstructions.includes("STABLE_EMPLOYEE_IDENTITY")) {
      return send({ id: message.id, error: { code: -32000, message: "stable session instructions missing from thread/start" } });
    }
    if (developerInstructions.includes("FIRST_ROOM_CONTEXT") || developerInstructions.includes("SECOND_ROOM_CONTEXT")) {
      return send({ id: message.id, error: { code: -32000, message: "mutable room context leaked into thread/start" } });
    }
    return send({ id: message.id, result: { thread: { id: "terminal-thread" }, model: "gpt-test" } });
  }
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: "terminal-thread" }, model: "gpt-test" } });
  if (message.method === "turn/start") {
    turnCount += 1;
    const turnId = "terminal-turn-" + turnCount;
    const inputText = message.params?.input?.find?.((item) => item.type === "text")?.text ?? "";
    const expectedRoomContext = turnCount === 1 ? "FIRST_ROOM_CONTEXT" : "SECOND_ROOM_CONTEXT";
    if (!inputText.includes(expectedRoomContext) || inputText.includes("STABLE_EMPLOYEE_IDENTITY")) {
      return send({ id: message.id, error: { code: -32000, message: "incorrect session/turn instruction projection" } });
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    queueMicrotask(() => {
      const item = { id: "terminal-answer-" + turnCount, type: "agentMessage", phase: "final_answer", text: "CODEX_SINGLE_TERMINAL_OK" };
      send({ method: "item/completed", params: { threadId: "terminal-thread", turnId, item } });
      send({ method: "turn/completed", params: { threadId: "terminal-thread", turn: { id: turnId, status: "completed", items: [item] } } });
    });
  }
});
`,
  "utf8",
);
const terminalApp = createOpenGrove({
  cwd: terminalHarnessRoot,
  readPage: async () => ({}),
  runtime: {
    async *runTurn() {
      return;
    },
  },
});
const terminalRuntime = new CodexRuntime({
  command: process.execPath,
  args: [terminalServerPath],
  statePath: terminalStatePath,
  cwd: terminalHarnessRoot,
  configuredModel: "gpt-test",
  requestTimeoutMs: 2_000,
});
const terminalContext: AgentTurnRequest["context"] = {
  sessionId: "codex-terminal-session",
  activity: "chat",
  memory: terminalApp.memory,
  artifacts: terminalApp.artifacts,
  skills: terminalApp.skills,
  packs: terminalApp.packs,
  sessions: terminalApp.sessions,
  executions: terminalApp.executions,
  workingState: terminalApp.workingState,
  approvals: terminalApp.approvals,
  questions: terminalApp.questions,
};
const terminalEvents: AgentEvent[] = [];
for await (const event of terminalRuntime.runTurn({
  runId: "codex-terminal-run",
  input: "Return the marker.",
  context: terminalContext,
  sessionInstructions: "Employee identity: STABLE_EMPLOYEE_IDENTITY",
  assembledContext: {
    id: "first-room-context",
    createdAt: new Date().toISOString(),
    summary: "first room context",
    promptBlock: "FIRST_ROOM_CONTEXT",
    items: [],
    budget: { maxCharacters: 1_000, usedCharacters: 18, maxItems: 10, usedItems: 1, truncated: false },
  },
  tools: [],
}))
  terminalEvents.push(event);
const resumedTerminalEvents: AgentEvent[] = [];
try {
  for await (const event of terminalRuntime.runTurn({
    runId: "codex-terminal-resume-run",
    input: "Return the marker again.",
    context: terminalContext,
    sessionInstructions: "Employee identity: STABLE_EMPLOYEE_IDENTITY",
    assembledContext: {
      id: "second-room-context",
      createdAt: new Date().toISOString(),
      summary: "second room context",
      promptBlock: "SECOND_ROOM_CONTEXT",
      items: [],
      budget: { maxCharacters: 1_000, usedCharacters: 19, maxItems: 10, usedItems: 1, truncated: false },
    },
    tools: [],
  }))
    resumedTerminalEvents.push(event);
} catch (error) {
  assert.fail(`Changing per-turn Room context must resume the existing Codex thread: ${String(error)}`);
}
terminalRuntime.close();
assert.doesNotThrow(() => JSON.parse(readFileSync(terminalStatePath, "utf8")));
assert.equal(
  readdirSync(terminalHarnessRoot).some((name) => name.includes("bindings.json.") && name.endsWith(".tmp")),
  false,
  "crash-safe binding writes must not leave temporary files after success",
);
const terminalInspection = inspectAgentTurnEvents(terminalEvents);
assert.equal(terminalInspection.modelResponseCount, 1, "Codex must emit exactly one terminal model.response");
assert.equal(terminalInspection.assistantTextMatchesResponse, true);
assert.equal(terminalInspection.lifecycleClosedExactlyOnce, true);
assert.equal(
  resumedTerminalEvents.some((event) => event.type === "error"),
  false,
  "Changing per-turn Room context must resume the existing Codex thread instead of starting another one.",
);

const concurrencyRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-concurrency-`);
const concurrencyServerPath = join(concurrencyRoot, "fake-codex-app-server.mjs");
writeFileSync(
  concurrencyServerPath,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let threadStartCount = 0;
let turnCount = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli/99.0.0" } });
  if (message.method === "thread/start") {
    threadStartCount += 1;
    const current = threadStartCount;
    const delay = current === 2 ? 350 : 0;
    setTimeout(() => send({ id: message.id, result: { thread: { id: "thread-" + current }, model: "gpt-test" } }), delay);
    return;
  }
  if (message.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    const threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: turnId } } });
    const delay = threadId === "thread-3" ? 220 : 0;
    setTimeout(() => {
      const item = { id: "answer-" + turnId, type: "agentMessage", phase: "final_answer", text: "CODEX_SIBLING_COMPLETED:" + threadId };
      send({ method: "item/completed", params: { threadId, turnId, item } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
    }, delay);
    return;
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
});
`,
  "utf8",
);
const concurrencyApp = createOpenGrove({
  cwd: concurrencyRoot,
  readPage: async () => ({}),
  runtime: {
    async *runTurn() {
      return;
    },
  },
});
const concurrencyRuntime = new CodexRuntime({
  command: process.execPath,
  args: [concurrencyServerPath],
  statePath: join(concurrencyRoot, "bindings.json"),
  cwd: concurrencyRoot,
  configuredModel: "gpt-test",
  requestTimeoutMs: 50,
});
const concurrencyContext = (sessionId: string): AgentTurnRequest["context"] => ({
  sessionId,
  activity: "chat",
  memory: concurrencyApp.memory,
  artifacts: concurrencyApp.artifacts,
  skills: concurrencyApp.skills,
  packs: concurrencyApp.packs,
  sessions: concurrencyApp.sessions,
  executions: concurrencyApp.executions,
  workingState: concurrencyApp.workingState,
  approvals: concurrencyApp.approvals,
  questions: concurrencyApp.questions,
});
const collectCodex = async (runId: string, sessionId: string): Promise<{ events: AgentEvent[]; error?: string }> => {
  const events: AgentEvent[] = [];
  try {
    for await (const event of concurrencyRuntime.runTurn({
      runId,
      input: runId,
      context: concurrencyContext(sessionId),
      tools: [],
    }))
      events.push(event);
    return { events };
  } catch (error) {
    return { events, error: error instanceof Error ? error.message : String(error) };
  }
};
const warmEvents = await collectCodex("codex-generation-warm", "codex-generation-warm-session");
assert.ok(warmEvents.events.some((event) => event.type === "model.response"));
const abandonedCodex = collectCodex("codex-generation-abandoned", "codex-generation-abandoned-session");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
const siblingCodex = collectCodex("codex-generation-sibling", "codex-generation-sibling-session");
const [abandonedCodexResult, siblingCodexResult] = await Promise.all([abandonedCodex, siblingCodex]);
assert.equal(abandonedCodexResult.error, undefined);
assert.ok(
  abandonedCodexResult.events.some((event) => event.type === "error" && /thread\/start timed out/i.test(event.message)),
  JSON.stringify(abandonedCodexResult.events),
);
assert.ok(
  abandonedCodexResult.events.some(
    (event) =>
      event.type === "turn.finished" &&
      event.outcome.taskState === "TASK_STATE_FAILED" &&
      event.outcome.outcomeUnknown === true,
  ),
);
assert.ok(
  siblingCodexResult.events.some(
    (event) => event.type === "model.response" && event.response.text.includes("CODEX_SIBLING_COMPLETED:thread-3"),
  ),
  "a pre-ACK timeout must retire the Codex generation without killing an already-leased sibling Run",
);
assert.ok(
  siblingCodexResult.events.some(
    (event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_COMPLETED",
  ),
);
const nextGenerationEvents = await collectCodex("codex-generation-next", "codex-generation-next-session");
assert.ok(
  nextGenerationEvents.events.some((event) => event.type === "model.response"),
  "a new Run must use a fresh Codex generation after the previous one is poisoned",
);
concurrencyRuntime.close();

const cancelConcurrencyRuntime = new CodexRuntime({
  command: process.execPath,
  args: [concurrencyServerPath],
  statePath: join(concurrencyRoot, "cancel-bindings.json"),
  cwd: concurrencyRoot,
  configuredModel: "gpt-test",
  requestTimeoutMs: 1_000,
});
const collectCancelConcurrency = async (
  runId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of cancelConcurrencyRuntime.runTurn({
    runId,
    input: runId,
    context: concurrencyContext(sessionId),
    tools: [],
    signal,
  }))
    events.push(event);
  return events;
};
await collectCancelConcurrency("codex-cancel-warm", "codex-cancel-warm-session");
const cancelController = new AbortController();
const canceledBeforeAck = collectCancelConcurrency(
  "codex-cancel-before-ack",
  "codex-cancel-before-ack-session",
  cancelController.signal,
);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
const cancelSibling = collectCancelConcurrency("codex-cancel-sibling", "codex-cancel-sibling-session");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
cancelController.abort();
const [canceledBeforeAckEvents, cancelSiblingEvents] = await Promise.all([canceledBeforeAck, cancelSibling]);
cancelConcurrencyRuntime.close();
assert.ok(
  canceledBeforeAckEvents.some(
    (event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_COMPLETED",
  ),
  "when the Kernel confirms completion after a cancel request, the known native terminal must win",
);
assert.ok(
  cancelSiblingEvents.some(
    (event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_COMPLETED",
  ),
  "canceling one Run before turn/start ACK must not kill its sibling on the shared app-server",
);
assert.equal(
  cancelSiblingEvents.some(
    (event) => event.type === "error" && event.message.includes("codex_app_server_producer_lost"),
  ),
  false,
);

const corruptBindingsRoot = mkdtempSync(`${tmpdir()}/opengrove-codex-corrupt-bindings-`);
const corruptBindingsPath = join(corruptBindingsRoot, "bindings.json");
writeFileSync(corruptBindingsPath, '{"truncated":', "utf8");
const corruptBindingsRuntime = new CodexRuntime({ statePath: corruptBindingsPath });
assert.deepEqual(await corruptBindingsRuntime.compactSession({ threadId: "missing", reason: "recovery probe" }), {
  ok: false,
  compacted: false,
  error: "session_not_found",
});
corruptBindingsRuntime.close();
assert.equal(existsSync(corruptBindingsPath), false);
assert.equal(
  readdirSync(corruptBindingsRoot).some((name) => /^bindings\.json\.corrupt-\d+$/.test(name)),
  true,
  "a truncated binding file must be quarantined so later Codex Runs can recover",
);

console.log("✓ Codex app-server keeps assistant text deltas enabled");
console.log("✓ Codex app-server PATH includes bundled and local tool directories");
console.log("✓ Codex app-server exposes explicitly supplied dynamic tools");
console.log("✓ Codex app-server honors explicit dynamic tool disablement");
console.log("✓ Codex app-server adapts optional disable flags across versions");
console.log("✓ Codex app-server background compaction uses thread/compact/start");
console.log("✓ Codex runtime owns one terminal model.response per turn");
console.log("✓ Codex pre-ACK timeout drains sibling Runs without transport-wide cancellation");
console.log("✓ Codex pre-ACK user cancellation preserves sibling Runs on the shared app-server");
