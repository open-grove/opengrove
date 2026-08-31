import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntimeKernelAdapter } from "../adapter.js";
import { bridgeKernelSupportsHostTools } from "../host-tools.js";
import type { KernelAdapter, KernelAdapterContract, KernelCapabilities, KernelDiscovery } from "../types.js";
import { APP_PRODUCT_NAME, APP_PROTOCOL_ID, appEnvName, readAppEnv } from "../../identity.js";
import {
  OpenClawGatewayRuntime,
  type OpenClawGatewayRuntimeOptions,
  resolveOpenClawGatewayConnection,
} from "../../runtime/openclaw-gateway-runtime.js";
import {
  directorySource,
  kernelExecutableProbe,
  plannedInstallAction,
  probeCommandPath,
  resolveHomePath,
  resolveUsableCommandPath,
} from "../discovery.js";
import {
  type KernelLocalRouteProfile,
  configHome,
  firstConfiguredCredentialId,
  objectValue,
  providerDisplayName,
  readJsonObject,
} from "./profile-utils.js";

const OPENCLAW_GATEWAY_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "kernel",
  reasoning: { nativeText: "unsupported", summary: "unsupported" },
  streaming: true,
  toolCalls: false,
  hostTools: bridgeKernelSupportsHostTools("openclaw"),
  approvals: false,
  elicitation: false,
  artifacts: false,
  compaction: true,
  authRefresh: false,
  sandbox: ["danger-full-access"],
  knowledge: {
    nativeSkills: false,
    toolMediatedSkills: false,
    progressiveDisclosure: false,
    nativeArtifacts: false,
    deliveryLedger: true,
  },
  nativeThreadGoal: false,
  nativeSkillCatalog: false,
};

export function createOpenClawGatewayKernelAdapter(options: OpenClawGatewayRuntimeOptions): KernelAdapter {
  return createRuntimeKernelAdapter({
    id: "openclaw",
    title: "OpenClaw",
    runtime: new OpenClawGatewayRuntime(options),
    capabilities: OPENCLAW_GATEWAY_CAPABILITIES,
    contract: OPENCLAW_GATEWAY_CONTRACT,
  });
}

export function createOpenClawGatewayKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): KernelAdapter {
  const connection = resolveOpenClawGatewayConnection(options.env, {
    configHome: options.configHome,
  });
  if (!connection) {
    throw new Error("OpenClaw Gateway is not configured.");
  }
  return createOpenClawGatewayKernelAdapter({
    ...connection,
    cwd: options.cwd,
    configuredModel: options.model,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    env: options.env,
  });
}

export const OPENCLAW_GATEWAY_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: null,
    defaultConfigHome: ".openclaw",
    cliCommand: "openclaw",
    projectSkillDir: null,
    nativeSkillMarker: null,
    knowledgeBuckets: [],
    defaultKnowledgeBucket: `${APP_PROTOCOL_ID}.skills`,
  },
  display: {
    defaultModelId: "openclaw-default",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: { withArgs: "/skill {name} {args}", withoutArgs: "/skill {name}" },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: {
    title: "OpenClaw",
    integrationMode: "gateway",
    unavailableReason: `No local OpenClaw Gateway configuration was found and ${appEnvName("OPENCLAW_GATEWAY_URL")} is not set`,
  },
  ownership: [
    {
      feature: "session",
      owner: "shared",
      nativeName: "OpenClaw Gateway sessionKey",
      appResponsibility: "Own OpenGrove room/session ids and normalized trajectory records.",
      adapterResponsibility: "Bind OpenGrove turns to an OpenClaw Gateway sessionKey and run id.",
      kernelResponsibility: "Own OpenClaw's native transcript, agent config, and session store.",
    },
    {
      feature: "turn_lifecycle",
      owner: "adapter",
      nativeName: "chat.send / agent.wait",
      adapterResponsibility: "Submit chat.send over WebSocket, wait with agent.wait, and normalize agent events.",
      kernelResponsibility: "Run the OpenClaw model/tool loop inside the Gateway.",
    },
    {
      feature: "model_loop",
      owner: "kernel",
      kernelResponsibility:
        "Own provider selection, native tools, skills, memory, and delivery behavior configured in OpenClaw.",
      adapterResponsibility: "Do not parse raw CLI JSON or reimplement OpenClaw internals.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      kernelResponsibility: "Execute OpenClaw native tools inside the Gateway agent loop.",
      adapterResponsibility:
        "Do not claim structured tool events until the Gateway bridge observes and certifies them.",
    },
    {
      feature: "host_tool_execution",
      owner: "unsupported",
      notes: "The current Gateway bridge does not inject OpenGrove Host Tools.",
    },
    {
      feature: "approval",
      owner: "unsupported",
      notes: "OpenGrove has not observed a Gateway permission round-trip that it can safely bridge.",
    },
    {
      feature: "user_question",
      owner: "unsupported",
      notes: "The current Gateway bridge has no same-turn elicitation mapping.",
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      appResponsibility: "Own selected OpenGrove skill provenance and delivery records.",
      kernelResponsibility: "Own workspace-scoped OpenClaw skill discovery.",
      adapterResponsibility:
        "Use explicit selected-skill prompt fallback because the Gateway session's configured workspace is not proven to equal OpenGrove cwd.",
    },
    {
      feature: "skill_loading",
      owner: "shared",
      appResponsibility: "Load only an explicitly selected OpenGrove skill for the fallback path.",
      kernelResponsibility:
        "Own native progressive skill loading for skills already installed in the configured OpenClaw workspace.",
      adapterResponsibility: "Never claim native publication without a verified Gateway workspace binding.",
    },
    {
      feature: "context_assembly",
      owner: "shared",
      appResponsibility: "Provide explicit Host context and selected-skill fallback instructions.",
      kernelResponsibility:
        "Own OpenClaw workspace instructions, native history, memory, skills, tools, and automatic compaction.",
      adapterResponsibility: "Keep Host context distinct and do not replay App history into the native session.",
    },
    {
      feature: "knowledge_retrieval",
      owner: "unsupported",
      notes:
        "The Gateway bridge does not project a typed native retrieval surface; OpenClaw may still retrieve through its own internal tools.",
    },
    {
      feature: "artifact_extraction",
      owner: "unsupported",
      notes: "The Gateway bridge has no certified native artifact projection.",
    },
    {
      feature: "memory_write",
      owner: "shared",
      appResponsibility: "Own OpenGrove memory records explicitly included in Host context.",
      kernelResponsibility: "Own OpenClaw native workspace memory and retention behavior.",
    },
    {
      feature: "compaction",
      owner: "kernel",
      appResponsibility: "May request native compaction at a configured product threshold without trimming history.",
      kernelResponsibility: "Own automatic/manual session compaction and transcript rewriting.",
      adapterResponsibility: "Call sessions.compact and preserve the confirmed native result.",
    },
    {
      feature: "auth",
      owner: "kernel",
      kernelResponsibility: "Own Gateway and provider authentication.",
      adapterResponsibility: "Use configured Gateway token/password fields without logging them.",
    },
    {
      feature: "sandbox",
      owner: "kernel",
      kernelResponsibility: "Own OpenClaw tool policy and sandbox configuration.",
      adapterResponsibility: "Do not advertise a Host-controlled sandbox while no Gateway policy bridge exists.",
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "Gateway WebSocket",
      adapterResponsibility: "Use request/response/event frames over the persistent Gateway socket.",
    },
    {
      feature: "diagnostics",
      owner: "shared",
      appResponsibility: `Persist ${APP_PRODUCT_NAME} trajectory and redacted runtime diagnostics.`,
      kernelResponsibility: "Keep OpenClaw's native logs and Gateway transcript.",
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: `Persist ${APP_PRODUCT_NAME} normalized turn trajectory.`,
      adapterResponsibility: "Record Gateway run/session ids and bounded redacted diagnostics.",
    },
  ],
  eventMappings: [
    {
      appEvent: "assistant.delta",
      nativeEvent: "Gateway event agent/assistant",
      direction: "native_to_app",
      adapterResponsibility: "Forward assistant text only; never surface raw Gateway JSON as chat text.",
    },
    {
      appEvent: "error",
      nativeEvent: "Gateway event agent/lifecycle error or failed RPC",
      direction: "native_to_app",
      adapterResponsibility: "Map Gateway failures to concise OpenGrove error events.",
    },
  ],
  diagnostics: {
    defaultModeId: "openclaw-gateway-websocket",
    modes: [
      {
        id: "openclaw-gateway-websocket",
        title: "OpenClaw Gateway WebSocket",
        layer: "adapter-rpc",
        status: "implemented",
        enabledByDefault: true,
        redaction: "redacted",
        notes: ["Uses `chat.send`, Gateway `agent` events, `agent.wait`, and `chat.history` for final reconciliation."],
      },
      {
        id: `${APP_PROTOCOL_ID}-trajectory`,
        title: `${APP_PRODUCT_NAME} trajectory JSON`,
        layer: "trajectory",
        status: "implemented",
        enabledByDefault: true,
        output: "data/trajectories/",
        redaction: "redacted",
      },
    ],
  },
  notes: [
    "OpenClaw is a remote/native agent surface. OpenGrove only bridges its Gateway protocol and does not keep the old one-shot CLI path.",
  ],
};

export function isOpenClawGatewayConfigured(options?: { configHome?: string; env?: NodeJS.ProcessEnv }): boolean {
  return Boolean(
    resolveOpenClawGatewayConnection(options?.env ?? process.env, {
      configHome: options?.configHome,
    }),
  );
}

// ===== Discovery =====

export function discoverOpenClawKernel(
  configuredCommand?: string,
  options: { configHome?: string; env?: NodeJS.ProcessEnv } = {},
): KernelDiscovery {
  const candidate = openClawExecutableCandidate(configuredCommand);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const configHome = options.configHome?.trim() || resolveHomePath(".openclaw");
  const gatewayConfigured = isOpenClawGatewayConfigured({
    configHome,
    env: options.env ?? process.env,
  });
  const executableProbe = kernelExecutableProbe(discovery, {
    role: "optional-diagnostic",
    source: candidate.source,
    sourceName: candidate.sourceName,
  });
  return {
    kernelId: "openclaw",
    title: "OpenClaw",
    installed: gatewayConfigured,
    available: gatewayConfigured,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe,
    health: gatewayConfigured
      ? {
          status: "ok",
          message: "OpenClaw Gateway is configured.",
          metadata: { executableProbe: { ...executableProbe } },
        }
      : {
          status: "unavailable",
          message: "OpenClaw Gateway is not configured.",
          metadata: { executableProbe: { ...executableProbe } },
        },
    configHome,
    diagnostics: OPENCLAW_GATEWAY_CONTRACT.diagnostics,
    knowledgeSources: [
      directorySource({
        id: "openclaw.skills",
        title: "skills",
        kind: "skills",
        scope: "user",
        path: "~/.openclaw/skills",
      }),
      directorySource({
        id: "openclaw.memory",
        title: "memory",
        kind: "memory",
        scope: "user",
        path: "~/.openclaw/memory",
      }),
      directorySource({
        id: "openclaw.providers",
        title: "providers",
        kind: "settings",
        scope: "user",
        path: "~/.openclaw/providers",
        knowledgeLike: false,
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "openclaw.install",
        title: "Install OpenClaw",
        command: ["npm", "install", "-g", "openclaw"],
      }),
    ],
    notes: [
      "OpenGrove connects to OpenClaw Gateway WebSocket and uses `chat.send` plus `agent.wait`; prompt-only CLI execution is not part of this adapter.",
    ],
  };
}

function openClawExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("OPENCLAW_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("OPENCLAW_BIN") };
  }
  return { command: "openclaw", source: "path" as const };
}

export function resolveOpenClawCommand(): string | undefined {
  const configured = readAppEnv("OPENCLAW_BIN")?.trim();
  if (configured) return resolveUsableCommandPath(configured);
  return resolveUsableCommandPath("openclaw");
}

// ===== Legacy local-auth inspection (not a Login or runnable Provider route) =====

export function readOpenClawLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const home = configHome(configHomeOverride, ".openclaw");
  const configPath = resolve(home, "openclaw.json");
  const authPath = resolve(home, "agents", "main", "agent", "auth-profiles.json");
  const auth = readJsonObject(authPath);
  const profiles = objectValue(auth.profiles);
  const profileId = firstConfiguredCredentialId(profiles);
  const providerId = profileId?.split(":")[0] || "openclaw-native";
  return {
    kernel: "openclaw",
    source: [configPath, authPath].filter((path) => existsSync(path)).join(",") || "openclaw-defaults",
    sourcePaths: [configPath, authPath],
    env: {},
    providerId,
    providerLabel: profileId ? providerDisplayName(providerId) : "OpenClaw",
    authConfigured: false,
    routeKind: "provider",
    models: [],
  };
}
