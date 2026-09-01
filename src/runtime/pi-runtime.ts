import {
  evaluateToolPolicy,
  agentTurnReplyLanguageInstruction,
  type AgentEvent,
  type AgentContext,
  type AgentCompactRequest,
  type AgentCompactResult,
  type AgentRuntime,
  type AgentSessionDeleteResult,
  type AgentSessionForkResult,
  type AgentSessionInfo,
  type AgentSessionListResult,
  type AgentSessionTrace,
  type AgentTurnRequest,
  type CapabilityManifest,
  type ContextEnvelope,
  type InvokedSkillRecord,
  type PackManifest,
  type PolicyDecision,
  type PolicyRule,
  type SkillManifest,
  type ToolDefinition,
  type ToolRisk,
  type ToolSpec,
} from "../core.js";
import { renderSkillIndex } from "../skills/catalog.js";
import { imageAttachmentsWithDataUrl } from "./media-input.js";

export interface PiToolCallGate {
  toolId: string;
  capabilityId?: string;
  source: "host" | "native";
}

export interface PiSessionContext {
  runId: string;
  agent: AgentContext;
  tools: ToolDefinition[];
  skills: SkillManifest[];
  packs: PackManifest[];
  capabilities: CapabilityManifest[];
  signal?: AbortSignal;
  requestedSkillInvocation?: InvokedSkillRecord;
  assembledContext?: ContextEnvelope;
  contextTokenBudget?: number;
  beforeToolCall(gate: PiToolCallGate): Promise<PolicyDecision>;
}

export interface PiSession {
  /** Native sessions trace each actual provider request after context transformation. */
  readonly emitsModelRequests?: boolean;
  run(input: string, context: PiSessionContext): AsyncIterable<AgentEvent>;
  trace?(input?: {
    contextTokenBudget?: number;
    incomingInput?: string;
  }): AgentSessionTrace | undefined | Promise<AgentSessionTrace | undefined>;
  compact?(request: AgentCompactRequest): Promise<AgentCompactResult>;
}

export interface PiSessionFactory {
  (context: {
    sessionId: string;
    system: string;
    requestedModelId?: string;
    requestedEffort?: string;
    tools: ToolDefinition[];
    skills: SkillManifest[];
    packs: PackManifest[];
    capabilities: CapabilityManifest[];
  }): PiSession;
  compactSession?(request: AgentCompactRequest): Promise<AgentCompactResult>;
  listSessions?(): Promise<AgentSessionInfo[]>;
  deleteSession?(sessionId: string): Promise<AgentSessionDeleteResult>;
  forkSession?(sourceSessionId: string, targetSessionId: string): Promise<AgentSessionForkResult>;
}

export interface PiAgentRuntimeOptions {
  createSession: PiSessionFactory;
  system?: string;
}

const DEFAULT_SYSTEM = [
  "You are OpenGrove, a personal agent.",
  "Keep the core loop simple: observe, reason, use tools only when helpful, and explain uncertainty.",
  "Tools are hands, skills are reusable ways to work, and memory is written only through the ledger.",
].join("\n");

export class PiAgentRuntime implements AgentRuntime {
  constructor(private readonly options: PiAgentRuntimeOptions) {}

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = request.runId ?? `run_${Date.now()}`;
    const skills = request.skills ?? [];
    const packs = request.packs ?? [];
    const capabilities = request.capabilities ?? [];
    const policy = request.policy ?? capabilities.flatMap((capability) => capability.policy);
    const systemPrompt = [
      buildSystemPrompt(
        this.options.system ?? DEFAULT_SYSTEM,
        request.context,
        skills,
        packs,
        capabilities,
        agentTurnReplyLanguageInstruction(request),
      ),
      request.sessionInstructions?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
    const session = this.options.createSession({
      sessionId: request.context.sessionId,
      system: systemPrompt,
      requestedModelId: request.requestedModelId,
      requestedEffort: request.requestedEffort,
      tools: request.tools,
      skills,
      packs,
      capabilities,
    });
    let assistantText = "";
    let emittedModelResponse = false;

    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.assembledContext) {
      yield { type: "context.assembled", runId, context: request.assembledContext };
    }
    let sessionTrace: AgentSessionTrace | undefined;
    try {
      sessionTrace = await session.trace?.({
        contextTokenBudget: request.contextTokenBudget,
        incomingInput: request.input,
      });
    } catch (error) {
      yield {
        type: "error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      };
      yield { type: "model.response", runId, response: { text: "" } };
      yield { type: "turn.finished", runId, at: new Date().toISOString() };
      return;
    }
    if (!session.emitsModelRequests) {
      yield {
        type: "model.requested",
        runId,
        request: {
          systemPrompt,
          userInput: request.input,
          modelId: request.requestedModelId,
          session: sessionTrace,
          context: request.assembledContext,
          tools: request.tools.map((tool) => tool.spec),
          skills,
          packs,
          capabilities,
        },
      };
    }

    const imageInputs = imageAttachmentsWithDataUrl(request.context.page?.attachments).length;
    if (imageInputs) {
      yield {
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "pi.media_input.configured",
        data: { imageInputs },
      };
    }

    try {
      const context: PiSessionContext = {
        runId,
        agent: request.context,
        tools: request.tools,
        skills,
        packs,
        capabilities,
        signal: request.signal,
        requestedSkillInvocation: request.requestedSkillInvocation,
        assembledContext: request.assembledContext,
        contextTokenBudget: request.contextTokenBudget,
        beforeToolCall: async (gate) => {
          if (gate.source === "native") {
            return evaluatePiNativeToolPolicy(gate.toolId, request.accessMode, policy);
          }
          const tool = request.tools.find((candidate) => candidate.spec.id === gate.toolId);
          if (!tool) {
            return { mode: "deny", reason: `Unknown tool: ${gate.toolId}` };
          }
          if (request.accessMode === "full-access") {
            return { mode: "allow", reason: "OpenGrove full-access mode allows host tool execution for this turn." };
          }
          return evaluateToolPolicy(tool.spec, policy, gate.capabilityId);
        },
      };

      for await (const event of session.run(request.input, context)) {
        if (event.type === "assistant.delta") {
          assistantText += event.text;
        }
        if (event.type === "model.response") {
          emittedModelResponse = true;
          assistantText = event.response.text;
        }
        yield event;
      }
    } catch (error) {
      yield {
        type: "error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (!emittedModelResponse) {
      yield { type: "model.response", runId, response: { text: assistantText } };
    }

    yield { type: "turn.finished", runId, at: new Date().toISOString() };
  }

  compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    return (
      this.options.createSession.compactSession?.(request) ??
      Promise.resolve({
        ok: false,
        compacted: false,
        error: "pi_native_compaction_unavailable",
      })
    );
  }

  async listSessions(): Promise<AgentSessionListResult> {
    if (!this.options.createSession.listSessions) {
      return { ok: false, sessions: [], error: "pi_session_list_unavailable" };
    }
    try {
      return { ok: true, sessions: await this.options.createSession.listSessions() };
    } catch (error) {
      return {
        ok: false,
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteSession(sessionId: string): Promise<AgentSessionDeleteResult> {
    if (!this.options.createSession.deleteSession) {
      return { ok: false, deleted: false, error: "pi_session_delete_unavailable" };
    }
    try {
      return await this.options.createSession.deleteSession(sessionId);
    } catch (error) {
      return {
        ok: false,
        deleted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async forkSession(sourceSessionId: string, targetSessionId: string): Promise<AgentSessionForkResult> {
    if (!this.options.createSession.forkSession) {
      return { ok: false, forked: false, error: "pi_session_fork_unavailable" };
    }
    try {
      return await this.options.createSession.forkSession(sourceSessionId, targetSessionId);
    } catch (error) {
      return {
        ok: false,
        forked: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function evaluatePiNativeToolPolicy(
  toolId: string,
  accessMode: AgentTurnRequest["accessMode"],
  policy: PolicyRule[],
): PolicyDecision {
  const spec = piNativeToolSpec(toolId);
  if (!spec) return { mode: "deny", reason: `Unknown Pi native tool: ${toolId}` };
  if (accessMode === "full-access") {
    return { mode: "allow", reason: "OpenGrove full-access mode allows Pi native tool execution for this turn." };
  }
  if (accessMode === "auto-review" && toolId !== "bash") {
    return {
      mode: "allow",
      reason: "OpenGrove auto-review mode allows Pi read and file-edit tools; shell commands still require review.",
    };
  }
  return evaluateToolPolicy(spec, policy);
}

function piNativeToolSpec(toolId: string): ToolSpec | undefined {
  const riskByTool: Record<string, ToolRisk> = {
    read: "read",
    write: "write",
    edit: "write",
    bash: "write",
  };
  const risk = riskByTool[toolId];
  if (!risk) return undefined;
  return {
    id: toolId,
    title: `Pi ${toolId}`,
    description: `Pi native ${toolId} tool`,
    activity: "local",
    risk,
    input: { type: "json-schema", schema: { type: "object" } },
    permission: {
      mode: risk === "read" ? "allow" : "ask",
      reason: risk === "read" ? "Reading is safe by default." : `Pi ${toolId} changes local state and requires review.`,
    },
  };
}

function buildSystemPrompt(
  base: string,
  context: AgentContext,
  skills: SkillManifest[],
  packs: PackManifest[],
  capabilities: CapabilityManifest[],
  replyLanguageInstruction: string,
): string {
  const skillLines = getCachedPromptSection(context, "skillIndex", () => renderSkillIndex(skills));
  const capabilityLines = capabilities.map(
    (capability) => `- ${capability.id}@${capability.version}: ${capability.description}`,
  );
  const packLines = packs.map((pack) => `- ${pack.id}: ${pack.description}`);

  return [
    base,
    "\nSkill protocol:",
    "- Keep the base prompt small. Skills are indexed here and loaded on demand.",
    "- When a skill matches the user's request, this is a blocking requirement: invoke `skill.invoke` before generating any substantive response about the task.",
    "- Never mention or rely on a skill without actually invoking it first.",
    "- For user slash commands, treat `/<skill-name>` as an explicit skill load request.",
    skillLines ? `\nAvailable skills:\n${skillLines}` : "",
    packLines.length ? `\nAvailable packs:\n${packLines.join("\n")}` : "",
    capabilityLines.length ? `\nAvailable capabilities:\n${capabilityLines.join("\n")}` : "",
    replyLanguageInstruction,
  ]
    .filter(Boolean)
    .join("\n");
}

function getCachedPromptSection(context: AgentContext, key: string, compute: () => string): string {
  const workingState = context.workingState.get();
  const nextValue = compute();
  if (workingState.toolSchemaCache[key] === nextValue) {
    return nextValue;
  }
  context.workingState.update({
    toolSchemaCache: {
      ...workingState.toolSchemaCache,
      [key]: nextValue,
    },
  });
  return nextValue;
}
