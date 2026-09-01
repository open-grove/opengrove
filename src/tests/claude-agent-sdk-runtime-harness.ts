import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentContext, AgentEvent } from "../core.js";
import { ClaudeAgentSdkRuntime, type ClaudeAgentSdkQueryFunction } from "../runtime/claude-agent-sdk-runtime.js";
import { createClaudeSdkHostBridge } from "../runtime/claude-agent-sdk-tools.js";
import { AsyncEventQueue } from "../runtime/codex/async-event-queue.js";
import {
  claudePlanningEventsForToolFinished,
  claudePlanningEventsForToolStarted,
  createClaudePlanningState,
} from "../runtime/claude-planning.js";
import { CLAUDE_CODE_KERNEL_CONTRACT } from "../kernel/adapters/claude-code.js";
import { inspectAgentTurnEvents } from "./harnesses/kernel-event-contract.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-sdk-"));
  const app = createOpenGrove({
    cwd,
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
    readPage: () => ({
      title: "Harness Page",
      url: "https://example.com",
      selection: "selected text",
      locator: "harness-selection",
    }),
    sessionId: "claude-sdk-harness",
  });

  const canceledPermissionController = new AbortController();
  const canceledPermissionBridge = createClaudeSdkHostBridge(
    {
      runId: "run-system-canceled-permission",
      input: "cancel the native permission request",
      context: {
        sessionId: "session-system-canceled-permission",
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
      signal: canceledPermissionController.signal,
    },
    "run-system-canceled-permission",
    new AsyncEventQueue<AgentEvent>(),
  );
  const canceledPermission = canceledPermissionBridge.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: canceledPermissionController.signal,
      toolUseID: "toolu-system-canceled-permission",
      requestId: "request-system-canceled-permission",
      description: "Run pwd",
    },
  );
  canceledPermissionController.abort();
  const canceledPermissionResult = await canceledPermission;
  assert.equal(canceledPermissionResult?.behavior, "deny");
  assert.equal(canceledPermissionResult?.decisionClassification, undefined);
  assert.equal(canceledPermissionResult?.interrupt, true);
  assert.match(canceledPermissionResult?.message ?? "", /No user decision was recorded/);
  assert.doesNotMatch(canceledPermissionResult?.message ?? "", /Rejected by user/);

  const userCanceledController = new AbortController();
  const userCanceledBridge = createClaudeSdkHostBridge(
    {
      runId: "run-user-canceled-permission",
      input: "let the user cancel the native permission request",
      context: {
        sessionId: "session-user-canceled-permission",
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
      signal: userCanceledController.signal,
    },
    "run-user-canceled-permission",
    new AsyncEventQueue<AgentEvent>(),
  );
  const userCanceledPermission = userCanceledBridge.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: userCanceledController.signal,
      toolUseID: "toolu-user-canceled-permission",
      requestId: "request-user-canceled-permission",
      description: "Run pwd",
    },
  );
  const pendingUserCanceledApproval = app.approvals.list().find((item) => item.status === "pending");
  assert.ok(pendingUserCanceledApproval);
  app.approvals.decide(pendingUserCanceledApproval.id, "canceled", {
    system: false,
    reasonCode: "user_canceled",
  });
  const userCanceledPermissionResult = await userCanceledPermission;
  assert.equal(userCanceledPermissionResult?.behavior, "deny");
  assert.equal(userCanceledPermissionResult?.decisionClassification, undefined);
  assert.equal(userCanceledPermissionResult?.interrupt, true);
  assert.match(userCanceledPermissionResult?.message ?? "", /user canceled this Run/i);
  assert.doesNotMatch(userCanceledPermissionResult?.message ?? "", /Rejected by user/);

  let capturedPrompt = "";
  let capturedSystemPrompt = "";
  let capturedModel = "";
  let capturedEnvModel = "";
  let capturedEnvOpusModel = "";
  let capturedProviderManagedByHost = "";
  let capturedAnthropicBaseUrl = "";
  let capturedBedrockBaseUrl = "";
  let capturedVertexFlag = "";
  const capturedSettingSources: string[][] = [];
  let capturedEnvHttpsProxy = "";
  let capturedEnvHttpProxy = "";
  let capturedMaxBudgetUsd = 0;
  let capturedContextTokenBudget = "";
  let capturedSkills: string[] | "all" | undefined;
  const capturedSupportedDialogKinds: Array<string[] | undefined> = [];
  const capturedUserDialogHandlers: boolean[] = [];
  let capturedCompactPrompt = "";
  let capturedCompactResume = "";
  let capturedContextUsageRequests = 0;
  let sawMcpServer = false;
  let sawAskUserQuestion = false;
  const fakeQuery: ClaudeAgentSdkQueryFunction = ((params) => {
    capturedPrompt = typeof params.prompt === "string" ? params.prompt : "";
    const systemPrompt = params.options?.systemPrompt;
    capturedSystemPrompt =
      typeof systemPrompt === "string"
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt.join("\n")
          : typeof systemPrompt?.append === "string"
            ? systemPrompt.append
            : "";
    capturedModel = params.options?.model ?? "";
    capturedEnvModel = params.options?.env?.ANTHROPIC_MODEL ?? "";
    capturedEnvOpusModel = params.options?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "";
    capturedProviderManagedByHost = params.options?.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST ?? "";
    capturedAnthropicBaseUrl = params.options?.env?.ANTHROPIC_BASE_URL ?? "";
    capturedBedrockBaseUrl = params.options?.env?.ANTHROPIC_BEDROCK_BASE_URL ?? "";
    capturedVertexFlag = params.options?.env?.CLAUDE_CODE_USE_VERTEX ?? "";
    capturedSettingSources.push([...(params.options?.settingSources ?? [])]);
    capturedEnvHttpsProxy = params.options?.env?.HTTPS_PROXY ?? "";
    capturedEnvHttpProxy = params.options?.env?.HTTP_PROXY ?? "";
    capturedMaxBudgetUsd = params.options?.maxBudgetUsd ?? 0;
    capturedContextTokenBudget = params.options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "";
    capturedSkills = params.options?.skills;
    capturedSupportedDialogKinds.push(params.options?.supportedDialogKinds);
    capturedUserDialogHandlers.push(params.options?.onUserDialog !== undefined);
    sawMcpServer = Boolean(params.options?.mcpServers?.opengrove);
    if (params.prompt === "/compact") {
      capturedCompactPrompt = params.prompt;
      capturedCompactResume = params.options?.resume ?? "";
      async function* messages() {
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-5000-8000-000000000021",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 123,
            post_tokens: 45,
            duration_ms: 10,
          },
          uuid: "00000000-0000-5000-8000-000000000022",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
          uuid: "00000000-0000-5000-8000-000000000023",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }
    async function* messages() {
      yield {
        type: "system",
        subtype: "init",
        apiKeySource: "user",
        claude_code_version: "2.1.fake",
        cwd,
        tools: ["Read", "Bash"],
        mcp_servers: [{ name: "opengrove", status: "connected" }],
        model: "claude-test",
        permissionMode: "default",
        slash_commands: ["/compact", "/model", "/status"],
        output_style: "default",
        skills: ["demo-skill"],
        plugins: [],
        uuid: "00000000-0000-5000-8000-000000000001",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      const permission = await params.options?.canUseTool?.(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Pick one?",
              header: "Choice",
              options: [
                { label: "A", description: "Use A." },
                { label: "B", description: "Use B." },
              ],
              multiSelect: false,
            },
          ],
        },
        {
          signal: params.options?.abortController?.signal ?? new AbortController().signal,
          title: "Claude needs input",
          displayName: "Ask",
          description: "Pick a branch",
          toolUseID: "toolu_question",
          requestId: "request_question",
        },
      );
      sawAskUserQuestion = Boolean(
        permission?.behavior === "allow" &&
          permission.updatedInput?.answers &&
          (permission.updatedInput.answers as Record<string, string>)["Pick one?"] === "A",
      );
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Considering the request" },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-00000000000a",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello " },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-000000000003",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "from sdk" },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-000000000004",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "assistant",
        message: {
          id: "msg_todo_tools",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_todo",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "读取需求", status: "completed" },
                  { content: "继续分析", status: "in_progress" },
                ],
              },
            },
            {
              type: "tool_use",
              id: "toolu_task",
              name: "Task",
              input: { description: "复查素材", prompt: "检查素材清单" },
            },
          ],
          stop_reason: "tool_use",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-000000000006",
        session_id: "00000000-0000-5000-8000-000000000002",
        request_id: "req-claude-sdk-test",
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_todo", content: "todos updated" },
            { type: "tool_result", tool_use_id: "toolu_task", content: "task done" },
          ],
        },
        tool_use_result: { text: "task done" },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-000000000007",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "assistant",
        message: {
          id: "msg_task_create",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task_create",
              name: "TaskCreate",
              input: { subject: "准备回复", description: "准备最终回复" },
            },
          ],
          stop_reason: "tool_use",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-00000000000b",
        session_id: "00000000-0000-5000-8000-000000000002",
        request_id: "req-claude-sdk-task-create",
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task_create", content: "task created" }],
        },
        tool_use_result: { task: { id: "task-sdk-1", subject: "准备回复" } },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-00000000000c",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "assistant",
        message: {
          id: "msg_task_update",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task_update",
              name: "TaskUpdate",
              input: { taskId: "task-sdk-1", status: "completed" },
            },
          ],
          stop_reason: "tool_use",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-00000000000d",
        session_id: "00000000-0000-5000-8000-000000000002",
        request_id: "req-claude-sdk-task-update",
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task_update", content: "task updated" }],
        },
        tool_use_result: {
          success: true,
          taskId: "task-sdk-1",
          updatedFields: ["status"],
          statusChange: { from: "pending", to: "completed" },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-5000-8000-00000000000e",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 5,
        is_error: false,
        num_turns: 1,
        result: "final sdk result",
        stop_reason: "end_turn",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-5000-8000-000000000005",
        session_id: "00000000-0000-5000-8000-000000000002",
      };
    }
    const iterator = messages();
    return Object.assign(iterator, {
      close() {},
      getContextUsage: async () => {
        capturedContextUsageRequests += 1;
        return {
          categories: [
            { name: "System prompt", tokens: 10_000, color: "blue" },
            { name: "Messages", tokens: 42_000, color: "green" },
          ],
          totalTokens: 52_000,
          maxTokens: 150_000,
          rawMaxTokens: 200_000,
          percentage: 26,
          gridRows: [],
          model: "claude-test",
          memoryFiles: [],
          mcpTools: [],
        };
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
      getSettings: async () => ({}),
    }) as unknown;
  }) as ClaudeAgentSdkQueryFunction;

  const runtime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    modelAliases: { "glm-5.1": "opus" },
    env: {
      ANTHROPIC_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: "ABSKharness-bedrock-test-key",
      OPENGROVE_CLAUDE_BEDROCK_PROXY_URL: "http://127.0.0.1:7897",
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      ALL_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      all_proxy: "",
    },
    query: fakeQuery,
  });

  const events: AgentEvent[] = [];
  const claudeRequiredSkill = app.skills.list()[0];
  assert.ok(claudeRequiredSkill);
  const roomUserInput = [
    "[Message context]",
    "Source: 故事架构师 (employee delegation)",
    "(Another employee delegated this message to you. Read the room ledger before acting so you understand the relevant context.)",
    "",
    "[Current message #57]",
    "",
    "<current-message>",
    "@金牌编辑 请审核章节大纲。",
    "</current-message>",
  ].join("\n");
  const context: AgentContext = {
    sessionId: "claude-sdk-harness",
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
  };

  for await (const event of runtime.runTurn({
    input: roomUserInput,
    context,
    replyLanguagePreference: "zh-CN",
    assembledContext: {
      id: "context-required-skill",
      createdAt: new Date(0).toISOString(),
      summary: "required employee skills",
      budget: { maxItems: 10, usedItems: 1, maxCharacters: 10_000, usedCharacters: 64, truncated: false },
      items: [],
      promptBlock: [
        "OpenGrove required employee skills:",
        `## Required skill: ${claudeRequiredSkill.name}`,
        `SKILL.md: ${claudeRequiredSkill.entry}`,
        "Host preflight: available",
        "Load this Skill before acting.",
        "房间协作规则：",
        "- 如果本消息来自另一名员工，行动前必须调用 room.ledger.read。",
        "- 用户要求你联系另一名员工时，必须调用 room.delegate.task。",
        "当前房间：故事种子（room-story-seed）",
      ].join("\n"),
    },
    tools: app.tools.list(),
    requestedModelId: "glm-5.1",
    budgetLimitUsd: 0.25,
    contextTokenBudget: 150_000,
    runtimeEnv: {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_BASE_URL: "https://user-vertex.example.test",
      ANTHROPIC_BASE_URL: "https://user-provider.example.test",
      ANTHROPIC_AUTH_TOKEN: "user-provider-token",
      AWS_REGION: "ap-southeast-1",
    },
    skills: app.skills.list().filter((skill) => skill.id !== claudeRequiredSkill.id),
    requiredSkillRequirements: [
      {
        configuredName: claudeRequiredSkill.name,
        manifest: claudeRequiredSkill,
        sourcePath: claudeRequiredSkill.entry,
        hostLoadStatus: "available",
        modelLoadAllowed: true,
      },
    ],
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    events.push(event);
    if (event.type === "question.requested") {
      app.questions.decide(event.question.id, "answered", { answers: { Choice: "A" } });
    }
  }

  assert.equal(capturedPrompt, roomUserInput);
  assert.match(capturedPrompt, /<current-message>\n@金牌编辑 请审核章节大纲。\n<\/current-message>$/);
  assert.match(capturedSystemPrompt, /room\.ledger\.read/);
  assert.match(capturedSystemPrompt, /room\.delegate\.task/);
  assert.match(capturedSystemPrompt, /当前房间：故事种子/);
  assert.match(capturedSystemPrompt, /Default response language: Simplified Chinese/);
  assert.match(capturedSystemPrompt, /primary natural language of the current input/);
  assert.ok(
    capturedSystemPrompt.endsWith(
      "Default response language: Simplified Chinese. Follow the primary natural language of the current input unless it explicitly requests another language.",
    ),
    "the concise preference should remain visible after the larger host context",
  );
  assert.doesNotMatch(capturedSystemPrompt, /Claude CLI 降级模式/);
  assert.deepEqual(
    capturedSkills,
    [
      ...app.skills
        .list()
        .filter((skill) => skill.id !== claudeRequiredSkill.id)
        .map((skill) => skill.name),
      claudeRequiredSkill.name,
    ],
    "Claude SDK must keep the required Skill enabled alongside the employee's available allow-list.",
  );
  assert.match(capturedSystemPrompt, /Load this Skill before acting/);
  assert.match(capturedSystemPrompt, /Employee optional skill scope/);
  assert.match(capturedSystemPrompt, /SKILL\.md:/);
  assert.equal(capturedModel, "opus", "Claude SDK should receive a Claude Code family alias");
  assert.equal(capturedEnvModel, "glm-5.1", "Provider model should stay in Claude env mapping");
  assert.equal(capturedEnvOpusModel, "glm-5.1", "Provider model should map the Opus family");
  assert.equal(capturedProviderManagedByHost, "1", "Claude SDK should receive the host-managed provider marker");
  assert.deepEqual(capturedSettingSources[0], [], "Host-managed providers must isolate Claude filesystem settings");
  assert.equal(capturedAnthropicBaseUrl, "", "Per-turn env must not replace a host-managed provider");
  assert.equal(capturedVertexFlag, "", "Per-turn env must not add a competing provider mode");
  assert.equal(
    capturedBedrockBaseUrl,
    "https://bedrock-runtime.us-west-2.amazonaws.com",
    "Host-managed Bedrock configuration should remain authoritative",
  );
  assert.equal(capturedEnvHttpsProxy, "http://127.0.0.1:7897", "Bedrock env should inherit the configured local proxy");
  assert.equal(capturedEnvHttpProxy, "http://127.0.0.1:7897", "Bedrock env should set HTTP proxy for Claude Code");
  assert.equal(capturedMaxBudgetUsd, 0.25, "Claude SDK should receive the hard budget limit");
  assert.equal(
    capturedContextTokenBudget,
    "150000",
    "Claude Code should receive its native absolute auto-compact window",
  );
  assert.deepEqual(
    capturedSupportedDialogKinds[0],
    [],
    "OpenGrove must not advertise native Claude dialogs it cannot render",
  );
  assert.equal(capturedUserDialogHandlers[0], false, "OpenGrove must not register a native Claude dialog renderer");
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.enforcementMode === "native-auto" &&
        event.data.effectiveBudget === 150000,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.reason === "turn-final" &&
        event.data.compactionTriggered === false,
    ),
    "Claude Code should record the final native compaction outcome for every turn",
  );
  assert.equal(sawMcpServer, true, "OpenGrove MCP server should be exposed to Claude SDK");
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "claude.host_tools.configured" &&
        event.data.runtimeMode === "sdk" &&
        event.data.available === true,
    ),
  );
  assert.equal(sawAskUserQuestion, true, "AskUserQuestion should round-trip through OpenGrove question UI");
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "claude.policy.configured" &&
        event.data.permissionMode === "default",
    ),
  );
  const queryDiagnostic = events.find(
    (event) => event.type === "runtime.diagnostic" && event.name === "claude.sdk.query.configured",
  );
  assert.ok(queryDiagnostic?.type === "runtime.diagnostic");
  assert.equal(queryDiagnostic.data.sessionMode, "new");
  assert.equal(queryDiagnostic.data.resume, false);
  assert.deepEqual(queryDiagnostic.data.settingSources, []);
  assert.equal((queryDiagnostic.data.systemPrompt as { preset?: string } | undefined)?.preset, "claude_code");
  assert.equal("append" in (queryDiagnostic.data.systemPrompt as Record<string, unknown>), false);
  assert.equal(
    (queryDiagnostic.data.systemPrompt as { appendLength?: number }).appendLength,
    capturedSystemPrompt.length,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "claude.budget.configured" &&
        event.data.maxBudgetUsd === 0.25,
    ),
  );
  assert.ok(events.some((event) => event.type === "runtime.diagnostic" && event.name === "claude.sdk.init"));
  assert.equal(
    events.some((event) => event.type === "runtime.diagnostic" && event.name === "claude.sdk.request"),
    false,
    "request correlation must not create a user-consumed runtime event",
  );
  assertClaudeSdkContractCoversRuntimeEvents(events);
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.text === "hello from sdk"));
  // Native thinking is visible as process activity, but is not relabeled as a reasoning summary
  // and never enters the answer channel.
  const reasoningStartIdx = events.findIndex((event) => String(event.type) === "reasoning.started");
  const reasoningFinished = events.find((event) => String(event.type) === "reasoning.completed") as unknown as
    | {
        reasoning?: { kind?: string; kernelId?: string; text?: string };
      }
    | undefined;
  const firstAnswerDeltaIdx = events.findIndex((event) => event.type === "assistant.delta");
  assert.ok(reasoningStartIdx >= 0, "reasoning.started should be emitted for Claude thinking deltas");
  assert.ok(reasoningFinished, "reasoning.completed should be emitted");
  assert.equal(reasoningFinished?.reasoning?.kind, "native");
  assert.equal(reasoningFinished?.reasoning?.kernelId, "claude-code");
  assert.match(reasoningFinished?.reasoning?.text ?? "", /Considering the request/);
  assert.equal(
    events.some(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.finished") && event.toolId === "claude.reasoning",
    ),
    false,
    "Claude reasoning must not masquerade as a tool call",
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "assistant.delta" && /Considering the request/.test(event.text)) ||
        (event.type === "model.response" && /Considering the request/.test(event.response.text)),
    ),
    false,
    "native thinking must not enter the answer channel",
  );
  assert.ok(reasoningStartIdx < firstAnswerDeltaIdx, "reasoning should be emitted before the answer text");
  const todoPlan = events.find(
    (event): event is Extract<AgentEvent, { type: "planning.updated" }> =>
      event.type === "planning.updated" && event.plan.title === "TodoWrite",
  );
  assert.ok(todoPlan, "Claude SDK TodoWrite should map to planning.updated");
  assert.deepEqual(todoPlan.plan.source, { type: "kernel.native", kernelId: "claude-code" });
  assert.match(todoPlan.plan.text, /读取需求/);
  assert.match(todoPlan.plan.text, /继续分析/);
  assert.equal(
    events.some((event) => event.type === "planning.updated" && event.plan.title === "Task"),
    false,
    "Task fallback should not overwrite TodoWrite planning in the same run",
  );
  const taskPlans = events.filter(
    (event): event is Extract<AgentEvent, { type: "planning.updated" }> =>
      event.type === "planning.updated" && event.plan.id === "claude-tasks",
  );
  assert.ok(taskPlans.length >= 2, "Claude SDK TaskCreate and TaskUpdate should refresh one stable task plan");
  assert.equal(taskPlans.at(-1)?.plan.text, "1. [completed] 准备回复");
  assertClaudeTaskUpdatePlanningProjection();
  const response = events.find(
    (event): event is Extract<AgentEvent, { type: "model.response" }> => event.type === "model.response",
  );
  const request = events.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.equal(request?.request.modelId, "opus");
  assert.equal(response?.response.text, "final sdk result");
  const resultDiagnostic = events.find(
    (event) => event.type === "runtime.diagnostic" && event.name === "claude.sdk.result",
  );
  assert.ok(resultDiagnostic?.type === "runtime.diagnostic");
  assert.equal(resultDiagnostic.data.resultTextLength, "final sdk result".length);
  assert.equal("output" in resultDiagnostic.data, false, "the SDK result must not duplicate model.response text");
  assert.equal(resultDiagnostic.data.isError, false);
  assert.equal(resultDiagnostic.data.requestId, "req-claude-sdk-task-update");
  assert.deepEqual(resultDiagnostic.data.providerMessageIds, ["msg_todo_tools", "msg_task_create", "msg_task_update"]);
  assert.equal("raw" in resultDiagnostic.data, false, "the SDK result must not duplicate its complete raw payload");
  assert.deepEqual(response?.response.usage, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 26,
    costUsd: 0.0123,
    latencyMs: 10,
    contextWindowSize: 150_000,
    contextUsedTokens: 52_000,
    contextBreakdown: [
      { category: "System prompt", tokens: 10_000 },
      { category: "Messages", tokens: 42_000 },
    ],
  });
  assert.equal(capturedContextUsageRequests, 1);
  for await (const event of runtime.runTurn({
    input: "continue with the same session",
    context,
    tools: app.tools.list(),
    requestedModelId: "glm-5.1",
    contextTokenBudget: 180_000,
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    if (event.type === "question.requested") {
      app.questions.decide(event.question.id, "answered", { answers: { Choice: "A" } });
    }
  }
  assert.equal(
    capturedContextTokenBudget,
    "180000",
    "the session's 150k usable window must not shrink the next turn's 180k configured budget below the 200k raw model window",
  );
  assert.equal(capturedContextUsageRequests, 2);
  assert.deepEqual(JSON.parse(app.workingState.get().toolSchemaCache["claude.slashCommands"] || "[]"), [
    "/compact",
    "/model",
    "/status",
  ]);
  const compactResult = await runtime.compactSession({
    threadId: "claude-sdk-harness",
    reason: "harness compact probe",
  });
  assert.deepEqual(compactResult, { ok: true, compacted: true });
  assert.deepEqual(capturedSettingSources.at(-1), [], "Compaction must keep host-managed provider isolation");
  assert.deepEqual(
    capturedSupportedDialogKinds.at(-1),
    [],
    "Compaction must keep native Claude dialogs disabled when resuming the worker",
  );
  assert.equal(
    capturedUserDialogHandlers.at(-1),
    false,
    "Compaction must not register a native Claude dialog renderer",
  );
  assert.equal(capturedCompactPrompt, "/compact");
  assert.equal(capturedCompactResume, "00000000-0000-5000-8000-000000000002");

  let capturedNativeSettingSources: string[] = [];
  const toolPreambleRuntime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: ((params) => {
      capturedNativeSettingSources = [...(params.options?.settingSources ?? [])];
      async function* messages() {
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg_tool_preamble", type: "message", role: "assistant", content: [] },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000401",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Hidden chain should stay out of commentary" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000402",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000403",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "我先检查环境。" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000404",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000405",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pwd" } },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000406",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000407",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000408",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "assistant",
          message: {
            id: "msg_tool_preamble",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "我先检查环境。" },
              { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pwd" } },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040a",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000409",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg_final_answer", type: "message", role: "assistant", content: [] },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040b",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Second native reasoning block" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000411",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        // Compatible providers can publish an intermediate complete assistant
        // snapshot for a reasoning block before the same native message starts
        // its answer text block. It shares message.id with the later answer.
        yield {
          type: "assistant",
          message: {
            id: "msg_final_answer",
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000412",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040c",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "这是最终答案。" },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040d",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040e",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "assistant",
          message: {
            id: "msg_final_answer",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "这是最终答案。" }],
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-00000000040f",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000410",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        for (const uuid of ["00000000-0000-5000-8000-000000000413", "00000000-0000-5000-8000-000000000414"]) {
          yield {
            type: "assistant",
            message: {
              id: "msg_final_answer",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "这是最终答案。" }],
              stop_reason: "end_turn",
              stop_sequence: null,
            },
            parent_tool_use_id: null,
            uuid,
            session_id: "00000000-0000-5000-8000-000000000002",
          };
        }
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 5,
          is_error: false,
          num_turns: 1,
          result: "这是最终答案。",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-5000-8000-00000000040b",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  const toolPreambleEvents: AgentEvent[] = [];
  for await (const event of toolPreambleRuntime.runTurn({
    input: "tool preamble",
    context: { ...context, sessionId: "claude-sdk-tool-preamble-harness" },
    tools: app.tools.list(),
    requestedModelId: "opus",
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    toolPreambleEvents.push(event);
  }
  assert.deepEqual(
    capturedNativeSettingSources,
    ["user", "project", "local"],
    "Native Claude sessions should keep the user's normal filesystem settings",
  );
  const preambleStatuses = toolPreambleEvents.filter(
    (event): event is Extract<AgentEvent, { type: "assistant.status" }> =>
      event.type === "assistant.status" && event.text === "我先检查环境。",
  );
  assert.equal(preambleStatuses.length, 1, "Claude tool-use preamble should emit one assistant.status");
  assert.equal(preambleStatuses[0]!.data?.source, "claude-sdk");
  assert.equal(preambleStatuses[0]!.data?.kind, "agent_message");
  assert.equal(preambleStatuses[0]!.data?.phase, "commentary");
  assert.equal(preambleStatuses[0]!.data?.claudeKind, "tool_use_preamble");
  assert.equal(preambleStatuses[0]!.data?.stopReason, "tool_use");
  assert.equal(
    toolPreambleEvents.some((event) => event.type === "assistant.delta" && event.text.includes("我先检查环境")),
    false,
    "Claude tool-use preamble should not be answer text",
  );
  assert.equal(
    toolPreambleEvents.filter((event) => event.type === "tool.started" && event.toolId === "claude.Bash").length,
    1,
    "complete assistant message should still emit the Claude tool call once",
  );
  const bashStarted = toolPreambleEvents.find(
    (event): event is Extract<AgentEvent, { type: "tool.started" }> =>
      event.type === "tool.started" && event.toolId === "claude.Bash",
  );
  assert.equal(bashStarted?.callId, "toolu_bash");
  assert.deepEqual(
    toolPreambleEvents
      .filter((event): event is Extract<AgentEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
      .map((event) => event.text),
    ["这是最终答案。"],
    "Claude's complete assistant message and trailing message_stop must not replay streamed answer text",
  );
  assert.equal(inspectAgentTurnEvents(toolPreambleEvents).assistantTextMatchesResponse, true);
  assert.equal(
    toolPreambleEvents.filter((event) => event.type === "reasoning.completed").length,
    2,
    "Claude should preserve each native reasoning segment across a multi-message tool loop",
  );
  const preambleReasoningIndex = toolPreambleEvents.findIndex((event) => String(event.type) === "reasoning.started");
  const preambleStatusIndex = toolPreambleEvents.findIndex(
    (event) => event.type === "assistant.status" && event.text === "我先检查环境。",
  );
  assert.ok(preambleReasoningIndex >= 0 && preambleReasoningIndex < preambleStatusIndex);
  const preambleReasoning = toolPreambleEvents.find(
    (event) => String(event.type) === "reasoning.completed",
  ) as unknown as
    | {
        reasoning?: { text?: string };
      }
    | undefined;
  assert.match(preambleReasoning?.reasoning?.text ?? "", /Hidden chain should stay out of commentary/);
  assert.doesNotMatch(preambleStatuses[0]!.text, /Hidden chain/);

  const assistantFallbackRuntime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: (() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            id: "msg_complete_tool",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "我用完整消息检查。" },
              { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "README.md" } },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000411",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 5,
          is_error: false,
          num_turns: 1,
          result: "assistant fallback done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-5000-8000-000000000412",
          session_id: "00000000-0000-5000-8000-000000000002",
        };
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  const assistantFallbackEvents: AgentEvent[] = [];
  for await (const event of assistantFallbackRuntime.runTurn({
    input: "assistant fallback",
    context: { ...context, sessionId: "claude-sdk-assistant-fallback-harness" },
    tools: app.tools.list(),
    requestedModelId: "opus",
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    assistantFallbackEvents.push(event);
  }
  assert.equal(
    assistantFallbackEvents.some((event) => event.type === "assistant.status" && event.text === "我用完整消息检查。"),
    true,
    "complete assistant message tool preamble should fall back to assistant.status",
  );
  assert.equal(
    assistantFallbackEvents.some(
      (event) => event.type === "assistant.delta" && event.text.includes("我用完整消息检查"),
    ),
    false,
  );

  const transcriptCwd = mkdtempSync(join(tmpdir(), "opengrove-claude-sdk-transcript-"));
  const transcriptConfigDir = join(transcriptCwd, "claude-home");
  const transcriptContext = { ...context, sessionId: "claude-sdk-transcript-harness" };
  const transcriptFingerprint = claudeRuntimeBindingFingerprint(
    "native",
    transcriptCwd,
    app.skills.list().map((skill) => skill.name),
  );
  const transcriptSessionId = stableClaudeSessionId(`${transcriptContext.sessionId}:${transcriptFingerprint}`);
  mkdirSync(join(transcriptConfigDir, "projects", claudeProjectKey(transcriptCwd)), { recursive: true });
  writeFileSync(
    join(transcriptConfigDir, "projects", claudeProjectKey(transcriptCwd), `${transcriptSessionId}.jsonl`),
    "",
  );
  let capturedResume = "";
  let capturedSessionId = "";
  const transcriptRuntime = new ClaudeAgentSdkRuntime({
    cwd: transcriptCwd,
    permissionMode: "default",
    configuredModel: "opus",
    env: { CLAUDE_CONFIG_DIR: transcriptConfigDir },
    query: ((params) => {
      capturedResume = params.options?.resume ?? "";
      capturedSessionId = params.options?.sessionId ?? "";
      async function* messages() {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "user",
          claude_code_version: "2.1.fake",
          cwd: transcriptCwd,
          tools: [],
          mcp_servers: [],
          model: "claude-test",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-5000-8000-000000000301",
          session_id: transcriptSessionId,
        };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 5,
          is_error: false,
          num_turns: 1,
          result: "resumed transcript",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-5000-8000-000000000302",
          session_id: transcriptSessionId,
        };
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  for await (const event of transcriptRuntime.runTurn({
    input: "hello transcript sdk",
    context: transcriptContext,
    tools: app.tools.list(),
    requestedModelId: "opus",
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    events.push(event);
  }
  assert.equal(capturedResume, transcriptSessionId);
  assert.equal(capturedSessionId, "");

  const failingRuntime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: ((params) => {
      async function* messages() {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "user",
          claude_code_version: "2.1.failure-test",
          cwd,
          tools: [],
          mcp_servers: [],
          model: "claude-failure-model",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-5000-8000-000000000401",
          session_id: "00000000-0000-5000-8000-000000000402",
        };
        yield {
          type: "assistant",
          message: {
            id: "msg_failure_partial",
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
            stop_reason: null,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-5000-8000-000000000403",
          session_id: "00000000-0000-5000-8000-000000000402",
          request_id: "req-previous-assistant",
        };
        params.options?.stderr?.("Error: Session ID demo-session is already in use.\n");
        throw Object.assign(new Error("Claude Code process exited with code 1"), {
          request_id: "req-failed-request",
        });
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  const failureEvents: AgentEvent[] = [];
  for await (const event of failingRuntime.runTurn({
    input: "hello failing sdk",
    context: { ...context, sessionId: "claude-sdk-failure-harness" },
    tools: app.tools.list(),
    requestedModelId: "opus",
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    failureEvents.push(event);
  }
  const failure = failureEvents.find(
    (event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error",
  );
  assert.ok(failure?.message.includes("Claude Code process exited with code 1"));
  assert.ok(failure?.message.includes("Session ID demo-session is already in use"));
  assert.deepEqual(failure?.diagnostics, {
    runtimeModelId: "claude-failure-model",
    runtimeVersion: "2.1.failure-test",
    upstreamRequestId: "req-failed-request",
  });
  assert.equal(
    failureEvents.some((event) => event.type === "runtime.diagnostic" && event.name === "claude.sdk.request"),
    false,
  );
  assert.ok(failureEvents.some((event) => event.type === "turn.finished"));

  const abortFailureRuntime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: (() => {
      const iterator = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<never>> {
          throw new Error("native query exited while aborting");
        },
      };
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  const abortFailureController = new AbortController();
  abortFailureController.abort("user canceled");
  const abortFailureEvents: AgentEvent[] = [];
  for await (const event of abortFailureRuntime.runTurn({
    runId: "run-claude-sdk-abort-failure",
    input: "cancel this SDK turn",
    context: { ...context, sessionId: "claude-sdk-abort-failure" },
    tools: [],
    requestedModelId: "opus",
    skills: [],
    packs: [],
    capabilities: [],
    signal: abortFailureController.signal,
  })) {
    abortFailureEvents.push(event);
  }
  assert.ok(
    abortFailureEvents.some(
      (event) =>
        event.type === "turn.finished" &&
        event.outcome.taskState === "TASK_STATE_CANCELED" &&
        event.outcome.outcomeUnknown === true,
    ),
    "an SDK exception after abort must stay canceled and outcome-unknown instead of becoming failed",
  );

  let activeQueries = 0;
  let maxActiveQueries = 0;
  const lockingRuntime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: ((params) => {
      async function* messages() {
        activeQueries += 1;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "user",
          claude_code_version: "2.1.fake",
          cwd,
          tools: [],
          mcp_servers: [],
          model: "claude-test",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: `00000000-0000-5000-8000-${params.prompt === "first" ? "000000000101" : "000000000201"}`,
          session_id: "00000000-0000-5000-8000-000000000099",
        };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 5,
          is_error: false,
          num_turns: 1,
          result: `done ${params.prompt}`,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: `00000000-0000-5000-8000-${params.prompt === "first" ? "000000000102" : "000000000202"}`,
          session_id: "00000000-0000-5000-8000-000000000099",
        };
        activeQueries -= 1;
      }
      const iterator = messages();
      return Object.assign(iterator, {
        close() {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
        getSettings: async () => ({}),
      }) as unknown;
    }) as ClaudeAgentSdkQueryFunction,
  });
  const lockContext = { ...context, sessionId: "claude-sdk-lock-harness" };
  async function collect(input: string): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];
    for await (const event of lockingRuntime.runTurn({
      input,
      context: lockContext,
      tools: app.tools.list(),
      skills: app.skills.list(),
      packs: app.packs.list(),
      capabilities: app.capabilities.list(),
    })) {
      collected.push(event);
    }
    return collected;
  }
  await Promise.all([collect("first"), collect("second")]);
  assert.equal(maxActiveQueries, 1, "Claude SDK runs sharing a native session should be serialized");

  await assertImageAttachmentReachesModel(app, cwd);
}

// Regression for the long-standing "image attached in a room never reaches the
// agent" bug: the SDK runtime must turn an image dataUrl into a real base64
// ImageBlockParam in a streamed SDKUserMessage, not just forward the text prompt.
async function assertImageAttachmentReachesModel(app: ReturnType<typeof createOpenGrove>, cwd: string): Promise<void> {
  let streamedPrompt: unknown;
  const imageQuery: ClaudeAgentSdkQueryFunction = ((params) => {
    streamedPrompt = params.prompt;
    async function* messages() {
      yield {
        type: "system",
        subtype: "init",
        apiKeySource: "user",
        claude_code_version: "2.1.fake",
        cwd,
        tools: [],
        mcp_servers: [],
        model: "claude-test",
        permissionMode: "default",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: "00000000-0000-5000-8000-000000000901",
        session_id: "00000000-0000-5000-8000-000000000902",
      };
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "saw the image",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-5000-8000-000000000903",
        session_id: "00000000-0000-5000-8000-000000000902",
      };
    }
    const iterator = messages();
    return Object.assign(iterator, {
      close() {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
      getSettings: async () => ({}),
    }) as unknown;
  }) as ClaudeAgentSdkQueryFunction;

  const runtime = new ClaudeAgentSdkRuntime({
    cwd,
    permissionMode: "default",
    configuredModel: "opus",
    query: imageQuery,
  });
  const imageContext: AgentContext = {
    sessionId: "claude-sdk-image-harness",
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
    page: {
      attachments: [
        {
          id: "shot",
          name: "shot.png",
          kind: "image",
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
        },
      ],
    },
  };

  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    input: "what is in this image?",
    context: imageContext,
    tools: app.tools.list(),
    skills: app.skills.list(),
    packs: app.packs.list(),
    capabilities: app.capabilities.list(),
  })) {
    events.push(event);
  }

  assert.notEqual(
    typeof streamedPrompt,
    "string",
    "image turns must use the streaming-input prompt, not a bare string",
  );
  const userMessages: Array<{ message: { content: unknown } }> = [];
  for await (const message of streamedPrompt as AsyncIterable<{ message: { content: unknown } }>) {
    userMessages.push(message);
  }
  assert.equal(userMessages.length, 1, "one streamed user message for the image turn");
  const content = userMessages[0]?.message.content;
  assert.ok(Array.isArray(content), "user message content must be a content-block array");
  const blocks = content as Array<Record<string, unknown>>;
  const textBlock = blocks.find((block) => block.type === "text");
  assert.equal(textBlock?.text, "what is in this image?", "text block carries the user prompt");
  const imageBlock = blocks.find((block) => block.type === "image");
  assert.ok(imageBlock, "an image content block must reach the model");
  const source = imageBlock?.source as Record<string, unknown> | undefined;
  assert.equal(source?.type, "base64");
  assert.equal(source?.media_type, "image/png");
  assert.equal(
    source?.data,
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "claude.media_input.configured" &&
        event.data.imageInputs === 1,
    ),
    "claude.media_input.configured diagnostic should report the image input",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function stableClaudeSessionId(input: string): string {
  const hash = createHash("sha1").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function claudeRuntimeBindingFingerprint(base: string | undefined, cwd: string, skillScope: string[] | "all"): string {
  return createHash("sha1")
    .update([base || "native", cwd, Array.isArray(skillScope) ? skillScope.join(",") : skillScope].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function claudeProjectKey(cwd: string): string {
  return resolve(cwd || process.cwd())
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]/g, "-");
}

function assertClaudeSdkContractCoversRuntimeEvents(events: AgentEvent[]): void {
  const mappedAppEvents = new Set<string>();
  for (const mapping of CLAUDE_CODE_KERNEL_CONTRACT.eventMappings ?? []) {
    for (const eventName of mapping.appEvent.split("/").map((part) => part.trim())) {
      mappedAppEvents.add(eventName);
    }
  }
  const runtimeEventTypes = new Set(events.map((event) => event.type));
  for (const expected of [
    "turn.started",
    "runtime.diagnostic",
    "model.requested",
    "assistant.delta",
    "model.response",
    "turn.finished",
  ] as const) {
    assert.ok(runtimeEventTypes.has(expected), `Claude SDK harness should emit ${expected}`);
    assert.ok(mappedAppEvents.has(expected), `Claude SDK contract should map ${expected}`);
  }
  assert.ok(
    mappedAppEvents.has("tool.started") &&
      mappedAppEvents.has("tool.finished") &&
      mappedAppEvents.has("planning.updated") &&
      mappedAppEvents.has("approval.requested") &&
      mappedAppEvents.has("question.requested") &&
      mappedAppEvents.has("question.answered"),
    "Claude SDK contract should cover tools, planning, approvals, and user-question bridges",
  );
}

function assertClaudeTaskUpdatePlanningProjection(): void {
  const state = createClaudePlanningState();
  const firstInput = {
    subject: "检查素材",
    description: "检查用户提供的素材",
  };
  claudePlanningEventsForToolStarted({
    runId: "run-task-update",
    callId: "toolu-task-create-1",
    toolName: "TaskCreate",
    toolInput: firstInput,
    state,
  });
  claudePlanningEventsForToolFinished({
    runId: "run-task-update",
    callId: "toolu-task-create-1",
    toolName: "TaskCreate",
    toolInput: firstInput,
    toolResult: { task: { id: "task-1", subject: "检查素材" } },
    resultOk: true,
    state,
  });

  const secondInput = {
    subject: "登记结果",
    description: "把检查结果登记到报告中",
  };
  claudePlanningEventsForToolStarted({
    runId: "run-task-update",
    callId: "toolu-task-create-2",
    toolName: "TaskCreate",
    toolInput: secondInput,
    state,
  });
  claudePlanningEventsForToolFinished({
    runId: "run-task-update",
    callId: "toolu-task-create-2",
    toolName: "TaskCreate",
    toolInput: secondInput,
    toolResult: { task: { id: "task-2", subject: "登记结果" } },
    resultOk: true,
    state,
  });

  const planningEvents = claudePlanningEventsForToolFinished({
    runId: "run-task-update",
    callId: "toolu-task-update-1",
    toolName: "TaskUpdate",
    toolInput: { taskId: "task-1", status: "completed" },
    toolResult: {
      success: true,
      taskId: "task-1",
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "completed" },
    },
    resultOk: true,
    state,
  });
  const planning = planningEvents.find(
    (event): event is Extract<AgentEvent, { type: "planning.updated" }> => event.type === "planning.updated",
  );
  assert.ok(planning, "Claude TaskUpdate should map the real input and output shapes to planning.updated");
  assert.equal(planning.plan.id, "claude-tasks");
  assert.equal(planning.plan.title, "Tasks");
  assert.match(planning.plan.text, /\[completed\] 检查素材/);
  assert.match(planning.plan.text, /\[pending\] 登记结果/);

  const listed = claudePlanningEventsForToolFinished({
    runId: "run-task-update",
    callId: "toolu-task-list",
    toolName: "TaskList",
    toolInput: {},
    toolResult: {
      tasks: [
        { id: "task-1", subject: "检查素材", status: "completed", blockedBy: [] },
        { id: "task-2", subject: "登记结果", status: "in_progress", blockedBy: [] },
      ],
    },
    resultOk: true,
    state,
  });
  const listedPlan = listed.find(
    (event): event is Extract<AgentEvent, { type: "planning.updated" }> => event.type === "planning.updated",
  );
  assert.ok(listedPlan, "Claude TaskList result should refresh the complete planning list");
  assert.match(listedPlan.plan.text, /\[completed\] 检查素材/);
  assert.match(listedPlan.plan.text, /\[in_progress\] 登记结果/);
}
