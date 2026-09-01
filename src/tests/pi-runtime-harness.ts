import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createModels, createProvider } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createOpenGrove } from "../app/create-opengrove.js";
import {
  ApprovalInbox,
  QuestionInbox,
  WorkingStateStore,
  type AgentContext,
  type AgentEvent,
  type AgentRuntime,
  type InvokedSkillRecord,
  type SkillManifest,
  type ToolDefinition,
} from "../core.js";
import { createKernelRuntime, createRuntimeKernelAdapter } from "../kernel/adapter.js";
import { buildPiProviderEnv, resolvePiRuntimeModel } from "../kernel/adapters/pi.js";
import { PiAgentRuntime, type PiSession, type PiSessionContext } from "../runtime/pi-runtime.js";
import { imageAttachmentsWithDataUrl } from "../runtime/media-input.js";
import { createNativePiSessionFactory, piCompactionSettingsForRequest } from "../runtime/native-pi-session.js";

function createContext(sessionId: string, page?: AgentContext["page"]): AgentContext {
  return {
    sessionId,
    activity: undefined as any,
    sessions: undefined as any,
    memory: undefined as any,
    artifacts: undefined as any,
    skills: undefined as any,
    executions: undefined as any,
    workingState: new WorkingStateStore(),
    approvals: new ApprovalInbox(),
    questions: new QuestionInbox(),
    packs: undefined as any,
    ...(page ? { page } : {}),
  };
}

async function collect(
  runtime: PiAgentRuntime,
  context: AgentContext,
  input: string,
  replyLanguagePreference?: "zh-CN" | "en",
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "pi-image-run",
    input,
    context,
    tools: [],
    replyLanguagePreference,
    skills: [],
    packs: [],
    capabilities: [],
  })) {
    events.push(event);
  }
  return events;
}

async function main() {
  const deepSeekEnv = buildPiProviderEnv({
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    apiKey: "test-key",
    openaiBaseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  });
  assert.equal(
    deepSeekEnv?.OPENGROVE_PI_PROVIDER_ID,
    "deepseek",
    "Pi provider bindings must preserve the provider identity instead of reducing every OpenAI-compatible service to generic OpenAI",
  );
  const deepSeekModel = resolvePiRuntimeModel(deepSeekEnv ?? {}, "deepseek-v4-flash");
  const builtinDeepSeekModel = getBuiltinModel("deepseek", "deepseek-v4-flash");
  assert.ok(builtinDeepSeekModel);
  assert.equal(deepSeekModel.provider, builtinDeepSeekModel.provider);
  assert.equal(deepSeekModel.contextWindow, builtinDeepSeekModel.contextWindow);
  assert.deepEqual(deepSeekModel.cost, builtinDeepSeekModel.cost);
  assert.equal((deepSeekModel.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "deepseek");

  const wwEnv = buildPiProviderEnv({
    id: "ww",
    name: "WW",
    protocol: "anthropic-compatible",
    apiKey: "test-key",
    anthropicBaseUrl: "https://ww.example/anthropic",
    model: "claude-opus-4-8",
  });
  const wwModel = resolvePiRuntimeModel(wwEnv ?? {}, "claude-opus-4-8");
  const builtinClaudeModel = getBuiltinModel("anthropic", "claude-opus-4-8");
  assert.ok(builtinClaudeModel);
  assert.equal(wwModel.provider, builtinClaudeModel.provider);
  assert.equal(
    wwModel.contextWindow,
    builtinClaudeModel.contextWindow,
    "A custom profile id must not hide Pi's native Anthropic model metadata",
  );
  assert.deepEqual(wwModel.cost, builtinClaudeModel.cost);
  assert.equal(wwModel.baseUrl, "https://ww.example/anthropic");

  const selectedOpenAiEnv = buildPiProviderEnv({
    id: "dual-protocol",
    name: "Dual protocol",
    protocol: "openai-compatible",
    apiKey: "one-route-key",
    baseUrl: "https://openai.example/v1",
    openaiBaseUrl: "https://openai.example/v1",
    anthropicBaseUrl: "https://anthropic.example",
    model: "dual-model",
  });
  assert.equal(selectedOpenAiEnv?.OPENAI_API_KEY, "one-route-key");
  assert.equal(
    selectedOpenAiEnv?.ANTHROPIC_API_KEY,
    undefined,
    "Pi must inject only the protocol selected by the binding planner",
  );

  const awsCompatibleEnv = buildPiProviderEnv({
    id: "aws-bedrock-api-key",
    name: "AWS Bedrock API key",
    protocol: "anthropic-compatible",
    apiKey: "test-key",
    anthropicBaseUrl: "https://bedrock-runtime.example",
    model: "claude-opus-4-8",
  });
  const awsCompatibleModel = resolvePiRuntimeModel(awsCompatibleEnv ?? {}, "claude-opus-4-8");
  assert.equal(
    awsCompatibleModel.contextWindow,
    builtinClaudeModel.contextWindow,
    "An OpenGrove profile id outside Pi's KnownProvider union must still fall back to its protocol catalog",
  );
  assert.deepEqual(awsCompatibleModel.cost, builtinClaudeModel.cost);

  const geminiEnv = buildPiProviderEnv({
    id: "gemini",
    name: "Gemini",
    protocol: "gemini-compatible",
    apiKey: "test-key",
    geminiBaseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-pro",
  });
  const geminiModel = resolvePiRuntimeModel(geminiEnv ?? {}, "gemini-2.5-pro");
  const builtinGeminiModel = getBuiltinModel("google", "gemini-2.5-pro");
  assert.ok(builtinGeminiModel);
  assert.equal(geminiModel.provider, builtinGeminiModel.provider);
  assert.equal(
    geminiModel.contextWindow,
    builtinGeminiModel.contextWindow,
    "The OpenGrove gemini profile must resolve through Pi's google provider catalog",
  );
  assert.deepEqual(geminiModel.cost, builtinGeminiModel.cost);

  const kimiEnv = buildPiProviderEnv({
    id: "kimi",
    name: "Kimi",
    protocol: "openai-compatible",
    apiKey: "test-key",
    openaiBaseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.7-code",
  });
  const kimiModel = resolvePiRuntimeModel(kimiEnv ?? {}, "kimi-k2.7-code");
  const builtinKimiModel = getBuiltinModel("moonshotai", "kimi-k2.7-code");
  assert.ok(builtinKimiModel);
  assert.equal(kimiModel.provider, builtinKimiModel.provider);
  assert.equal(
    kimiModel.contextWindow,
    builtinKimiModel.contextWindow,
    "The OpenGrove kimi profile must resolve through Pi's moonshotai provider catalog",
  );
  assert.deepEqual(kimiModel.cost, builtinKimiModel.cost);

  assert.deepEqual(
    piCompactionSettingsForRequest(128_000, 10_000),
    {
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 6_000,
    },
    "AgentCompactRequest.maxTokens should constrain the target context window, not become Pi's retained tail",
  );
  let sawImageInSession = 0;
  let capturedSessionInput = "";
  let capturedSystemPrompt = "";
  const runtime = new PiAgentRuntime({
    createSession(options) {
      capturedSystemPrompt = options.system;
      const session: PiSession = {
        async *run(input: string, context: PiSessionContext): AsyncIterable<AgentEvent> {
          // Mirror what native-pi-session derives from the context — proves the
          // image attachment is available to the session that talks to pi.
          sawImageInSession = imageAttachmentsWithDataUrl(context.agent.page?.attachments).length;
          capturedSessionInput = input;
          yield { type: "assistant.delta", runId: context.runId, text: "ok" };
        },
      };
      return session;
    },
  });

  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
  const imageContext = createContext("pi-image-session", {
    attachments: [
      {
        id: "shot",
        name: "shot.png",
        kind: "image",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${base64}`,
      },
    ],
  });
  const imageEvents = await collect(runtime, imageContext, "what is in this image?", "zh-CN");

  assert.equal(sawImageInSession, 1, "pi session should receive the image attachment from context.page");
  const imageRequest = imageEvents.find((event) => event.type === "model.requested");
  assert.ok(imageRequest && imageRequest.type === "model.requested");
  assert.equal(capturedSessionInput, "what is in this image?");
  assert.match(capturedSystemPrompt, /Default response language: Simplified Chinese/);
  assert.match(capturedSystemPrompt, /primary natural language of the current input/);
  assert.ok(
    capturedSystemPrompt.endsWith(
      "Default response language: Simplified Chinese. Follow the primary natural language of the current input unless it explicitly requests another language.",
    ),
    "the concise preference should remain visible after Pi's skill context",
  );
  assert.ok(
    imageEvents.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "pi.media_input.configured" &&
        event.data.imageInputs === 1,
    ),
    "pi.media_input.configured diagnostic should report the image input",
  );

  // Text-only turn must not emit the media diagnostic.
  const textEvents = await collect(runtime, createContext("pi-text-session"), "hello");
  assert.ok(
    !textEvents.some((event) => event.type === "runtime.diagnostic" && event.name === "pi.media_input.configured"),
    "text-only turns should not emit the media diagnostic",
  );

  await assertNativePiCrossTurnBudgetEvents();
  await assertNativePiKeepsOfficialCodingTools();
  await assertNativePiTerminalMessageBelongsToCurrentTurn();
  await assertNativePiNeverTruncatesOversizedInput();
  await assertNativePiUnconfiguredUsesModelWindow();
  await assertNativePiReasoningEffortContract();
  await assertNativePiMessageBoundaryUsageEffortAndProgress();
  await assertNativePiReasoningElapsedStopsAtThinkingEnd();
  await assertNativePiAbortPreservesPartialAnswer();
  await assertNativePiAbortHasSettlementBound();
  await assertNativePiAbortRepairsPendingToolHistory();
  await assertNativePiApprovalContinuesSameLoop();
  await assertNativePiForkedSkillIsEphemeral();
  await assertNativePiDurableSessionRestart();
  await assertNativePiRejectsActiveSessionDeletion();
  await assertNativePiCompaction();

  console.log("pi runtime image-input harness: all assertions passed ✓");
}

async function assertNativePiKeepsOfficialCodingTools(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-pi-native-tools-"));
  const outputPath = join(cwd, "native-output.txt");
  const observedToolNames = new Set<string>();
  const model = nativeTestModel("pi-native-coding-tools-model");
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      cwd,
      model,
      streamFn: (_model, llmContext) => {
        for (const tool of llmContext.tools ?? []) observedToolNames.add(tool.name);
        const hasToolResult = llmContext.messages.some((message) => message.role === "toolResult");
        if (!hasToolResult && llmContext.tools?.some((tool) => tool.name === "write")) {
          return nativeAssistantStream(
            model.id,
            [
              {
                type: "toolCall",
                id: "pi-native-write-call",
                name: "write",
                arguments: { path: "native-output.txt", content: "written by Pi native tool" },
              },
            ],
            "toolUse",
          );
        }
        return nativeAssistantStream(model.id, [{ type: "text", text: "native write complete" }], "stop");
      },
    }),
  });

  try {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId: "pi-native-coding-tools-run",
      input: "write the requested file",
      context: createContext("pi-native-coding-tools-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      accessMode: "full-access",
    })) {
      events.push(event);
    }

    assert.deepEqual(
      [...observedToolNames].sort(),
      ["bash", "edit", "read", "write"],
      "Pi's official coding tools must remain available beside additive OpenGrove Host Tools",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "written by Pi native tool");
    assert.ok(
      events.some(
        (event) => event.type === "tool.started" && event.toolId === "write" && event.callId === "pi-native-write-call",
      ),
      "Pi native file operations must remain observable through the common tool lifecycle",
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.finished" && event.toolId === "write" && event.callId === "pi-native-write-call",
      ),
      "Pi native file operations must publish a terminal tool event",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function nativeTestModel(id: string, reasoning = false) {
  return {
    id,
    name: id,
    api: "test",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_000,
  } as any;
}

function nativeAssistantStream(
  modelId: string,
  content: Array<Record<string, unknown>>,
  stopReason: "stop" | "toolUse" = "stop",
  usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: "assistant" as const,
      content,
      api: "test",
      provider: "test",
      model: modelId,
      usage,
      stopReason,
      responseId: `response-${stopReason}`,
      timestamp: Date.now(),
    } as any;
    stream.push({ type: "start", partial: message });
    content.forEach((part, contentIndex) => {
      if (part.type === "text") {
        const text = String(part.text || "");
        const splitAt = Math.max(1, Math.floor(text.length / 2));
        stream.push({ type: "text_start", contentIndex, partial: message });
        for (const delta of [text.slice(0, splitAt), text.slice(splitAt)].filter(Boolean)) {
          stream.push({ type: "text_delta", contentIndex, delta, partial: message });
        }
        stream.push({ type: "text_end", contentIndex, content: text, partial: message });
      } else if (part.type === "thinking") {
        const thinking = String(part.thinking || "");
        stream.push({ type: "thinking_start", contentIndex, partial: message });
        if (thinking) stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: message });
        stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: message });
      } else if (part.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: part as any, partial: message });
      }
    });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

function nativeEchoTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    spec: {
      id: "test.echo",
      title: "Echo",
      description: "Echo test input",
      activity: undefined as any,
      risk: "write",
      input: { type: "json-schema", schema: { type: "object", properties: {} } },
      permission: { mode: "ask", reason: "Test approval is required." },
    },
    execute,
  };
}

// ===== Native reasoning contract =====

async function assertNativePiReasoningEffortContract(): Promise<void> {
  const supportedEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
  for (const effort of supportedEfforts) {
    const model = resolvePiRuntimeModel({ OPENAI_API_KEY: "test-key" }, "gpt-5.6-sol");
    let observedReasoning = "";
    const runtime = new PiAgentRuntime({
      createSession: createNativePiSessionFactory({
        model,
        streamFn: (_model, _context, options) => {
          observedReasoning = options?.reasoning ?? "";
          return nativeAssistantStream(model.id, [{ type: "text", text: "ok" }], "stop");
        },
      }),
    });
    for await (const _event of runtime.runTurn({
      runId: `pi-reasoning-run-${effort}`,
      input: "verify reasoning effort",
      context: createContext(`pi-reasoning-session-${effort}`),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      requestedEffort: effort,
    })) {
      // Consuming the stream completes the public runtime boundary under test.
    }
    assert.equal(observedReasoning, effort, `Pi must pass ${effort} to its native reasoning option`);
  }
}

async function assertNativePiMessageBoundaryUsageEffortAndProgress(): Promise<void> {
  const model = nativeTestModel("pi-boundary-model", true);
  let observedReasoning = "";
  let toolExecutions = 0;
  const tool = nativeEchoTool(async (_input, context) => {
    toolExecutions += 1;
    assert.ok(context.signal, "Pi should forward its native per-tool abort signal");
    context.onProgress?.({ phase: "halfway", percent: 50 });
    return { ok: true, value: { echoed: true } };
  });
  const factory = createNativePiSessionFactory({
    model,
    streamFn: (_model, llmContext, options) => {
      observedReasoning = options?.reasoning ?? "";
      const hasToolResult = llmContext.messages.some((message) => message.role === "toolResult");
      if (!hasToolResult) {
        return nativeAssistantStream(
          model.id,
          [
            { type: "text", text: "I will inspect the data first." },
            { type: "toolCall", id: "pi-call-1", name: llmContext.tools?.[0]?.name, arguments: {} },
          ],
          "toolUse",
        );
      }
      return nativeAssistantStream(
        model.id,
        [
          { type: "thinking", thinking: "PI_NATIVE_REASONING_BLOCK_ONE" },
          { type: "text", text: "This is the final answer." },
          { type: "thinking", thinking: "PI_NATIVE_REASONING_BLOCK_TWO", redacted: true },
        ],
        "stop",
        {
          input: 11,
          output: 7,
          cacheRead: 2,
          cacheWrite: 3,
          totalTokens: 23,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
      );
    },
  });
  const runtime = new PiAgentRuntime({ createSession: factory });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "pi-boundary-run",
    input: "inspect",
    context: createContext("pi-boundary-session"),
    tools: [tool],
    skills: [],
    packs: [],
    capabilities: [],
    requestedEffort: "high",
    accessMode: "full-access",
  }))
    events.push(event);

  assert.equal(observedReasoning, "high", "requestedEffort should reach Pi's native reasoning option");
  assert.equal(toolExecutions, 1);
  assert.deepEqual(
    events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => (event.type === "assistant.delta" ? event.text : "")),
    ["This is the final answer."],
    "Pi must buffer native text deltas until the message boundary and keep tool preambles out of the answer stream",
  );
  assert.ok(
    events.some((event) => event.type === "assistant.status" && event.text === "I will inspect the data first."),
    "the completed tool preamble should become status activity",
  );
  assert.ok(events.some((event) => event.type === "tool.progress" && event.callId === "pi-call-1"));
  const responses = events.filter((event) => event.type === "model.response");
  assert.equal(responses.length, 1, "Pi should emit one terminal model.response");
  assert.deepEqual(responses[0]?.type === "model.response" ? responses[0].response.usage : undefined, {
    inputTokens: 16,
    outputTokens: 7,
    totalTokens: 23,
    costUsd: 0.33,
    contextWindowSize: 128_000,
    contextUsedTokens: 16,
  });
  assert.equal(
    events.filter((event) => event.type === "model.requested").length,
    2,
    "Only actual provider requests should be traced",
  );
  assert.ok(events.some((event) => event.type === "runtime.diagnostic" && event.name === "pi.message.completed"));
  const reasoning = events.filter((event) => String(event.type) === "reasoning.completed") as unknown as Array<{
    reasoning: { kind?: string; kernelId?: string; text?: string; redacted?: boolean; elapsedMs?: number };
  }>;
  assert.deepEqual(
    reasoning.map((event) => event.reasoning.text),
    ["PI_NATIVE_REASONING_BLOCK_ONE", "PI_NATIVE_REASONING_BLOCK_TWO"],
    "Pi must preserve native thinking blocks instead of merging them",
  );
  assert.ok(reasoning.every((event) => event.reasoning.kind === "native" && event.reasoning.kernelId === "pi"));
  assert.ok(reasoning.every((event) => typeof event.reasoning.elapsedMs === "number"));
  assert.equal(reasoning[1]?.reasoning.redacted, true);
  assert.equal(
    events.some((event) => String(event.type) === "reasoning.delta"),
    false,
    "Pi thinking deltas must stay inside the message projector until the native message completes",
  );
  assert.equal(
    events.some(
      (event) => (event.type === "tool.started" || event.type === "tool.finished") && event.toolId === "pi.reasoning",
    ),
    false,
    "Pi reasoning must not masquerade as a tool call",
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "assistant.delta" && /PI_NATIVE_REASONING_BLOCK/.test(event.text)) ||
        (event.type === "model.response" && /PI_NATIVE_REASONING_BLOCK/.test(event.response.text)),
    ),
    false,
    "Pi thinking must stay in process activity and out of the final answer channel",
  );
}

async function assertNativePiReasoningElapsedStopsAtThinkingEnd(): Promise<void> {
  const model = nativeTestModel("pi-reasoning-timing-model", true);
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          const message = {
            role: "assistant" as const,
            content: [
              { type: "thinking" as const, thinking: "brief native thought" },
              { type: "text" as const, text: "answer after a delay" },
            ],
            api: "test",
            provider: "test",
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: "brief native thought", partial: message });
          stream.push({ type: "thinking_end", contentIndex: 0, content: "brief native thought", partial: message });
          await new Promise((resolve) => setTimeout(resolve, 100));
          stream.push({ type: "text_start", contentIndex: 1, partial: message });
          stream.push({ type: "text_delta", contentIndex: 1, delta: "answer after a delay", partial: message });
          stream.push({ type: "text_end", contentIndex: 1, content: "answer after a delay", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
    }),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "pi-reasoning-timing-run",
    input: "think briefly",
    context: createContext("pi-reasoning-timing-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
  }))
    events.push(event);
  const completed = events.find((event) => event.type === "reasoning.completed");
  assert.ok(completed?.type === "reasoning.completed");
  assert.ok(
    (completed.reasoning.elapsedMs ?? 100) < 60,
    "Pi reasoning elapsed time must stop at thinking_end and exclude delayed answer generation",
  );
}

async function assertNativePiAbortPreservesPartialAnswer(): Promise<void> {
  const model = nativeTestModel("pi-abort-model");
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const usage = {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const pending = {
          role: "assistant" as const,
          content: [] as Array<{ type: "text"; text: string }>,
          api: "test",
          provider: "test",
          model: model.id,
          usage,
          stopReason: "pending" as const,
          timestamp: Date.now(),
        };
        const partialText = "This partial answer must survive abort.";
        const partial = {
          ...pending,
          content: [{ type: "text" as const, text: partialText }],
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: pending as any });
          stream.push({ type: "text_start", contentIndex: 0, partial: pending as any });
          stream.push({ type: "text_delta", contentIndex: 0, delta: partialText, partial: partial as any });
          markStreamStarted();
          const finishAborted = () => {
            const aborted = {
              ...partial,
              stopReason: "aborted" as const,
              errorMessage: "Pi test stream aborted",
            };
            stream.push({ type: "text_end", contentIndex: 0, content: partialText, partial: aborted as any });
            stream.push({ type: "error", reason: "aborted", error: aborted as any });
            stream.end(aborted as any);
          };
          if (options?.signal?.aborted) {
            finishAborted();
          } else {
            options?.signal?.addEventListener("abort", finishAborted, { once: true });
          }
        });
        return stream;
      },
    }),
  });
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const event of runtime.runTurn({
      runId: "pi-abort-run",
      input: "start a long answer",
      context: createContext("pi-abort-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      signal: controller.signal,
    }))
      events.push(event);
  })();
  await streamStarted;
  controller.abort();
  await running;

  assert.deepEqual(
    events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => (event.type === "assistant.delta" ? event.text : "")),
    ["This partial answer must survive abort."],
    "Pi abort must drain the native message_end/agent_end lifecycle and preserve partial text",
  );
  assert.ok(
    events.some(
      (event) => event.type === "model.response" && event.response.text === "This partial answer must survive abort.",
    ),
  );
  assert.ok(events.some((event) => event.type === "turn.finished"));
}

async function assertNativePiAbortHasSettlementBound(): Promise<void> {
  const model = nativeTestModel("pi-stuck-abort-model");
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      abortSettleTimeoutMs: 20,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: "assistant" as const,
            content: [] as Array<{ type: "text"; text: string }>,
            api: "test",
            provider: "test",
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message as any });
          markStreamStarted();
          // Deliberately ignore the abort signal and never close the stream.
        });
        return stream;
      },
    }),
  });
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const event of runtime.runTurn({
      runId: "pi-stuck-abort-run",
      input: "never settle",
      context: createContext("pi-stuck-abort-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      signal: controller.signal,
    }))
      events.push(event);
  })();
  await streamStarted;
  controller.abort();
  const outcome = await Promise.race([
    running.then(() => "settled" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  assert.equal(outcome, "settled", "Pi abort must not wait forever for a provider that ignores cancellation");
  assert.ok(events.some((event) => event.type === "error" && /pi_abort_settlement_timeout/.test(event.message)));
}

async function assertNativePiAbortRepairsPendingToolHistory(): Promise<void> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "opengrove-pi-aborted-tool-"));
  const model = nativeTestModel("pi-aborted-tool-model");
  let markToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const stuckTool = nativeEchoTool(async () => {
    markToolStarted();
    await new Promise(() => undefined);
    return { ok: false, error: "unreachable" };
  });
  const tool: ToolDefinition = {
    ...stuckTool,
    spec: {
      ...stuckTool.spec,
      permission: { mode: "allow", reason: "Exercise native cancellation settlement." },
    },
  };
  try {
    const firstRuntime = new PiAgentRuntime({
      createSession: createNativePiSessionFactory({
        model,
        sessionRoot,
        cwd: process.cwd(),
        abortSettleTimeoutMs: 20,
        streamFn: (_model, nativeContext) =>
          nativeAssistantStream(
            model.id,
            [
              {
                type: "toolCall",
                id: "pi-stuck-tool-call",
                name: nativeContext.tools?.[0]?.name,
                arguments: {},
              },
            ],
            "toolUse",
          ),
      }),
    });
    const controller = new AbortController();
    const firstEvents: AgentEvent[] = [];
    const running = (async () => {
      for await (const event of firstRuntime.runTurn({
        runId: "pi-aborted-tool-run-1",
        input: "start a tool that ignores cancellation",
        context: createContext("pi-aborted-tool-session"),
        tools: [tool],
        skills: [],
        packs: [],
        capabilities: [],
        signal: controller.signal,
      }))
        firstEvents.push(event);
    })();
    await toolStarted;
    controller.abort();
    await running;
    assert.ok(firstEvents.some((event) => event.type === "error" && /pi_abort_settlement_timeout/.test(event.message)));

    let restoredToolResult: { isError?: boolean; content?: unknown } | undefined;
    const restartedRuntime = new PiAgentRuntime({
      createSession: createNativePiSessionFactory({
        model,
        sessionRoot,
        cwd: process.cwd(),
        streamFn: (_model, nativeContext) => {
          restoredToolResult = nativeContext.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "pi-stuck-tool-call",
          );
          return nativeAssistantStream(model.id, [{ type: "text", text: "continued after cancelled tool" }]);
        },
      }),
    });
    const restartedEvents: AgentEvent[] = [];
    for await (const event of restartedRuntime.runTurn({
      runId: "pi-aborted-tool-run-2",
      input: "continue safely",
      context: createContext("pi-aborted-tool-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      restartedEvents.push(event);
    assert.equal(
      restoredToolResult?.isError,
      true,
      "a timed-out native tool call must be durably paired with an error toolResult before the session is reused",
    );
    assert.match(JSON.stringify(restoredToolResult?.content), /cancel/i);
    assert.ok(
      restartedEvents.some(
        (event) => event.type === "model.response" && event.response.text === "continued after cancelled tool",
      ),
      "the repaired Pi session must remain usable after a process-local restart",
    );
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

async function assertNativePiApprovalContinuesSameLoop(): Promise<void> {
  const model = nativeTestModel("pi-approval-model");
  let toolExecutions = 0;
  const tool = nativeEchoTool(async () => {
    toolExecutions += 1;
    return { ok: true, value: { approved: true } };
  });
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: (_model, llmContext) =>
        llmContext.messages.some((message) => message.role === "toolResult")
          ? nativeAssistantStream(model.id, [{ type: "text", text: "Approved tool finished." }])
          : nativeAssistantStream(
              model.id,
              [
                { type: "text", text: "This action needs confirmation." },
                { type: "toolCall", id: "pi-approval-call", name: llmContext.tools?.[0]?.name, arguments: {} },
              ],
              "toolUse",
            ),
    }),
  });
  const context = createContext("pi-approval-session");
  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const event of runtime.runTurn({
      runId: "pi-approval-run",
      input: "do gated work",
      context,
      tools: [tool],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      events.push(event);
  })();
  for (let attempt = 0; attempt < 100 && context.approvals.list("pending").length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const pending = context.approvals.list("pending")[0];
  assert.ok(pending, "Pi should pause inside beforeToolCall and publish an approval");
  assert.deepEqual(pending.resume, {
    type: "kernel.native",
    kernelId: "pi",
    runId: "pi-approval-run",
    continuation: "same-loop",
  });
  context.approvals.decide(pending.id, "approved");
  await running;

  assert.equal(toolExecutions, 1, "approved native call should execute exactly once");
  assert.ok(events.some((event) => event.type === "run.paused" && event.approvalId === pending.id));
  assert.ok(events.some((event) => event.type === "approval.resolved" && event.request.status === "approved"));
  assert.ok(events.some((event) => event.type === "run.resumed" && event.approvalId === pending.id));
  assert.ok(events.some((event) => event.type === "tool.finished" && event.callId === "pi-approval-call"));
  assert.ok(
    events.some((event) => event.type === "model.response" && event.response.text === "Approved tool finished."),
  );
  assert.ok(events.some((event) => event.type === "turn.finished"));
}

async function assertNativePiForkedSkillIsEphemeral(): Promise<void> {
  const model = nativeTestModel("pi-forked-skill-model");
  const invocation: InvokedSkillRecord = {
    skillId: "skill.fork-demo",
    skillName: "fork-demo",
    title: "Fork Demo",
    content: "FORK_SKILL_BODY",
    contentPreview: "fork demo",
    sourcePath: "/tmp/fork-demo/SKILL.md",
    source: "project",
    trust: "trusted",
    context: "fork",
    allowedTools: [],
    invokedAt: new Date(0).toISOString(),
    origin: "user",
  };
  const skill = {
    id: invocation.skillId,
    name: invocation.skillName,
    title: invocation.title,
    description: "Forked skill harness",
    format: "markdown-v2",
    entry: invocation.sourcePath,
    skillRoot: "/tmp/fork-demo",
    activities: [],
    toolIds: [],
    memoryHooks: [],
    allowedTools: [],
    userInvocable: true,
    disableModelInvocation: false,
    context: "fork",
    source: "project",
    trust: "trusted",
  } satisfies SkillManifest;
  const skillTool: ToolDefinition = {
    spec: {
      id: "skill.invoke",
      title: "Invoke skill",
      description: "Invoke a test skill",
      activity: undefined as any,
      risk: "write",
      input: {
        type: "json-schema",
        schema: {
          type: "object",
          properties: { skill: { type: "string" } },
          required: ["skill"],
        },
      },
      permission: { mode: "allow", reason: "Harness skill invocation" },
    },
    async execute(_input, toolContext) {
      toolContext.workingState.restore({
        ...toolContext.workingState.get(),
        invokedSkills: [invocation],
      });
      return { ok: true, value: { skillId: invocation.skillId } };
    },
  };
  const factory = createNativePiSessionFactory({
    model,
    streamFn: (_model, nativeContext) => {
      const serialized = JSON.stringify(nativeContext.messages);
      if (serialized.includes("FORK_SKILL_BODY")) {
        return nativeAssistantStream(model.id, [{ type: "text", text: "forked skill result" }]);
      }
      if (nativeContext.messages.some((message) => message.role === "toolResult")) {
        return nativeAssistantStream(model.id, [{ type: "text", text: "parent final" }]);
      }
      return nativeAssistantStream(
        model.id,
        [
          {
            type: "toolCall",
            id: "pi-skill-call",
            name: nativeContext.tools?.[0]?.name,
            arguments: { skill: "fork-demo" },
          },
        ],
        "toolUse",
      );
    },
  });
  const context = createContext("pi-fork-skill-parent");
  context.skills = { get: () => skill } as any;
  const events: AgentEvent[] = [];
  for await (const event of new PiAgentRuntime({ createSession: factory }).runTurn({
    runId: "pi-fork-skill-run",
    input: "use the forked skill",
    context,
    tools: [skillTool],
    skills: [skill],
    packs: [],
    capabilities: [],
    accessMode: "full-access",
  }))
    events.push(event);

  const forkEvents = events.filter(
    (event): event is Extract<AgentEvent, { type: "skill.forked" }> => event.type === "skill.forked",
  );
  assert.equal(forkEvents.length, 2);
  assert.equal(forkEvents[0]?.status, "started");
  assert.equal(forkEvents[1]?.status, "finished");
  assert.equal(
    forkEvents[0]?.forkSessionId,
    forkEvents[1]?.forkSessionId,
    "Pi forked-skill lifecycle events should identify the same ephemeral child session",
  );
  assert.equal(forkEvents[1]?.result, "forked skill result");
  assert.deepEqual(
    (await factory.listSessions?.())?.map((session) => session.sessionId),
    ["pi-fork-skill-parent"],
    "forked skill execution must not pollute the durable Pi session list",
  );
}

async function assertNativePiDurableSessionRestart(): Promise<void> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "opengrove-pi-session-"));
  const model = nativeTestModel("pi-durable-model");
  try {
    const run = async (runtime: AgentRuntime, runId: string, sessionId = "pi-durable-session") => {
      const events: AgentEvent[] = [];
      for await (const event of runtime.runTurn({
        runId,
        input: `input ${runId}`,
        context: createContext(sessionId),
        tools: [],
        skills: [],
        packs: [],
        capabilities: [],
      }))
        events.push(event);
      return events;
    };
    const firstFactory = createNativePiSessionFactory({
      model,
      sessionRoot,
      cwd: process.cwd(),
      streamFn: () => assistantStream("first persisted answer", model.id),
    });
    const firstRuntime = createKernelRuntime(
      createRuntimeKernelAdapter({
        id: "pi",
        title: "Pi",
        runtime: new PiAgentRuntime({ createSession: firstFactory }),
      }),
    );
    await run(firstRuntime, "pi-durable-run-1");
    const firstSessions = await firstRuntime.listSessions?.();
    assert.equal(firstSessions?.ok, true);
    assert.ok(firstSessions?.sessions.some((session) => session.sessionId === "pi-durable-session"));
    const restartedEvents = await run(
      new PiAgentRuntime({
        createSession: createNativePiSessionFactory({
          model,
          sessionRoot,
          cwd: process.cwd(),
          streamFn: () => assistantStream("second persisted answer", model.id),
        }),
      }),
      "pi-durable-run-2",
    );
    const request = restartedEvents.find((event) => event.type === "model.requested");
    assert.ok(request?.type === "model.requested" && (request.request.session?.priorMessageCount ?? 0) >= 2);
    assert.match(
      JSON.stringify(request?.type === "model.requested" ? request.request.messages : []),
      /first persisted answer/,
    );
    const lifecycleFactory = createNativePiSessionFactory({
      model,
      sessionRoot,
      cwd: process.cwd(),
      streamFn: () => assistantStream("forked answer", model.id),
    });
    const lifecycleKernel = createRuntimeKernelAdapter({
      id: "pi",
      title: "Pi",
      runtime: new PiAgentRuntime({ createSession: lifecycleFactory }),
    });
    const lifecycleRuntime = createKernelRuntime(lifecycleKernel);
    const lifecycleApp = createOpenGrove({
      cwd: sessionRoot,
      readPage: async () => ({}),
      kernel: lifecycleKernel,
    });
    assert.deepEqual(await lifecycleApp.forkKernelSession("pi-missing-source", "pi-missing-target"), {
      ok: false,
      forked: false,
      error: "pi_session_source_not_found",
    });
    const sessionsAfterMissingFork = await lifecycleApp.listKernelSessions();
    assert.equal(
      sessionsAfterMissingFork.sessions.some((session) => session.sessionId === "pi-missing-source"),
      false,
      "forking a missing Pi source must not create an empty source session",
    );
    const forkResult = await lifecycleApp.forkKernelSession("pi-durable-session", "pi-durable-fork");
    assert.equal(forkResult?.ok, true);
    assert.equal(forkResult?.forked, true);
    assert.equal(forkResult?.session?.sessionId, "pi-durable-fork");
    assert.deepEqual(await lifecycleApp.forkKernelSession("pi-durable-session", "pi-durable-fork"), {
      ok: false,
      forked: false,
      error: "pi_session_target_exists",
    });
    const forkEvents = await run(lifecycleRuntime, "pi-durable-fork-run", "pi-durable-fork");
    const forkRequest = forkEvents.find((event) => event.type === "model.requested");
    assert.match(
      JSON.stringify(forkRequest?.type === "model.requested" ? forkRequest.request.messages : []),
      /first persisted answer/,
    );
    assert.deepEqual(await lifecycleApp.deleteKernelSession("pi-durable-fork"), { ok: true, deleted: true });
    const remainingSessions = await lifecycleApp.listKernelSessions();
    assert.equal(remainingSessions.ok, true);
    assert.ok(!remainingSessions.sessions.some((session) => session.sessionId === "pi-durable-fork"));
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

async function assertNativePiRejectsActiveSessionDeletion(): Promise<void> {
  const model = nativeTestModel("pi-busy-session-model");
  let releaseStream!: () => void;
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "finished" }],
          api: "test",
          provider: "test",
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        queueMicrotask(async () => {
          stream.push({ type: "start", partial: message });
          markStreamStarted();
          await released;
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
    }),
  });
  const running = (async () => {
    for await (const _event of runtime.runTurn({
      runId: "pi-busy-session-run",
      input: "wait",
      context: createContext("pi-busy-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    })) {
      // Keep consuming until the native provider stream is released.
    }
  })();
  await streamStarted;
  assert.deepEqual(await runtime.deleteSession("pi-busy-session"), {
    ok: false,
    deleted: false,
    error: "pi_session_busy",
  });
  releaseStream();
  await running;
  assert.deepEqual(await runtime.deleteSession("pi-busy-session"), { ok: true, deleted: true });
}

async function assertNativePiCompaction(): Promise<void> {
  const model = nativeTestModel("pi-compaction-model");
  const models = createModels();
  let compactionCalls = 0;
  const stream = (_model: any, context: any) => {
    if (String(context.systemPrompt || "").includes("context summarization assistant")) {
      compactionCalls += 1;
      return nativeAssistantStream(model.id, [{ type: "text", text: "## Goal\nPreserve the tested conversation." }]);
    }
    return nativeAssistantStream(model.id, [{ type: "text", text: `long native answer ${"detail ".repeat(300)}` }]);
  };
  models.setProvider(
    createProvider({
      id: "test",
      name: "Test",
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      models: [model],
      api: { stream, streamSimple: stream } as any,
    }),
  );
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({ model, models }),
  });
  const run = async (runId: string) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId,
      input: `compaction input ${runId}`,
      context: createContext("pi-compaction-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      events.push(event);
    return events;
  };
  await run("pi-compaction-run-1");
  await run("pi-compaction-run-2");
  await run("pi-compaction-run-3");
  const result = await runtime.compactSession({
    runId: "pi-compaction-request",
    threadId: "pi-compaction-session",
    reason: "Harness compaction",
    maxTokens: 50,
  });
  assert.deepEqual(result, { ok: true, compacted: true });
  assert.ok(compactionCalls >= 1, "Pi should use its native summarization path");
  const after = await run("pi-compaction-run-4");
  const request = after.find((event) => event.type === "model.requested");
  assert.match(
    JSON.stringify(request?.type === "model.requested" ? request.request.messages : []),
    /conversation history before this point was compacted|Preserve the tested conversation/,
    "The next Pi provider request should receive the native compaction summary",
  );
}

async function assertNativePiUnconfiguredUsesModelWindow(): Promise<void> {
  const generousModel = {
    id: "pi-unconfigured-model",
    name: "Pi unconfigured model",
    api: "test",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 1_000,
  } as any;
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model: generousModel,
      streamFn: () => assistantStream("short answer", generousModel.id),
    }),
  });
  const run = async (runId: string, input: string) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId,
      input,
      context: createContext("pi-unconfigured-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      events.push(event);
    return events;
  };

  for (let turn = 1; turn <= 21; turn += 1) {
    await run(`pi-unconfigured-run-${turn}`, `small turn ${turn}`);
  }
  const events = await run("pi-unconfigured-run-22", "small turn 22");
  const trace = events.find((event) => event.type === "model.requested" && event.request.session?.provider === "pi");
  assert.ok(
    trace?.type === "model.requested" && (trace.request.session?.priorMessageCount ?? 0) > 40,
    "An undeclared Pi budget must not impose OpenGrove's historical 40-message cap",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.budgetSource === "unconfigured" &&
        event.data.requestedBudget === undefined &&
        event.data.effectiveBudget === undefined &&
        event.data.modelContextWindow === 200_000 &&
        event.data.compactionTriggered === false,
    ),
    "Pi should record the model-window fact without inventing an employee budget",
  );

  const constrainedModel = { ...generousModel, id: "pi-hard-window-model", contextWindow: 9_000 };
  const constrainedModels = createModels();
  let automaticCompactionCalls = 0;
  let constrainedRegularCalls = 0;
  const constrainedStream = (_model: any, nativeContext: any) => {
    if (String(nativeContext.systemPrompt || "").includes("context summarization assistant")) {
      automaticCompactionCalls += 1;
      return nativeAssistantStream(constrainedModel.id, [
        { type: "text", text: "## Goal\nPreserve the native window history." },
      ]);
    }
    constrainedRegularCalls += 1;
    return assistantStream(
      "large answer ".repeat(1_000),
      constrainedModel.id,
      constrainedRegularCalls === 1 ? 5_000 : 8_500,
    );
  };
  constrainedModels.setProvider(
    createProvider({
      id: "test",
      name: "Test",
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      models: [constrainedModel],
      api: { stream: constrainedStream, streamSimple: constrainedStream } as any,
    }),
  );
  const constrainedRuntime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model: constrainedModel,
      models: constrainedModels,
    }),
  });
  const constrainedRun = async (runId: string, input: string) => {
    const constrainedEvents: AgentEvent[] = [];
    for await (const event of constrainedRuntime.runTurn({
      runId,
      input,
      context: createContext("pi-hard-window-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      constrainedEvents.push(event);
    return constrainedEvents;
  };
  await constrainedRun("pi-hard-window-run-1", "first large turn");
  await constrainedRun("pi-hard-window-run-2", "second large turn");
  const constrainedEvents = await constrainedRun("pi-hard-window-run-3", "third large turn");
  const constrainedTrace = constrainedEvents.find(
    (event) => event.type === "model.requested" && event.request.session?.provider === "pi",
  );
  assert.ok(automaticCompactionCalls >= 1, "Pi should invoke its native summarizer before crossing the model window");
  assert.ok(constrainedEvents.some((event) => event.type === "compaction.started"));
  assert.ok(constrainedEvents.some((event) => event.type === "compaction.finished"));
  assert.ok(
    constrainedTrace?.type === "model.requested" &&
      /Preserve the native window history|conversation history before this point was compacted/.test(
        JSON.stringify(constrainedTrace.request.messages),
      ),
    "The provider request should receive Pi's persisted native compaction summary",
  );
  assert.ok(
    constrainedEvents.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.budgetSource === "unconfigured" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === true &&
        event.data.enforcementMode === "native-trigger",
    ),
    "Pi model-window compaction must remain observable without inventing a product budget",
  );
}

function assistantStream(text: string, modelId: string, totalTokens = 2) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "test",
      provider: "test",
      model: modelId,
      usage: {
        input: Math.max(1, totalTokens - 1),
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

async function assertNativePiCrossTurnBudgetEvents(): Promise<void> {
  const model = {
    id: "pi-budget-model",
    name: "Pi budget model",
    api: "test",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 5_000,
    maxTokens: 1_000,
  } as any;
  const models = createModels();
  let nativeCompactionCalls = 0;
  let regularCalls = 0;
  const stream = (_model: any, nativeContext: any) => {
    if (String(nativeContext.systemPrompt || "").includes("context summarization assistant")) {
      nativeCompactionCalls += 1;
      return nativeAssistantStream(model.id, [{ type: "text", text: "## Goal\nKeep the configured-budget history." }]);
    }
    regularCalls += 1;
    return assistantStream("long answer ".repeat(1_000), model.id, regularCalls === 1 ? 5_000 : 8_500);
  };
  models.setProvider(
    createProvider({
      id: "test",
      name: "Test",
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async () => ({ auth: { apiKey: "test-key" } }),
        },
      },
      models: [model],
      api: { stream, streamSimple: stream } as any,
    }),
  );
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      models,
    }),
  });

  const run = async (runId: string, input: string) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId,
      input,
      context: createContext("pi-budget-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      contextTokenBudget: 9_000,
    }))
      events.push(event);
    return events;
  };

  await run("pi-budget-run-1", "first turn");
  await run("pi-budget-run-2", "second turn");
  const thirdEvents = await run("pi-budget-run-3", "third turn");
  assert.ok(nativeCompactionCalls >= 1, "Pi should use native compaction for a configured context window");
  assert.ok(thirdEvents.some((event) => event.type === "compaction.started"));
  assert.ok(thirdEvents.some((event) => event.type === "compaction.finished"));
  assert.ok(
    thirdEvents.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === true &&
        event.data.enforcementMode === "native-trigger" &&
        event.runId === "pi-budget-run-3",
    ),
    "Pi's native compaction evidence must use the current turn's run id",
  );
  const outerTrace = thirdEvents.find(
    (event) => event.type === "model.requested" && event.request.session?.provider === "pi",
  );
  assert.ok(
    outerTrace?.type === "model.requested" &&
      /Keep the configured-budget history|conversation history before this point was compacted/.test(
        JSON.stringify(outerTrace.request.messages),
      ),
    "Pi trace should expose the native summary received by the next provider request",
  );
}

async function assertNativePiTerminalMessageBelongsToCurrentTurn(): Promise<void> {
  const model = nativeTestModel("pi-current-turn-model");
  let call = 0;
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: () =>
        nativeAssistantStream(model.id, [
          {
            type: "text",
            text: ++call === 1 ? "first turn answer" : "second turn answer",
          },
        ]),
    }),
  });
  const run = async (runId: string) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId,
      input: runId,
      context: createContext("pi-current-turn-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }))
      events.push(event);
    return events;
  };
  await run("pi-current-turn-1");
  const second = await run("pi-current-turn-2");
  assert.deepEqual(
    second
      .filter((event) => event.type === "assistant.delta")
      .map((event) => (event.type === "assistant.delta" ? event.text : "")),
    ["second turn answer"],
    "Pi agent_end.messages is current-turn scoped and must never replay a prior answer",
  );
  assert.deepEqual(
    second
      .filter((event) => event.type === "model.response")
      .map((event) => (event.type === "model.response" ? event.response.text : "")),
    ["second turn answer"],
  );
}

async function assertNativePiNeverTruncatesOversizedInput(): Promise<void> {
  const model = {
    ...nativeTestModel("pi-no-trim-model"),
    contextWindow: 20_000,
    maxTokens: 1_000,
  } as any;
  let providerCalls = 0;
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      model,
      streamFn: () => {
        providerCalls += 1;
        return assistantStream("must not run", model.id);
      },
    }),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "pi-no-trim-run",
    input: "oversized-current-input ".repeat(10_000),
    context: createContext("pi-no-trim-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 4_000,
  }))
    events.push(event);

  assert.equal(
    providerCalls,
    0,
    "Pi must fail before the provider call when native compaction cannot fit the current input",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "error" &&
        event.message.startsWith("context_window_exceeded_after_pi_compaction:") &&
        event.message.includes("Pi native compaction could not fit this conversation") &&
        event.message.includes("No conversation history was discarded"),
    ),
    "Pi must report an explicit context error instead of silently dropping input or history",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.enforcementMode === "native-trigger" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === false,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
