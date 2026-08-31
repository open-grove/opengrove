import type {
  KernelAdapter,
  KernelAdapterContract,
  KernelCapabilities,
  KernelDiscovery,
  KernelHealth,
  KernelSessionHandle,
  KernelSessionStart,
  KernelTurnRequest,
} from "../types.js";

const UNAVAILABLE_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "host",
  reasoning: { nativeText: "unsupported", summary: "unsupported" },
  streaming: false,
  toolCalls: false,
  hostTools: false,
  approvals: false,
  elicitation: false,
  artifacts: false,
  compaction: false,
  authRefresh: false,
  sandbox: [],
  nativeThreadGoal: false,
  nativeSkillCatalog: false,
};

const UNAVAILABLE_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: null,
    defaultConfigHome: ".unavailable",
    cliCommand: "unavailable",
    projectSkillDir: null,
    nativeSkillMarker: null,
    knowledgeBuckets: [],
    defaultKnowledgeBucket: "unavailable",
  },
  display: {
    defaultModelId: "unavailable",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: { withArgs: "${name} {args}", withoutArgs: "${name}" },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: { title: "Unavailable", integrationMode: "", unavailableReason: "Kernel is unavailable" },
  ownership: [
    { feature: "session", owner: "unsupported" },
    { feature: "turn_lifecycle", owner: "unsupported" },
    { feature: "model_loop", owner: "unsupported" },
    { feature: "native_tool_execution", owner: "unsupported" },
    { feature: "host_tool_execution", owner: "unsupported" },
    { feature: "approval", owner: "unsupported" },
    { feature: "user_question", owner: "unsupported" },
    { feature: "skill_discovery", owner: "unsupported" },
    { feature: "skill_loading", owner: "unsupported" },
    { feature: "context_assembly", owner: "unsupported" },
    { feature: "knowledge_retrieval", owner: "unsupported" },
    { feature: "artifact_extraction", owner: "unsupported" },
    { feature: "memory_write", owner: "unsupported" },
    { feature: "compaction", owner: "unsupported" },
    { feature: "auth", owner: "unsupported" },
    { feature: "sandbox", owner: "unsupported" },
    { feature: "trajectory", owner: "unsupported" },
    { feature: "diagnostics", owner: "unsupported" },
  ],
};

export function createUnavailableKernelAdapter(input: {
  kernelId: string;
  title?: string;
  reason: string;
  code?: string;
}): KernelAdapter {
  const sessionHandle = (sessionId: string): KernelSessionHandle => {
    const now = new Date().toISOString();
    return {
      kernelId: input.kernelId,
      sessionId,
      createdAt: now,
      updatedAt: now,
    };
  };
  return {
    id: input.kernelId,
    title: input.title || "Unavailable kernel",
    capabilities: UNAVAILABLE_CAPABILITIES,
    contract: UNAVAILABLE_CONTRACT,
    async healthCheck(): Promise<KernelHealth> {
      return { status: "unavailable", message: input.reason };
    },
    async discover(): Promise<KernelDiscovery> {
      return {
        kernelId: input.kernelId,
        title: input.title || input.kernelId,
        installed: false,
        available: false,
        health: { status: "unavailable", message: input.reason },
        knowledgeSources: [],
        installActions: [],
        notes: [input.reason],
      };
    },
    async startSession(start: KernelSessionStart): Promise<KernelSessionHandle> {
      return sessionHandle(start.sessionId);
    },
    async resumeSession(sessionId: string): Promise<KernelSessionHandle> {
      return sessionHandle(sessionId);
    },
    async *runTurn(_request: KernelTurnRequest) {
      const error = new Error(input.reason) as Error & { code: string };
      error.name = "KernelUnavailableError";
      error.code = input.code ?? "kernel_unavailable";
      throw error;
    },
  };
}
