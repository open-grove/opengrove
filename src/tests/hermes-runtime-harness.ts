import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import { APP_CONFIG_DIR, appEnvName } from "../identity.js";
import { HermesRuntime, hermesHealth } from "../runtime/hermes-runtime.js";
import { resolveHermesToolCallId } from "../runtime/hermes/gateway-events.js";
import { writeFakeAcpCommand } from "./harnesses/fake-acp-server.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";

async function main() {
  assert.deepEqual(
    resolveHermesToolCallId(
      new Map([
        ["call-1", { toolId: "hermes.terminal" }],
        ["call-2", { toolId: "hermes.terminal" }],
      ]),
      "hermes.terminal",
    ),
    { callId: "call-1", ambiguous: true },
    "Hermes must expose a stable fallback while marking id-less same-name correlation as ambiguous",
  );
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-runtime-"));
  const nativeSkillDir = join(cwd, APP_CONFIG_DIR, "native-skills", "hermes");
  mkdirSync(nativeSkillDir, { recursive: true });
  const fakeHermes = join(cwd, process.platform === "win32" ? "fake-hermes.mjs" : "fake-hermes.sh");
  const fakeGateway = join(cwd, "fake-hermes-gateway.mjs");
  writeFakeHermesGateway(fakeGateway, {
    sessionId: "fake-hermes-gateway-session",
    marker: "FAKE_HERMES_GATEWAY_OK",
    includeConfigEcho: true,
    contextUsedTokens: 160_000,
    contextMaxTokens: 200_000,
    thinkingStatusText: "( ͡° ͜ʖ ͡°) deliberating...",
    reasoningText: "HERMES_NATIVE_REASONING_PROCESS_TEXT",
    responseSuffix: "\n",
    ambiguousSameNameTools: true,
  });
  writeFakeAcpCommand(fakeHermes, fakeGateway, {
    commandName: "hermes-fake",
    version: "hermes-fake 0.0.0",
  });

  assert.deepEqual(hermesHealth(fakeHermes), {
    ok: true,
    message: "hermes-fake 0.0.0",
  });

  const runtime = new HermesRuntime({
    command: fakeHermes,
    gatewayCommand: process.execPath,
    gatewayArgs: [fakeGateway],
    cwd,
    configuredModel: "test-model",
    configuredProvider: "opengrove-test-provider",
    providerConfig: {
      providerKey: "opengrove-test-provider",
      name: "Test Provider",
      baseUrl: "https://example.test/anthropic",
      apiKeyEnv: appEnvName("TEST_API_KEY"),
      apiMode: "anthropic_messages",
      model: "test-model",
      models: ["test-model", "other-model"],
    },
    toolsets: ["skills"],
    nativeSkillDir,
    env: {
      [appEnvName("HERMES_ISOLATED_HOME")]: "1",
      [appEnvName("TEST_API_KEY")]: "test-key",
    },
  });
  const app = createOpenGrove({
    cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        return;
      },
    },
  });

  const events = [];
  let steered = false;
  const runId = "hermes-runtime-harness-run";
  const sessionId = "hermes-runtime-harness";
  for await (const event of runtime.runTurn({
    runId,
    input: "hello hermes",
    context: {
      sessionId,
      activity: "chat",
      memory: app.memory,
      artifacts: app.artifacts,
      skills: app.skills,
      packs: app.packs,
      sessions: app.sessions,
      executions: app.executions,
      workingState: app.workingState,
      approvals: app.approvals,
      questions: app.questions,
    },
    tools: [],
    replyLanguagePreference: "zh-CN",
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
    assembledContext: {
      id: "ctx",
      createdAt: new Date().toISOString(),
      summary: "test context",
      items: [],
      budget: {
        maxItems: 10,
        usedItems: 0,
        maxCharacters: 1000,
        usedCharacters: 0,
        truncated: false,
      },
      promptBlock: "Host marker: APP_CONTEXT_VISIBLE",
    },
  })) {
    events.push(event);
    if (event.type === "turn.started" && !steered) {
      const result = await runtime.steerTurn({
        runId,
        threadId: sessionId,
        instruction: "HARNESS_STEER_INSTRUCTION",
      });
      assert.deepEqual(result, { ok: true, guided: true });
      steered = true;
    }
    if (event.type === "approval.requested") {
      app.approvals.decide(event.request.id, "approved", {});
    }
    if (event.type === "question.requested") {
      app.questions.decide(event.question.id, "answered", { answer: "alpha" });
    }
  }
  const compactResult = await runtime.compactSession({
    runId,
    threadId: sessionId,
    reason: "HARNESS_COMPACT_INSTRUCTION",
  });
  runtime.close();

  assert.deepEqual(compactResult, { ok: true, compacted: true });
  const response = events.find((event) => event.type === "model.response");
  assert.ok(response && response.type === "model.response", "Hermes runtime should emit model.response");
  assert.match(response.response.text, /FAKE_HERMES_GATEWAY_OK/);
  assert.match(response.response.text, /APP_CONTEXT_VISIBLE/);
  assert.match(response.response.text, /Default response language: Simplified Chinese/);
  assert.match(response.response.text, /APPROVAL:allow/);
  assert.match(response.response.text, /ANSWER:alpha/);
  assert.match(response.response.text, /STEER:HARNESS_STEER_INSTRUCTION/);
  assert.match(response.response.text, /provider: "custom:opengrove-test-provider"/);
  assert.match(response.response.text, /base_url: "https:\/\/example\.test\/anthropic"/);
  assert.match(response.response.text, /api_mode: "anthropic_messages"/);
  assert.match(response.response.text, /approvals:\s+mode: manual/);
  assert.match(response.response.text, new RegExp(`key_env: "${escapeRegExp(appEnvName("TEST_API_KEY"))}"`));
  assert.match(response.response.text, /providers:/);
  assert.match(response.response.text, /"test-model": \{\}/);
  assert.match(response.response.text, /external_dirs/);
  assert.match(
    response.response.text.replaceAll("\\\\", "/"),
    new RegExp(`${escapeRegExp(APP_CONFIG_DIR)}/native-skills/hermes`),
  );
  assert.ok(
    events.some((event) => event.type === "tool.started" && event.toolId === "hermes.terminal"),
    "tool start should be mapped from Gateway",
  );
  assert.equal(
    events.filter((event) => event.type === "tool.started" && event.toolId === "hermes.terminal").length,
    2,
    "two same-name Gateway calls should keep distinct native call ids",
  );
  assert.equal(
    events.some((event) => event.type === "tool.progress" && event.toolId === "hermes.terminal"),
    false,
    "id-less progress must not be guessed when several same-name calls are active",
  );
  const finishedTools = events.filter((event) => event.type === "tool.finished" && event.toolId === "hermes.terminal");
  assert.deepEqual(
    finishedTools.map((event) => (event.type === "tool.finished" ? event.callId : undefined)),
    ["tool-1", "tool-2"],
    "id-less completion must close same-name calls in stable FIFO order instead of being dropped",
  );
  assert.deepEqual(
    finishedTools.map((event) =>
      event.type === "tool.finished" &&
      typeof event.result.value === "object" &&
      event.result.value !== null &&
      !Array.isArray(event.result.value)
        ? event.result.value.summary
        : undefined,
    ),
    ["first result", "second result"],
    "ambiguous completion payloads must survive projection",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "hermes.gateway.tool.correlation_ambiguous" &&
        event.data.eventType === "tool.complete",
    ),
    "FIFO completion fallback must remain visible in diagnostics",
  );
  assert.ok(
    events.some((event) => event.type === "approval.requested"),
    "approval request should be mapped from Gateway",
  );
  assert.ok(
    events.some((event) => event.type === "approval.resolved"),
    "approval decision should be mapped to Gateway",
  );
  assert.ok(
    events.some((event) => event.type === "question.requested"),
    "question request should be mapped from Gateway",
  );
  assert.ok(
    events.some((event) => event.type === "question.answered"),
    "question answer should be mapped to Gateway",
  );
  assert.deepEqual(response.response.usage, { inputTokens: 7, outputTokens: 11, totalTokens: 18, costUsd: 0.001 });
  assert.equal(
    events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => event.text)
      .join(""),
    response.response.text,
    "Hermes streamed assistant text must exactly match the terminal model.response",
  );
  assert.ok(
    events.some((event) => event.type === "runtime.diagnostic" && event.name === "hermes.gateway.session"),
    "Gateway session diagnostic should be emitted",
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        (event.name === "hermes.gateway.thinking.delta" || event.name === "hermes.gateway.reasoning.delta"),
    ),
    false,
    "Hermes must not emit one diagnostic event per native reasoning token",
  );
  const reasoningStreamDiagnostics = events.filter(
    (event) => event.type === "runtime.diagnostic" && event.name === "hermes.gateway.reasoning.stream",
  );
  assert.equal(
    reasoningStreamDiagnostics.length,
    1,
    "Hermes should summarize native reasoning transport once per message",
  );
  assert.deepEqual(
    reasoningStreamDiagnostics[0]?.type === "runtime.diagnostic" ? reasoningStreamDiagnostics[0].data : undefined,
    {
      thinkingDeltaCount: 1,
      thinkingTextLength: "( ͡° ͜ʖ ͡°) deliberating...".length,
      reasoningEventCount: 1,
      reasoningTextLength: "HERMES_NATIVE_REASONING_PROCESS_TEXT".length,
    },
  );
  const reasoning = events.find((event) => String(event.type) === "reasoning.completed") as unknown as
    | {
        reasoning?: { kind?: string; kernelId?: string; text?: string };
      }
    | undefined;
  assert.equal(reasoning?.reasoning?.kind, "native");
  assert.equal(reasoning?.reasoning?.kernelId, "hermes");
  assert.match(reasoning?.reasoning?.text ?? "", /HERMES_NATIVE_REASONING_PROCESS_TEXT/);
  assert.doesNotMatch(reasoning?.reasoning?.text ?? "", /deliberating/);
  assert.equal(
    events.some(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.finished") && event.toolId === "hermes.reasoning",
    ),
    false,
    "Hermes reasoning must not masquerade as a tool call",
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "assistant.delta" && /HERMES_NATIVE_REASONING_PROCESS_TEXT/.test(event.text)) ||
        (event.type === "model.response" && /HERMES_NATIVE_REASONING_PROCESS_TEXT/.test(event.response.text)),
    ),
    false,
    "Hermes reasoning diagnostics must not enter the answer channel",
  );
  assert.ok(
    events.some((event) => event.type === "compaction.finished"),
    "Hermes should compact natively before an over-budget turn",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === true,
    ),
    "Hermes should record the effective budget and successful native compression",
  );
  assert.ok(
    events.some((event) => event.type === "turn.finished"),
    "turn should finish",
  );
  await assertCompressionFailureFailsOpen(cwd);
}

async function assertCompressionFailureFailsOpen(cwd: string): Promise<void> {
  const fakeHermes = join(cwd, process.platform === "win32" ? "fake-hermes-fail-open.mjs" : "fake-hermes-fail-open.sh");
  const fakeGateway = join(cwd, "fake-hermes-fail-open-gateway.mjs");
  writeFakeHermesGateway(fakeGateway, {
    sessionId: "fake-hermes-fail-open-session",
    marker: "FAKE_HERMES_FAIL_OPEN_OK",
    skipBlockingPrompts: true,
    contextUsedTokens: 160_000,
    contextMaxTokens: 200_000,
    compressionError: "session.compress unavailable",
  });
  writeFakeAcpCommand(fakeHermes, fakeGateway, { commandName: "hermes-fail-open" });
  const runtime = new HermesRuntime({
    command: fakeHermes,
    gatewayCommand: process.execPath,
    gatewayArgs: [fakeGateway],
    cwd,
    env: { [appEnvName("HERMES_ISOLATED_HOME")]: "1" },
  });
  const app = createOpenGrove({
    cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        return;
      },
    },
  });
  const events = [];
  for await (const event of runtime.runTurn({
    runId: "hermes-fail-open-run",
    input: "this message must still run",
    context: {
      sessionId: "hermes-fail-open-thread",
      activity: "chat",
      memory: app.memory,
      artifacts: app.artifacts,
      skills: app.skills,
      packs: app.packs,
      sessions: app.sessions,
      executions: app.executions,
      workingState: app.workingState,
      approvals: app.approvals,
      questions: app.questions,
    },
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
  }))
    events.push(event);
  runtime.close();
  assert.ok(
    events.some((event) => event.type === "model.response"),
    "Hermes should submit the turn after a soft-budget compaction failure",
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "tool.progress"),
    false,
    "the default Hermes 0.20 fixture must not invent a generic tool.progress event",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === false,
    ),
    "Hermes should record the failed native compression without killing the user message",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
