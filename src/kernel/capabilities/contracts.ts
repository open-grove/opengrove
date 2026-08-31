import type {
  KernelCapabilityContract,
  KernelCapabilityId,
  KernelContractMapping,
  KernelContractMappingStatus,
} from "./types.js";

function map(
  capability: KernelCapabilityId,
  status: KernelContractMappingStatus,
  from: string,
  to?: string,
  expectedContractTest?: string,
  notes?: string[],
): KernelContractMapping {
  return {
    capability,
    status,
    from,
    ...(to ? { to } : {}),
    ...(expectedContractTest ? { expectedContractTest } : {}),
    ...(notes?.length ? { notes } : {}),
  };
}

function acpMappings(
  kernel: string,
  options: {
    nativeTools?: boolean;
    approval?: boolean;
    usage?: boolean;
    compact?: boolean;
    compactDescription?: string;
    planning?: boolean;
    hostTools?: boolean;
  } = {},
): KernelCapabilityContract {
  const nativeTools = options.nativeTools ?? true;
  const approval = options.approval ?? true;
  const usage = options.usage ?? false;
  const compact = options.compact ?? false;
  const compactDescription =
    options.compactDescription ?? "OpenCode ACP session id plus official POST /session/:id/summarize server API";
  const planning = options.planning ?? false;
  const hostTools = options.hostTools ?? false;
  return {
    kernel,
    mappings: [
      map(
        "message.streamText",
        "mapped",
        "ACP session/update agent_message_chunk",
        "assistant.delta / model.response",
        `${kernel}.message.streamText`,
      ),
      map(
        "turn.lifecycle",
        "mapped",
        "ACP session/prompt request/response",
        "turn.started / turn.finished",
        `${kernel}.turn.lifecycle`,
      ),
      map(
        "session.lifecycle",
        "fallback",
        "ACP session/new plus OpenGrove remembered session binding",
        "OpenGrove runtime session trace",
        `${kernel}.session.lifecycle`,
        ["OpenGrove does not yet expose ACP session/list, load, or delete as first-class UI/API controls."],
      ),
      nativeTools
        ? map(
            "tools.nativeTool",
            "mapped",
            "ACP tool_call and tool_call_update",
            "tool.started / tool.finished",
            `${kernel}.tools.nativeTool`,
          )
        : map("tools.nativeTool", "not-wired", "ACP tool_call and tool_call_update", undefined, undefined, [
            "The current OpenGrove ACP bridge did not observe native tool_call events from this kernel in real-runtime probes.",
          ]),
      nativeTools
        ? map("tool.progress", "mapped", "ACP tool_call_update", "tool.progress", `${kernel}.tool.progress`)
        : map("tool.progress", "not-wired", "ACP tool_call_update", undefined, undefined, [
            "The current OpenGrove ACP bridge did not observe tool_call_update events from this kernel in real-runtime probes.",
          ]),
      map(
        "tools.parallelCalls",
        "not-wired",
        "ACP does not expose a standard host-controlled parallel-tool-call contract through OpenGrove.",
      ),
      approval
        ? map(
            "approval.request",
            "mapped",
            "ACP session/request_permission",
            "approval.requested / approval.resolved",
            `${kernel}.approval.request`,
          )
        : map("approval.request", "not-wired", "ACP session/request_permission", undefined, undefined, [
            "No real-runtime approval request has been observed through the current ACP bridge for this kernel.",
          ]),
      map("control.stop", "mapped", "OpenGrove AbortSignal", "ACP session/cancel", `${kernel}.control.stop`),
      map("control.steer", "not-wired", "Kernel-specific steering or prompt append surface"),
      compact
        ? map(
            "session.compact",
            "mapped",
            compactDescription,
            "AgentRuntime.compactSession",
            `${kernel}.session.compact`,
            ["ACP has no standard compact request; OpenGrove uses the kernel's documented native compaction surface."],
          )
        : map(
            "session.compact",
            "not-wired",
            "ACP does not define a standard context-compaction request.",
            undefined,
            undefined,
            ["OpenGrove's generic AcpCliRuntime does not call kernel-specific compact/summarize endpoints."],
          ),
      map("session.goal", "not-wired", "ACP does not define a standard persisted thread goal surface."),
      map("auth.refresh", "not-wired", "Kernel-specific auth refresh surface"),
      map("sandbox.policy", "not-wired", "Kernel-specific sandbox or permission-policy configuration"),
      map("budget.limit", "not-wired", "Kernel-specific budget or hard cost-limit surface"),
      usage
        ? map("diagnostics.usage", "mapped", "ACP usage_update", "runtime.diagnostic", `${kernel}.diagnostics.usage`)
        : map(
            "diagnostics.usage",
            "not-wired",
            "ACP usage_update is optional and is not emitted by every ACP agent",
            undefined,
            undefined,
            [
              "OpenGrove only marks diagnostics.usage exposed when a real-runtime probe observes usage_update or model usage.",
            ],
          ),
      map("response.speed", "not-wired", "ACP does not define a standard response-speed or service-tier control."),
      planning
        ? map("planning.plan", "mapped", "ACP plan_update", "planning.updated", `${kernel}.planning.plan`, [
            "This only marks the OpenGrove projector path wired; product exposure still requires a passing real-runtime probe from the kernel.",
          ])
        : map("planning.plan", "not-wired", "ACP plan_update", undefined, undefined, [
            "The current OpenGrove ACP bridge only exposes planning when a real kernel emits ACP plan_update or OpenGrove implements a kernel-specific plan projection.",
          ]),
      map("interaction.askUser", "not-wired", "Kernel-specific ask-user tools or future ACP elicitation surface"),
      hostTools
        ? map(
            "tools.hostTool",
            "mapped",
            "ACP session MCP servers",
            "OpenGrove scoped Host Tool MCP bridge",
            `${kernel}.tools.hostTool`,
          )
        : map("tools.hostTool", "not-wired", "OpenGrove does not inject host tools into this ACP kernel."),
      hostTools
        ? map(
            "tools.mcpServers",
            "mapped",
            "ACP session/new and session/load mcpServers",
            "OpenGrove per-session MCP server injection",
            `${kernel}.tools.mcpServers`,
          )
        : map(
            "tools.mcpServers",
            "not-wired",
            "OpenGrove has not real-runtime certified MCP server injection for this ACP kernel.",
          ),
      map(
        "media.input",
        "mapped",
        "ACP ContentBlock::Image (base64) appended to session/prompt when the agent negotiates the image prompt capability",
        "image content block",
        `${kernel}.media.input`,
        [
          "Image blocks are only sent when the agent advertised image prompt support at initialize; otherwise the bridge degrades to text.",
        ],
      ),
      map(
        "output.structured",
        "not-wired",
        "OpenGrove does not pass structured-output schema through the generic ACP runtime.",
      ),
      map(
        "output.artifacts",
        "not-wired",
        "OpenGrove does not normalize kernel-native artifact outputs through the generic ACP runtime.",
      ),
      map(
        "reasoning.nativeText",
        "mapped",
        "ACP agent_thought_chunk",
        "reasoning.started / reasoning.completed kind=native",
        `${kernel}.reasoning.nativeText`,
        [
          "ACP defines the transport. Emission remains conditional on the concrete ACP kernel, selected model, and turn.",
        ],
      ),
      map("reasoning.summary", "not-wired", "ACP agent_thought_chunk", undefined, undefined, [
        "agent_thought_chunk text is native reasoning text; ACP does not define it as a readable reasoning summary.",
      ]),
      map(
        "knowledge.skills",
        "mapped",
        `${kernel} project-native SKILL.md directory`,
        "OpenGrove explicit native-skill publication plus kernel progressive loading",
        `${kernel}.knowledge.skills`,
      ),
    ],
  };
}

function openClawMappings(): KernelCapabilityContract {
  return {
    kernel: "openclaw",
    mappings: [
      map(
        "message.streamText",
        "mapped",
        "OpenClaw Gateway assistant events",
        "assistant.delta / model.response",
        "openclaw.message.streamText",
      ),
      map(
        "turn.lifecycle",
        "mapped",
        "OpenClaw Gateway chat.send plus agent.wait",
        "turn.started / turn.finished",
        "openclaw.turn.lifecycle",
      ),
      map(
        "session.lifecycle",
        "fallback",
        "OpenClaw Gateway sessionKey",
        "OpenGrove session binding",
        "openclaw.session.lifecycle",
        ["OpenGrove binds a Gateway session key, but does not expose full OpenClaw native transcript management."],
      ),
      map("tools.nativeTool", "not-wired", "OpenClaw Gateway tool events", undefined, undefined, [
        "A raw Gateway probe with tool-events capability only observed lifecycle, assistant, chat, and health events.",
      ]),
      map("approval.request", "not-wired", "OpenClaw Gateway permission events", undefined, undefined, [
        "A real write probe completed without a Gateway permission event, so OpenGrove cannot expose approval controls for OpenClaw yet.",
      ]),
      map(
        "control.stop",
        "mapped",
        "OpenGrove AbortSignal",
        "OpenClaw Gateway cancellation/connection close",
        "openclaw.control.stop",
      ),
      map(
        "session.compact",
        "mapped",
        "OpenClaw Gateway sessions.compact",
        "AgentRuntime.compactSession",
        "openclaw.session.compact",
      ),
      map("session.goal", "not-wired", "OpenClaw persisted goal surface through OpenGrove"),
      map(
        "diagnostics.usage",
        "mapped",
        "OpenClaw Gateway sessions.list totalTokens/contextTokens",
        "context.budget.applied runtime diagnostic",
        "openclaw.diagnostics.usage",
      ),
      map("planning.plan", "not-wired", "OpenClaw planning surface"),
      map("interaction.askUser", "not-wired", "OpenClaw elicitation surface"),
      map("tools.hostTool", "not-wired", "OpenGrove does not inject host tools into OpenClaw Gateway."),
      map("tools.mcpServers", "not-wired", "OpenClaw MCP server configuration through OpenGrove"),
      map("tools.parallelCalls", "not-wired", "OpenClaw parallel tool execution surface"),
      map("tool.progress", "not-wired", "OpenClaw Gateway tool progress events", undefined, undefined, [
        "The current raw Gateway probe did not observe tool progress events.",
      ]),
      map("control.steer", "not-wired", "OpenClaw Gateway steering surface"),
      map("auth.refresh", "not-wired", "OpenClaw auth refresh surface"),
      map("sandbox.policy", "not-wired", "OpenClaw sandbox or permission-policy surface"),
      map("budget.limit", "not-wired", "OpenClaw budget or hard cost-limit surface"),
      map("response.speed", "not-wired", "OpenClaw Gateway response-speed or service-tier control"),
      map("media.input", "not-wired", "OpenGrove sends text-only prompt payloads to OpenClaw Gateway today."),
      map("output.structured", "not-wired", "OpenGrove does not request structured output through OpenClaw Gateway."),
      map("output.artifacts", "not-wired", "OpenGrove does not normalize OpenClaw artifact outputs yet."),
      map("reasoning.nativeText", "not-wired", "OpenClaw reasoning or thinking event surface"),
      map("reasoning.summary", "not-wired", "OpenClaw reasoning-summary event surface"),
      map(
        "knowledge.skills",
        "fallback",
        "OpenClaw workspace skill roots",
        "Explicit OpenGrove selected-skill instructions in the Gateway prompt",
        undefined,
        [
          "The Gateway bridge cannot prove that OpenGrove's cwd is the configured OpenClaw agent workspace, so it does not pretend a project-local skill was natively published.",
        ],
      ),
    ],
  };
}

export const KERNEL_CAPABILITY_CONTRACTS: KernelCapabilityContract[] = [
  {
    kernel: "codex",
    mappings: [
      map(
        "message.streamText",
        "mapped",
        "Codex item text deltas",
        "assistant.delta / model.response",
        "codex.message.streamText",
      ),
      map(
        "planning.plan",
        "mapped",
        "turn/plan/updated and item/plan/delta",
        "planning.updated",
        "codex.planning.plan",
      ),
      map(
        "interaction.askUser",
        "mapped",
        "item/tool/requestUserInput and mcpServer/elicitation/request",
        "question.requested / question.answered",
        "codex.interaction.askUser",
      ),
      map(
        "tools.hostTool",
        "mapped",
        "Codex dynamic tools / MCP tool calls",
        "OpenGrove dynamic tool bridge",
        "codex.tools.hostTool",
      ),
      map(
        "tools.nativeTool",
        "mapped",
        "Codex native command/file/tool items",
        "tool.started / tool.finished",
        "codex.tools.nativeTool",
      ),
      map("tools.mcpServers", "not-wired", "Codex MCP server configuration", undefined, undefined, [
        "OpenGrove uses Codex dynamic MCP/tool events after they exist, but does not expose kernel MCP server injection as a separate certified capability.",
      ]),
      map("tools.parallelCalls", "not-wired", "Codex parallel tool-call execution surface"),
      map(
        "approval.request",
        "mapped",
        "Codex approval server requests",
        "approval.requested / approval.resolved",
        "codex.approval.request",
      ),
      map(
        "session.compact",
        "mapped",
        "hook/started type=compaction and completion",
        "compaction.started / compaction.finished",
        "codex.session.compact",
      ),
      map(
        "auth.refresh",
        "fallback",
        "account/chatgptAuthTokens/refresh",
        "Codex conditional auth refresh handler",
        undefined,
        [
          "OpenGrove implements Codex's account/chatgptAuthTokens/refresh server-request handler.",
          "Codex only calls this request when native ChatGPT auth expires, so an ordinary real-runtime turn cannot deterministically certify it yet.",
        ],
      ),
      map(
        "sandbox.policy",
        "mapped",
        "OpenGrove accessMode",
        "Codex sandboxPolicy / approvalPolicy",
        "codex.sandbox.policy",
      ),
      map("diagnostics.usage", "mapped", "Codex turn usage", "model.response.usage", "codex.diagnostics.usage"),
      map("response.speed", "mapped", "OpenGrove responseSpeed", "Codex serviceTier", "codex.response.speed"),
      map(
        "output.artifacts",
        "fallback",
        "Codex file-change items",
        "OpenGrove tool/file events",
        "codex.output.artifacts",
        ["Native file changes are visible, but not all outputs are normalized into OpenGrove ArtifactRecord entries."],
      ),
      map(
        "turn.lifecycle",
        "mapped",
        "Codex turn/start and completion",
        "turn.started / turn.finished",
        "codex.turn.lifecycle",
      ),
      map(
        "session.lifecycle",
        "fallback",
        "Codex thread/start, resume, fork, list, archive",
        "OpenGrove session binding",
        "codex.session.lifecycle",
        ["OpenGrove uses Codex sessions but does not expose the full Codex thread management surface."],
      ),
      map(
        "session.goal",
        "mapped",
        "Codex thread/goal/set and thread/goal/updated",
        "Codex native thread goal",
        "codex.session.goal",
      ),
      map("control.stop", "mapped", "OpenGrove AbortSignal", "Codex turn/interrupt", "codex.control.stop"),
      map("control.steer", "mapped", "Codex turn/steer", "AgentRuntime.steerTurn", "codex.control.steer"),
      map(
        "tool.progress",
        "suppressed",
        "command/exec/outputDelta and item/fileChange/outputDelta",
        undefined,
        undefined,
        ["OpenGrove opts out of these verbose Codex notifications today."],
      ),
      map("reasoning.nativeText", "not-wired", "Codex app-server reasoning item", undefined, undefined, [
        "The mapped app-server protocol exposes readable summaryText, not native reasoning text.",
      ]),
      map(
        "reasoning.summary",
        "mapped",
        "item/reasoning/summaryTextDelta",
        "reasoning.started / reasoning.completed kind=summary",
        "codex.reasoning.summary",
        [
          "OpenGrove exposes the readable summaryText supplied by Codex. The mapped app-server protocol does not provide a native reasoning-text event, and the Host does not reconstruct one.",
        ],
      ),
      map("media.input", "mapped", "Codex turn/start UserInput::Image items", "image input item", "codex.media.input"),
      map(
        "output.structured",
        "mapped",
        "Codex turn/start outputSchema",
        "structured JSON response",
        "codex.output.structured",
      ),
      map("budget.limit", "not-wired", "Codex budget/cost controls"),
      map("knowledge.skills", "not-wired", "Codex MCP/resource skill discovery", undefined, undefined, [
        "OpenGrove has its own skill library; it does not yet expose Codex native skill/resource discovery as a kernel capability.",
      ]),
    ],
  },
  {
    kernel: "claude-code",
    mappings: [
      map(
        "message.streamText",
        "mapped",
        "@anthropic-ai/claude-agent-sdk stream_event text_delta",
        "assistant.delta / model.response",
        "claude-code.message.streamText",
      ),
      map(
        "turn.lifecycle",
        "mapped",
        "Claude SDK query lifecycle",
        "turn.started / turn.finished",
        "claude-code.turn.lifecycle",
      ),
      map(
        "session.lifecycle",
        "fallback",
        "Claude SDK sessionId/resume",
        "stable OpenGrove-to-Claude session binding",
        "claude-code.session.lifecycle",
        ["OpenGrove binds and resumes Claude sessions, but does not expose full native session CRUD."],
      ),
      map(
        "interaction.askUser",
        "mapped",
        "Claude SDK onElicitation and AskUserQuestion",
        "question.requested / question.answered",
        "claude-code.interaction.askUser",
      ),
      map(
        "tools.hostTool",
        "mapped",
        "OpenGrove in-process SDK MCP server",
        "Claude MCP tools",
        "claude-code.tools.hostTool",
      ),
      map(
        "tools.mcpServers",
        "mapped",
        "Claude SDK mcpServers option",
        "OpenGrove opengrove MCP server injection",
        "claude-code.tools.mcpServers",
      ),
      map("tools.parallelCalls", "not-wired", "Claude SDK parallel tool execution controls"),
      map(
        "tools.nativeTool",
        "mapped",
        "Claude SDK assistant/user tool_use and tool_result messages",
        "tool.started / tool.finished",
        "claude-code.tools.nativeTool",
      ),
      map("tool.progress", "not-wired", "Claude SDK streaming tool progress surface"),
      map(
        "approval.request",
        "mapped",
        "Claude SDK canUseTool",
        "approval.requested / approval.resolved",
        "claude-code.approval.request",
      ),
      map("control.stop", "mapped", "OpenGrove AbortSignal", "Claude SDK abortController", "claude-code.control.stop"),
      map("control.steer", "not-wired", "Claude SDK same-turn steering or append-instruction surface"),
      map(
        "session.compact",
        "mapped",
        "Claude SDK compacting status and compact_boundary",
        "compaction.started / compaction.finished",
        "claude-code.session.compact",
      ),
      map("session.goal", "not-wired", "Claude Agent persisted goal surface through OpenGrove"),
      map("auth.refresh", "not-wired", "Claude Agent auth refresh surface"),
      map(
        "diagnostics.usage",
        "mapped",
        "Claude SDK result usage / total_cost_usd",
        "model.response.usage / runtime.diagnostic",
        "claude-code.diagnostics.usage",
      ),
      map(
        "sandbox.policy",
        "fallback",
        "OpenGrove accessMode and Claude permissionMode",
        "claude.policy.configured runtime diagnostic",
        "claude-code.sandbox.policy",
        ["This maps permission behavior, not a guaranteed OS sandbox."],
      ),
      map(
        "budget.limit",
        "mapped",
        "Claude SDK maxBudgetUsd",
        "Claude query option maxBudgetUsd",
        "claude-code.budget.limit",
      ),
      map("response.speed", "not-wired", "Claude Agent speed/service-tier control"),
      map("output.structured", "not-wired", "Claude SDK outputFormat"),
      map(
        "reasoning.nativeText",
        "mapped",
        "Claude SDK stream_event thinking_delta.thinking",
        "reasoning.started / reasoning.completed kind=native",
        "claude-code.reasoning.nativeText",
        [
          "The SDK transport supports readable text, but actual emission is conditional on runtime mode, model, provider, and redaction policy.",
        ],
      ),
      map("reasoning.summary", "not-wired", "Claude optional API-side thinking-summary setting", undefined, undefined, [
        "OpenGrove does not currently receive a distinct typed Claude reasoning-summary event.",
        "A distinct typed native-summary boundary is not wired yet.",
      ]),
      map(
        "planning.plan",
        "mapped",
        "Claude TaskCreate / TaskUpdate / TaskList and TodoWrite tools",
        "planning.updated",
        "claude-code.planning.plan",
        [
          "The adapter aggregates Claude task records into one stable OpenGrove plan; product exposure still requires passing real-runtime evidence.",
        ],
      ),
      map(
        "media.input",
        "mapped",
        "Claude SDK streaming-input SDKUserMessage with base64 ImageBlockParam content",
        "image input block",
        "claude-code.media.input",
      ),
      map("output.artifacts", "not-wired", "Claude Agent artifact or file-output surface"),
      map("knowledge.skills", "not-wired", "Claude Agent native skills"),
    ],
  },
  {
    kernel: "pi",
    mappings: [
      map("message.streamText", "suppressed", "pi-agent-core message_update text deltas", undefined, undefined, [
        "The adapter buffers native deltas until message_end/agent_end because Pi does not identify whether a text block is a tool preamble or the terminal answer until the native message boundary.",
      ]),
      map(
        "turn.lifecycle",
        "mapped",
        "OpenGrove prompt-to-agent_end lifecycle plus native message boundaries",
        "turn.started / assistant.status / turn.finished",
        "pi.turn.lifecycle",
      ),
      map(
        "session.lifecycle",
        "mapped",
        "pi-agent-core Session with JSONL or in-memory SessionRepo",
        "stable OpenGrove-to-Pi session binding and runtime session trace",
        "pi.session.lifecycle",
        [
          "Desktop runs persist native Pi session entries under the OpenGrove data directory; non-desktop/test runs use the native in-memory repository. The factory binds create/open/list/delete/fork lifecycle operations.",
        ],
      ),
      map("planning.plan", "not-wired", "pi-agent-core planning surface"),
      map("tools.hostTool", "mapped", "AgentTurnRequest.tools", "pi-agent-core AgentTool list", "pi.tools.hostTool"),
      map("tools.mcpServers", "not-wired", "pi-agent-core MCP server injection surface"),
      map(
        "tools.parallelCalls",
        "mapped",
        "pi-agent-core toolExecution=parallel",
        "NativePiSession tool execution mode",
        "pi.tools.parallelCalls",
      ),
      map(
        "approval.request",
        "mapped",
        "pi-agent-core asynchronous beforeToolCall gate",
        "approval.requested / approval.resolved / same-loop continuation",
        "pi.approval.request",
      ),
      map(
        "tools.nativeTool",
        "suppressed",
        "pi-agent-core AgentHarness read/bash/edit/write tools",
        undefined,
        undefined,
        [
          "OpenGrove deliberately keeps one Host-owned tool execution and policy surface. Enabling the parallel AgentHarness coding-tool surface would duplicate permissions, progress, artifacts, and side-effect ownership.",
        ],
      ),
      map(
        "interaction.askUser",
        "fallback",
        "OpenGrove host-ui tools or ordinary follow-up turn",
        "ordinary next user turn",
        undefined,
        ["No native same-turn elicitation bridge is wired for Pi."],
      ),
      map(
        "tool.progress",
        "mapped",
        "pi-agent-core AgentTool onUpdate / tool_execution_update",
        "tool.progress",
        "pi.tool.progress",
      ),
      map(
        "control.stop",
        "mapped",
        "OpenGrove AbortSignal",
        "pi-agent-core Agent.abort plus AgentTool AbortSignal",
        "pi.control.stop",
      ),
      map("control.steer", "fallback", "pi-agent-core steer", "internal context/skill steering only", undefined, [
        "OpenGrove uses steer internally for context and skill invocation, not as a user-facing runtime steering control.",
      ]),
      map(
        "session.compact",
        "mapped",
        "pi-agent-core prepareCompaction / compact / Session.appendCompaction",
        "AgentRuntime.compactSession",
        "pi.session.compact",
        [
          "Configured and model-window pressure both use Pi's native summarization and retained-tail semantics. If the native result still cannot fit, OpenGrove fails explicitly instead of dropping history.",
        ],
      ),
      map("session.goal", "not-wired", "pi-agent-core persisted goal surface through OpenGrove"),
      map("auth.refresh", "not-wired", "pi-ai Models credential store and OAuth refresh"),
      map("sandbox.policy", "not-wired", "pi-agent-core sandbox or permission-policy surface"),
      map("budget.limit", "not-wired", "pi-ai budget or hard cost-limit surface"),
      map("response.speed", "not-wired", "pi-agent-core response-speed or service-tier control"),
      map(
        "reasoning.nativeText",
        "mapped",
        "pi-ai thinking_start/thinking_delta/thinking_end and ThinkingContent",
        "reasoning.started / reasoning.completed kind=native",
        "pi.reasoning.nativeText",
        [
          "Pi's transport supports native reasoning text. Emission is conditional on model.reasoning, requested effort, provider behavior, and redaction.",
        ],
      ),
      map("reasoning.summary", "not-wired", "pi-ai provider thinking events", undefined, undefined, [
        "Pi thinking blocks are native reasoning text; Pi does not define them as a distinct reasoning-summary protocol.",
      ]),
      map(
        "media.input",
        "mapped",
        "pi-agent-core Agent.prompt images parameter with pi-ai ImageContent",
        "image input content",
        "pi.media.input",
      ),
      map("output.structured", "not-wired", "pi-ai structured output surface"),
      map("output.artifacts", "not-wired", "pi-agent-core artifact or file-output surface"),
      map(
        "diagnostics.usage",
        "mapped",
        "pi-ai AssistantMessage usage and completion metadata",
        "model.response usage / pi.message.completed",
        "pi.diagnostics.usage",
      ),
      map(
        "knowledge.skills",
        "fallback",
        "pi-agent-core AgentHarness skill discovery/resources",
        "OpenGrove skill catalog through skill.invoke",
        "pi.knowledge.skills",
        [
          "This is an explicit single-owner choice: OpenGrove retains provenance, trust, progressive disclosure, and pack policy instead of running a second native skill catalog beside it.",
        ],
      ),
    ],
  },
  acpMappings("opencode", { usage: true, compact: true, planning: true }),
  acpMappings("kimi", {
    compact: true,
    compactDescription: "Kimi native /compact command submitted to the same ACP session",
    hostTools: true,
  }),
  openClawMappings(),
  {
    kernel: "hermes",
    mappings: [
      map(
        "message.streamText",
        "mapped",
        "Hermes TUI Gateway message.delta and message.complete",
        "assistant.delta / model.response",
        "hermes.message.streamText",
      ),
      map(
        "turn.lifecycle",
        "mapped",
        "Hermes prompt lifecycle",
        "turn.started / turn.finished",
        "hermes.turn.lifecycle",
      ),
      map(
        "session.lifecycle",
        "fallback",
        "Hermes TUI Gateway session.create and remembered session id",
        "OpenGrove session binding",
        "hermes.session.lifecycle",
        [
          "OpenGrove reuses Gateway sessions in the active child process, but does not expose full Hermes session management.",
        ],
      ),
      map(
        "tools.nativeTool",
        "mapped",
        "Hermes TUI Gateway tool.start/tool.complete",
        "tool.started / tool.finished",
        "hermes.tools.nativeTool",
      ),
      map("tool.progress", "not-wired", "Hermes TUI Gateway tool lifecycle", undefined, undefined, [
        "Hermes 0.20 emits correlated tool.start/tool.complete plus specialized status events, but no generic correlated tool.progress event.",
      ]),
      map(
        "approval.request",
        "mapped",
        "Hermes TUI Gateway approval.request and approval.respond",
        "approval.requested / approval.resolved",
        "hermes.approval.request",
      ),
      map(
        "interaction.askUser",
        "mapped",
        "Hermes TUI Gateway clarify/sudo/secret request and response",
        "question.requested / question.answered",
        "hermes.interaction.askUser",
      ),
      map(
        "control.stop",
        "mapped",
        "OpenGrove AbortSignal",
        "Hermes TUI Gateway session.interrupt",
        "hermes.control.stop",
      ),
      map(
        "diagnostics.usage",
        "mapped",
        "Hermes TUI Gateway message.complete usage payload",
        "model.response.usage",
        "hermes.diagnostics.usage",
      ),
      map("response.speed", "not-wired", "Hermes speed/service-tier control through OpenGrove"),
      map("planning.plan", "not-wired", "Hermes planning surface"),
      map("tools.hostTool", "not-wired", "OpenGrove host-tool bridge"),
      map("tools.mcpServers", "not-wired", "Hermes MCP server injection"),
      map("tools.parallelCalls", "not-wired", "Hermes concurrent tool execution controls"),
      map("control.steer", "not-wired", "Hermes TUI Gateway session.steer", undefined, undefined, [
        "The current real-runtime probe reached Hermes but the agent reported that same-turn steer is not supported.",
      ]),
      map(
        "session.compact",
        "mapped",
        "Hermes TUI Gateway session.compress",
        "AgentRuntime.compactSession",
        "hermes.session.compact",
      ),
      map("session.goal", "not-wired", "Hermes persisted goal surface through OpenGrove"),
      map("auth.refresh", "not-wired", "Hermes auth refresh surface"),
      map("sandbox.policy", "not-wired", "Hermes sandbox or permission-policy surface"),
      map("budget.limit", "not-wired", "Hermes budget/iteration caps"),
      map("media.input", "not-wired", "Hermes multimodal input surface"),
      map("output.structured", "not-wired", "Hermes structured output surface"),
      map("output.artifacts", "not-wired", "Hermes artifact/session outputs"),
      map(
        "reasoning.nativeText",
        "mapped",
        "Hermes reasoning.available/reasoning.delta",
        "reasoning.started / reasoning.completed kind=native",
        "hermes.reasoning.nativeText",
        [
          "Hermes stores and emits provider reasoning text when the selected model/provider exposes it.",
          "Hermes thinking.delta is an animated status string, not reasoning content.",
        ],
      ),
      map("reasoning.summary", "not-wired", "Hermes native reasoning payloads", undefined, undefined, [
        "Hermes does not identify these payloads as a distinct reasoning-summary protocol.",
      ]),
      map("knowledge.skills", "not-wired", "Hermes skill loading"),
    ],
  },
];
