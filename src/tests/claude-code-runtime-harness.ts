import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type AgentContext, type AgentEvent } from "../core.js";
import { ClaudeCodeRuntime } from "../runtime/claude-code-runtime.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-runtime-"));
  const captureDir = join(cwd, "captures");
  const fakeClaude = join(cwd, "fake-claude.mjs");
  const argvPath = join(cwd, "argv.json");
  const providerEnvPath = join(cwd, "provider-env.json");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "let argvCalls = [];",
      `try { argvCalls = JSON.parse(readFileSync(${JSON.stringify(argvPath)}, 'utf8')); } catch { argvCalls = []; }`,
      "argvCalls.push(process.argv.slice(2));",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argvCalls, null, 2));`,
      "let providerEnvCalls = [];",
      `try { providerEnvCalls = JSON.parse(readFileSync(${JSON.stringify(providerEnvPath)}, 'utf8')); } catch { providerEnvCalls = []; }`,
      "providerEnvCalls.push({",
      "  managed: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST ?? null,",
      "  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,",
      "  apiKey: process.env.ANTHROPIC_API_KEY ?? null,",
      "  useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,",
      "  useVertex: process.env.CLAUDE_CODE_USE_VERTEX ?? null,",
      "  home: process.env.HOME ?? null,",
      "  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,",
      "});",
      `writeFileSync(${JSON.stringify(providerEnvPath)}, JSON.stringify(providerEnvCalls, null, 2));`,
      "console.log(JSON.stringify({",
      "  type: 'assistant',",
      "  message: { content: [",
      "    { type: 'text', text: 'hello from fake claude' },",
      "    { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [",
      "      { content: '读取需求', status: 'completed' },",
      "      { content: '继续分析', status: 'in_progress' }",
      "    ] } },",
      "    { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: '复查素材', prompt: '检查素材清单' } },",
      "    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }",
      "  ] }",
      "}));",
      "console.log(JSON.stringify({",
      "  type: 'user',",
      "  message: { content: [",
      "    { type: 'tool_result', tool_use_id: 'toolu_todo', content: 'todos updated' },",
      "    { type: 'tool_result', tool_use_id: 'toolu_task', content: 'task done' },",
      "    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'read ok' }",
      "  ] },",
      "  tool_use_result: { text: 'read ok' }",
      "}));",
      "console.log(JSON.stringify({ type: 'result', result: 'final fake claude result', is_error: false }));",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeClaude, 0o755);

  const runtime = new ClaudeCodeRuntime({
    cliPath: fakeClaude,
    cliKind: "node-script",
    cwd,
    configuredModel: "opus",
    modelAliases: { "glm-5.1": "opus" },
    permissionMode: "bypassPermissions",
    env: {
      ANTHROPIC_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      ANTHROPIC_BASE_URL: "https://host-provider.example.test",
      ANTHROPIC_API_KEY: "host-provider-key",
    },
    streamCapture: {
      enabled: true,
      dir: captureDir,
      includeRawIO: true,
    },
  });

  const events = [];
  const sessions = new SessionStore();
  const roomUserInput = [
    "[Message context]",
    "Source: 故事架构师 (employee delegation)",
    "(Another employee delegated this message to you. This kernel cannot read the room ledger; tell the author clearly if context is insufficient.)",
    "",
    "[Current message #57]",
    "",
    "<current-message>",
    "@金牌编辑 请审核章节大纲。",
    "</current-message>",
  ].join("\n");
  const context = {
    sessionId: "claude-runtime-harness",
    activity: "browser",
    sessions,
  } as AgentContext;
  for await (const event of runtime.runTurn({
    input: roomUserInput,
    context,
    tools: [],
    replyLanguagePreference: "zh-CN",
    requestedModelId: "glm-5.1",
    runtimeEnv: {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://user-provider.example.test",
      ANTHROPIC_API_KEY: "user-provider-key",
    },
    skills: [],
    packs: [],
    capabilities: [],
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
      promptBlock: [
        "Host marker: CLAUDE_CONTEXT_VISIBLE",
        "房间协作规则：",
        "- 当前运行方式不能读取房间账本，也不能真实委派员工。",
        "当前房间：故事种子（room-story-seed）",
      ].join("\n"),
    },
  })) {
    events.push(event);
  }

  const secondEvents = [];
  for await (const event of runtime.runTurn({
    input: "hello again",
    context,
    tools: [],
    replyLanguagePreference: "en",
    requestedModelId: "glm-5.1",
    skills: [],
    packs: [],
    capabilities: [],
  })) {
    secondEvents.push(event);
  }

  const cancelingClaude = join(cwd, "fake-claude-cancel.mjs");
  writeFileSync(
    cancelingClaude,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial before cancel' }] } }));",
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
    "utf8",
  );
  chmodSync(cancelingClaude, 0o755);
  const cancelingRuntime = new ClaudeCodeRuntime({
    cliPath: cancelingClaude,
    cliKind: "node-script",
    cwd,
    permissionMode: "bypassPermissions",
  });
  const cancelController = new AbortController();
  const canceledEvents: AgentEvent[] = [];
  for await (const event of cancelingRuntime.runTurn({
    runId: "run-claude-code-canceled-partial",
    input: "produce a partial response",
    context: { ...context, sessionId: "claude-code-canceled-partial" },
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    signal: cancelController.signal,
  })) {
    canceledEvents.push(event);
    if (event.type === "assistant.delta") cancelController.abort();
  }
  assert.ok(
    canceledEvents.some((event) => event.type === "assistant.final" && event.text.includes("partial before cancel")),
    "a canceled Claude CLI turn should preserve partial text as an incomplete artifact",
  );
  assert.equal(
    canceledEvents.some((event) => event.type === "model.response"),
    false,
    "a canceled Claude CLI turn must not promote partial output to a successful model.response",
  );
  assert.ok(
    canceledEvents.some((event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_CANCELED"),
  );

  const argvCalls = JSON.parse(readFileSync(argvPath, "utf8")) as string[][];
  const providerEnvCalls = JSON.parse(readFileSync(providerEnvPath, "utf8")) as Array<Record<string, string | null>>;
  assert.deepEqual(
    providerEnvCalls,
    [
      {
        managed: "1",
        baseUrl: "https://host-provider.example.test",
        apiKey: "host-provider-key",
        useBedrock: null,
        useVertex: null,
        home: providerEnvCalls[0]?.home,
        configDir: null,
      },
      {
        managed: "1",
        baseUrl: "https://host-provider.example.test",
        apiKey: "host-provider-key",
        useBedrock: null,
        useVertex: null,
        home: providerEnvCalls[1]?.home,
        configDir: null,
      },
    ],
    "Claude CLI should keep the host-managed provider authoritative across turns",
  );
  assert.match(providerEnvCalls[0]?.home ?? "", /opengrove-claude-/);
  assert.match(providerEnvCalls[1]?.home ?? "", /opengrove-claude-/);
  assert.equal(
    providerEnvCalls[1]?.home,
    providerEnvCalls[0]?.home,
    "One runtime should reuse its isolated Claude HOME",
  );
  assert.equal(argvCalls.length, 2, "Harness should have launched Claude twice");
  const argv = argvCalls[0] ?? [];
  const resumeArgv = argvCalls[1] ?? [];
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  assert.ok(argv.includes("--permission-mode"));
  assert.ok(argv.includes("bypassPermissions"));
  assert.ok(argv.includes("--session-id"));
  assert.ok(!argv.includes("--resume"));
  assert.ok(resumeArgv.includes("--resume"), "Second turn should resume the existing Claude session");
  assert.ok(!resumeArgv.includes("--session-id"), "Second turn must not try to recreate the same Claude session");
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("opus"));
  assert.ok(!argv.includes("glm-5.1"), "provider model should not be passed as Claude Code --model");
  assert.ok(argv.includes("--append-system-prompt"));
  assert.match(argv.join("\n"), /CLAUDE_CONTEXT_VISIBLE/);
  const systemPromptIndex = argv.indexOf("--append-system-prompt");
  const cliSystemPrompt = argv[systemPromptIndex + 1] ?? "";
  const resumeSystemPromptIndex = resumeArgv.indexOf("--append-system-prompt");
  const resumeSystemPrompt = resumeArgv[resumeSystemPromptIndex + 1] ?? "";
  const cliUserInput = argv.at(-1) ?? "";
  assert.match(cliSystemPrompt, /Claude CLI 能力边界/);
  assert.match(cliSystemPrompt, /不能读取房间账本/);
  assert.match(cliSystemPrompt, /不能真实委派员工/);
  assert.match(cliSystemPrompt, /当前房间：故事种子/);
  assert.match(cliSystemPrompt, /Default response language: Simplified Chinese/);
  assert.match(cliSystemPrompt, /primary natural language of the current input/);
  assert.ok(
    cliSystemPrompt.endsWith(
      "Default response language: Simplified Chinese. Follow the primary natural language of the current input unless it explicitly requests another language.",
    ),
    "the concise preference should remain visible after the larger host context",
  );
  assert.doesNotMatch(cliSystemPrompt, /room\.ledger\.read|room\.delegate\.task/);
  assert.match(resumeSystemPrompt, /OpenGrove Claude CLI capability boundary/);
  assert.match(resumeSystemPrompt, /OpenGrove Host Tools are not available/);
  assert.doesNotMatch(resumeSystemPrompt, /能力边界|不得声称/);
  assert.ok(
    resumeSystemPrompt.endsWith(
      "Default response language: English. Follow the primary natural language of the current input unless it explicitly requests another language.",
    ),
    "the English preference and boundary should remain visible on resumed turns",
  );
  assert.match(cliUserInput, /\[Message context\]/);
  assert.match(cliUserInput, /Source: 故事架构师 \(employee delegation\)/);
  assert.match(cliUserInput, /<current-message>\n@金牌编辑 请审核章节大纲。\n<\/current-message>$/);
  assert.match(cliUserInput, /@金牌编辑 请审核章节大纲。/);
  assert.match(cliUserInput, /This kernel cannot read the room ledger/);
  assert.doesNotMatch(cliUserInput, /response language|language preference/i);
  assert.doesNotMatch(cliUserInput, /Read the room ledger before acting/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "claude.host_tools.configured" &&
        event.data.runtimeMode === "cli" &&
        event.data.available === false,
    ),
  );

  assert.ok(
    events.some((event) => event.type === "assistant.delta" && event.text.includes("fake claude")),
    "assistant text should stream into OpenGrove events",
  );
  assert.ok(
    events.some((event) => event.type === "tool.started" && event.toolId === "claude.Read"),
    "Claude tool_use should map to tool.started",
  );
  assert.ok(
    events.some((event) => event.type === "tool.finished" && event.toolId === "claude.Read"),
    "Claude tool_result should map to tool.finished",
  );
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "tool.started" | "tool.finished" }> =>
          (event.type === "tool.started" || event.type === "tool.finished") && event.toolId === "claude.Read",
      )
      .map((event) => event.callId),
    ["toolu_1", "toolu_1"],
  );
  const todoPlan = events.find((event) => event.type === "planning.updated" && event.plan.title === "TodoWrite");
  assert.ok(todoPlan && todoPlan.type === "planning.updated", "Claude TodoWrite should map to planning.updated");
  assert.deepEqual(todoPlan.plan.source, { type: "kernel.native", kernelId: "claude-code" });
  assert.match(todoPlan.plan.text, /读取需求/);
  assert.match(todoPlan.plan.text, /继续分析/);
  assert.equal(
    events.some((event) => event.type === "planning.updated" && event.plan.title === "Task"),
    false,
    "Task fallback should not overwrite TodoWrite planning in the same run",
  );
  const response = events.find((event) => event.type === "model.response");
  assert.ok(response && response.type === "model.response");
  assert.equal(response.response.text, "final fake claude result");
  assert.ok(
    events.some((event) => event.type === "turn.finished"),
    "turn should finish",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
