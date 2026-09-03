import type {
  KernelCapabilityEvidenceKind,
  KernelCapabilityId,
  KernelNativeCapabilityFact,
  KernelNativeSupport,
} from "./types.js";

const CHECKED_AT = "2026-07-06";
const REFRESHED_AT = "2026-07-20";
const CLAUDE_REFRESHED_AT = "2026-09-03";
const PI_REFRESHED_AT = "2026-08-05";
const HERMES_REFRESHED_AT = "2026-08-05";

interface SourceEvidence {
  source: string;
  sourcePath: string;
  kind?: KernelCapabilityEvidenceKind;
  upstreamVersion?: string;
  checkedAt?: string;
}

function fact(
  kernel: string,
  capability: KernelCapabilityId,
  native: KernelNativeSupport,
  evidence: SourceEvidence,
  notes?: string[],
): KernelNativeCapabilityFact {
  return {
    kernel,
    capability,
    native,
    evidence: {
      source: evidence.source,
      sourcePath: evidence.sourcePath,
      checkedAt: evidence.checkedAt ?? CHECKED_AT,
      confidence: "verified",
      kind: evidence.kind ?? "raw_source",
      ...(evidence.upstreamVersion ? { upstreamVersion: evidence.upstreamVersion } : {}),
    },
    ...(notes?.length ? { notes } : {}),
  };
}

function facts(
  kernel: string,
  capabilities: KernelCapabilityId[],
  native: KernelNativeSupport,
  evidence: SourceEvidence,
  notes?: string[],
): KernelNativeCapabilityFact[] {
  return capabilities.map((capability) => fact(kernel, capability, native, evidence, notes));
}

const codexProtocol = {
  source:
    "Codex app-server protocol v2 defines thread, turn, notification, permission, MCP, auth, and output-schema surfaces.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexNotifications = {
  source:
    "Codex app-server protocol v2 notifications include streaming items, plan deltas, compaction hooks, usage, reasoning events, and tool/file events.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexThread = {
  source: "Codex app-server thread protocol includes start/resume/fork/list/archive and turn controls.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexTurn = {
  source: "Codex app-server turn protocol accepts UserInput::Image with image URL and detail.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexMcp = {
  source: "Codex app-server MCP protocol exposes dynamic tools and elicitation requests.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexPermissions = {
  source: "Codex app-server permissions protocol exposes approval and sandbox policy concepts.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};
const codexRuntimeControls = {
  source:
    "Codex app-server docs expose model-advertised service tiers and speed tiers through model/list and turn/thread settings.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
};

const claudeSdk = {
  source:
    "Claude Agent SDK types expose query sessions, permission callbacks, MCP servers, thinking controls, budgets, output format, resume, and interrupt.",
  sourcePath: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@anthropic-ai/claude-agent-sdk 0.3.251 (Claude Code 2.1.251)",
  checkedAt: CLAUDE_REFRESHED_AT,
};
const claudeTools = {
  source: "Claude Agent SDK tool types include AskUserQuestion and native tool schemas.",
  sourcePath: "node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@anthropic-ai/claude-agent-sdk 0.3.251 (Claude Code 2.1.251)",
  checkedAt: CLAUDE_REFRESHED_AT,
};

const piAgent = {
  source:
    "pi-agent-core documents stateful agent turns, awaited lifecycle events, host tool execution, approvals through beforeToolCall, parallel tools, tool progress, steering, follow-up, abort, thinking level, and image input.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/README.md",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piAgentTypes = {
  source:
    "pi-agent-core types define assistant-message boundaries, tool execution modes, tool update events, steering, follow-up, abort, and provider stop metadata.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/dist/types.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piHarnessSession = {
  source:
    "pi-agent-core 0.83 exports AgentHarness plus in-memory and JSONL session repositories with create/open/list/delete/fork lifecycle.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl-repo.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piHarnessCompaction = {
  source:
    "pi-agent-core 0.83 exports native compaction preparation, summarization, usage, and AgentHarness.compact surfaces.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piHarnessTools = {
  source: "pi-agent-core 0.83 exports AgentHarness built-in read, bash, edit, and write tools.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/dist/harness/tools/index.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piHarnessSkills = {
  source: "pi-agent-core 0.83 exports native SKILL.md discovery/loading and AgentHarness skill resources.",
  sourcePath: "node_modules/@earendil-works/pi-agent-core/dist/harness/skills.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-agent-core 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piAi = {
  source:
    "pi-ai documents streaming text, tool calls, thinking blocks, image input, abort, usage, and structured provider capability metadata.",
  sourcePath: "node_modules/@earendil-works/pi-ai/README.md",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-ai 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};
const piAiModels = {
  source: "pi-ai Models owns provider auth resolution, OAuth refresh, provider catalogs, and stream dispatch.",
  sourcePath: "node_modules/@earendil-works/pi-ai/dist/models.d.ts",
  kind: "local_package" as const,
  upstreamVersion: "@earendil-works/pi-ai 0.83.0",
  checkedAt: PI_REFRESHED_AT,
};

const hermesProgrammatic = {
  source:
    "Hermes programmatic integration docs describe TUI Gateway sessions, prompt streaming, approvals, clarify prompts, interrupt, fork/cancel, and usage callbacks.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};
const hermesGateway = {
  source: "Hermes Gateway internals document gateway events and native tool/runtime surfaces.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};
const hermesTools = {
  source: "Hermes tools runtime docs describe native tools, progress, parallel/concurrent execution, and approvals.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};
const hermesCompression = {
  source: "Hermes context compression docs describe native compression/caching.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};
const hermesSessions = {
  source: "Hermes session storage docs describe native session persistence.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};
const hermesAgentLoop = {
  source:
    "Hermes agent-loop docs define stored provider reasoning text and a reasoning callback; the Gateway separately exposes thinking.delta as animated status text.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Hermes Agent 0.20.0 (2026.8.3)",
  checkedAt: HERMES_REFRESHED_AT,
};

const opencodeAcp = {
  source:
    "OpenCode docs and ACP source describe ACP subprocess support, built-in tools, custom tools, slash commands, agents, and permissions.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenCode 1.18.3 (v1.18.3, 127bdb3)",
  checkedAt: REFRESHED_AT,
};
const opencodeSdk = {
  source:
    "OpenCode SDK docs describe session CRUD, prompt, abort, summarize, structured output, shell, messages, and permission response endpoints.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenCode 1.18.3 (v1.18.3, 127bdb3)",
  checkedAt: REFRESHED_AT,
};
const opencodeMcp = {
  source: "OpenCode docs describe local and remote MCP servers.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenCode 1.18.3 (v1.18.3, 127bdb3)",
  checkedAt: REFRESHED_AT,
};
const opencodePermission = {
  source: "OpenCode ACP permission source maps permission events to ACP session/request_permission.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenCode 1.18.3 (v1.18.3, 127bdb3)",
  checkedAt: REFRESHED_AT,
};
const opencodeUsage = {
  source: "OpenCode ACP usage source emits usage_update events.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenCode 1.18.3 (v1.18.3, 127bdb3)",
  checkedAt: REFRESHED_AT,
};
const linkedKernelSources = {
  source:
    "Official Kimi Code 0.36.1 and OpenClaw Gateway protocol references recorded in KERNEL_SOURCES; runtime exposure remains independently certified by version-bound receipts.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  checkedAt: "2026-08-31",
};
const openClawGatewaySource = {
  source: "Official OpenClaw 2026.8.2 Gateway protocol source and an exact-version challenge-handshake certification.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "OpenClaw 2026.8.2 (v2026.8.2, 0965053)",
  checkedAt: "2026-09-03",
};
const linkedSkillSources = {
  source:
    "Official OpenCode, Kimi Code, and OpenClaw skill documentation records kernel-native SKILL.md roots and invocation/loading semantics.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  checkedAt: PI_REFRESHED_AT,
};
const kimiAcpMcp = {
  source:
    "ACP session setup defines per-session MCP server injection; Kimi Code implements this surface through kimi acp.",
  sourcePath: "docs/reference/KERNEL_SOURCES.md",
  kind: "linked_source" as const,
  upstreamVersion: "Kimi Code 0.36.1",
  checkedAt: "2026-08-31",
};

export const KERNEL_NATIVE_CAPABILITY_FACTS: KernelNativeCapabilityFact[] = [
  ...facts(
    "codex",
    [
      "message.streamText",
      "planning.plan",
      "tool.progress",
      "diagnostics.usage",
      "output.artifacts",
      "reasoning.summary",
    ],
    "yes",
    codexNotifications,
  ),
  ...facts(
    "codex",
    ["turn.lifecycle", "session.lifecycle", "session.goal", "control.stop", "control.steer"],
    "yes",
    codexThread,
  ),
  ...facts("codex", ["media.input"], "yes", codexTurn),
  ...facts("codex", ["interaction.askUser", "tools.hostTool", "tools.mcpServers", "knowledge.skills"], "yes", codexMcp),
  ...facts("codex", ["approval.request", "sandbox.policy"], "yes", codexPermissions),
  ...facts("codex", ["tools.nativeTool", "session.compact", "auth.refresh", "output.structured"], "yes", codexProtocol),
  ...facts("codex", ["response.speed"], "yes", codexRuntimeControls),
  fact("codex", "reasoning.nativeText", "no", codexNotifications, [
    "Codex app-server exposes readable reasoning summary events, not native reasoning text.",
  ]),

  ...facts(
    "claude-code",
    [
      "message.streamText",
      "turn.lifecycle",
      "session.lifecycle",
      "tools.hostTool",
      "tools.mcpServers",
      "approval.request",
      "control.stop",
      "session.compact",
      "budget.limit",
      "diagnostics.usage",
      "output.structured",
      "knowledge.skills",
    ],
    "yes",
    claudeSdk,
  ),
  fact("claude-code", "reasoning.summary", "yes", claudeSdk, [
    "Claude Agent can request API-side thinking summaries. Ordinary SDK thinking_delta content is a different native surface; OpenGrove preserves it as explicitly typed process activity instead of relabeling it as a summary.",
  ]),
  fact("claude-code", "reasoning.nativeText", "yes", claudeSdk, [
    "The SDK protocol carries thinking_delta.thinking text; actual text emission is model/provider/redaction dependent.",
  ]),
  fact("claude-code", "media.input", "yes", {
    source:
      "Claude Agent SDK query() accepts AsyncIterable<SDKUserMessage> whose MessageParam content carries Anthropic ImageBlockParam (base64 image source).",
    sourcePath: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts",
    kind: "local_package",
    upstreamVersion: "@anthropic-ai/claude-agent-sdk 0.3.251 (Claude Code 2.1.251)",
    checkedAt: CLAUDE_REFRESHED_AT,
  }),
  fact("claude-code", "interaction.askUser", "yes", claudeTools),
  fact("claude-code", "tools.nativeTool", "yes", claudeTools),
  fact("claude-code", "planning.plan", "yes", claudeTools, [
    "Claude exposes TaskCreate, TaskUpdate, and TaskList task records; OpenGrove projects those native records into its structured plan stream.",
  ]),
  fact("claude-code", "sandbox.policy", "yes", claudeSdk, [
    "Claude Agent exposes permission modes/rules; this is a permission policy surface, not a guaranteed OS sandbox.",
  ]),

  ...facts(
    "pi",
    [
      "message.streamText",
      "turn.lifecycle",
      "tools.hostTool",
      "approval.request",
      "tools.parallelCalls",
      "tool.progress",
      "control.steer",
    ],
    "yes",
    piAgent,
  ),
  ...facts("pi", ["control.stop", "media.input", "diagnostics.usage"], "yes", piAi),
  fact("pi", "session.lifecycle", "yes", piHarnessSession, [
    "OpenGrove binds create/open/list/delete/fork to Pi's JSONL SessionRepo in durable desktop runs and uses Pi's InMemorySessionRepo for ephemeral runs.",
  ]),
  fact("pi", "session.compact", "yes", piHarnessCompaction, [
    "OpenGrove uses Pi's native threshold, preparation, summarization, retained-tail, and compaction-entry APIs for configured and model-window pressure; no Host-side history trimming remains.",
  ]),
  fact("pi", "tools.nativeTool", "yes", piHarnessTools, [
    "OpenGrove binds the official tools to the employee working directory and projects their lifecycle through the common policy, approval, progress, and result surface.",
    "OpenGrove Host Tools remain available beside native read, write, edit, and bash rather than replacing them.",
  ]),
  fact("pi", "knowledge.skills", "yes", piHarnessSkills, [
    "OpenGrove deliberately keeps its provenance-aware skill.invoke Host path as the single skill catalog instead of enabling a second native loader.",
  ]),
  fact("pi", "interaction.askUser", "no", piAgentTypes, [
    "No independent same-turn elicitation protocol is documented; OpenGrove can model questions through host tools or ordinary follow-up turns.",
  ]),
  fact("pi", "planning.plan", "no", piAgentTypes, [
    "Pi exposes ordinary messages and tool calls, not a dedicated plan-update protocol.",
  ]),
  fact("pi", "tools.mcpServers", "no", piAgentTypes, [
    "No first-class MCP server injection surface is exposed by Agent or AgentHarness.",
  ]),
  fact("pi", "session.goal", "no", piHarnessSession, [
    "Session labels and names are available, but there is no dedicated persisted agent-goal protocol.",
  ]),
  fact("pi", "auth.refresh", "yes", piAiModels, [
    "OAuth refresh is owned by the 0.83 Models collection; it is not used by OpenGrove's current API-key-only Pi binding.",
  ]),
  fact("pi", "sandbox.policy", "no", piHarnessTools, [
    "The harness abstracts filesystem and shell execution, but does not expose an OS sandbox policy comparable to Codex sandboxPolicy.",
  ]),
  fact("pi", "budget.limit", "no", piAi, [
    "Usage and cost are reported, but no hard per-run cost budget is documented.",
  ]),
  fact("pi", "response.speed", "no", piAi, [
    "Transport selection is exposed, but no service-tier or response-speed control is documented.",
  ]),
  fact("pi", "output.structured", "no", piAi, [
    "Constrained sampling applies to tool arguments; there is no general assistant output-schema contract.",
  ]),
  fact("pi", "output.artifacts", "no", piHarnessTools, [
    "Built-in file tools can mutate files, but Pi does not emit a first-class artifact output protocol.",
  ]),
  fact("pi", "reasoning.summary", "no", piAi, [
    "Pi exposes provider thinking blocks, which may be raw or provider-redacted reasoning, but it does not expose a distinct reasoning-summary protocol.",
  ]),
  fact("pi", "reasoning.nativeText", "yes", piAi, [
    "Pi 0.83 defines model.reasoning plus thinking_start/thinking_delta/thinking_end and ThinkingContent; emission is conditional on the selected model and provider.",
  ]),

  ...facts(
    "hermes",
    [
      "message.streamText",
      "turn.lifecycle",
      "session.lifecycle",
      "approval.request",
      "interaction.askUser",
      "control.stop",
      "control.steer",
      "diagnostics.usage",
    ],
    "yes",
    hermesProgrammatic,
  ),
  ...facts("hermes", ["tools.nativeTool", "tools.parallelCalls", "tool.progress", "budget.limit"], "yes", hermesTools),
  fact("hermes", "session.compact", "yes", hermesCompression),
  fact("hermes", "knowledge.skills", "yes", hermesGateway),
  fact("hermes", "output.artifacts", "yes", hermesSessions),
  fact("hermes", "reasoning.nativeText", "yes", hermesAgentLoop, [
    "Hermes stores provider reasoning text when exposed and emits it through reasoning.available/reasoning.delta; thinking.delta is not reasoning content.",
  ]),
  fact("hermes", "tools.hostTool", "no", hermesProgrammatic, [
    "The current TUI Gateway integration runs Hermes native toolsets; no OpenGrove host-tool bridge is documented or wired.",
  ]),
  fact("hermes", "tools.mcpServers", "no", hermesTools, [
    "Hermes docs describe native toolsets here, not an MCP server injection surface.",
  ]),
  fact("hermes", "sandbox.policy", "no", hermesTools),

  ...facts(
    "opencode",
    ["message.streamText", "turn.lifecycle", "tools.nativeTool", "tools.hostTool", "tool.progress"],
    "yes",
    opencodeAcp,
  ),
  ...facts(
    "opencode",
    ["session.lifecycle", "control.stop", "session.compact", "output.structured"],
    "yes",
    opencodeSdk,
  ),
  fact("opencode", "tools.mcpServers", "yes", opencodeMcp),
  fact("opencode", "approval.request", "yes", opencodePermission),
  fact("opencode", "diagnostics.usage", "yes", opencodeUsage),
  fact("opencode", "reasoning.nativeText", "yes", opencodeAcp, [
    "OpenCode's ACP transport can emit agent_thought_chunk; actual emission is model and turn dependent.",
  ]),
  fact("opencode", "knowledge.skills", "yes", linkedSkillSources, [
    "OpenGrove publishes portable skills into the documented .opencode/skills project root and lets OpenCode's native skill tool load them progressively.",
  ]),
  fact("kimi", "session.compact", "yes", linkedKernelSources, [
    "Kimi exposes the native /compact command; OpenGrove submits it to the same ACP session.",
  ]),
  ...facts("kimi", ["tools.hostTool", "tools.mcpServers"], "yes", kimiAcpMcp, [
    "OpenGrove real-runtime probes independently certify whether the per-session MCP surface is wired and exposed.",
  ]),
  fact("kimi", "knowledge.skills", "yes", linkedSkillSources, [
    "OpenGrove publishes portable skills into .kimi-code/skills and uses Kimi's documented /skill:<name> invocation form.",
  ]),
  fact("openclaw", "session.compact", "yes", openClawGatewaySource, [
    "OpenClaw Gateway exposes sessions.compact and automatic compaction.",
  ]),
  fact("openclaw", "diagnostics.usage", "yes", openClawGatewaySource, [
    "OpenClaw Gateway sessions.list exposes totalTokens, totalTokensFresh, and contextTokens.",
  ]),
  fact("openclaw", "knowledge.skills", "yes", linkedSkillSources, [
    "OpenClaw owns workspace-scoped native skill roots. The current Gateway bridge cannot prove its cwd matches the configured agent workspace, so OpenGrove uses an explicit selected-skill prompt fallback instead of claiming native publication.",
  ]),
] satisfies KernelNativeCapabilityFact[];
