import type {
  BridgeKernelId,
  BridgeProviderCredentialKind,
  BridgeProviderProfile,
  BridgeProviderProtocol,
  BridgeRuntimeControlOption,
  BridgeRuntimeControls,
  BridgeState,
} from "./bridge-types.js";
import { BRIDGE_KERNEL_IDS, DEFAULT_BRIDGE_MODEL_ID } from "./bridge-types.js";
import type {
  KernelAdapterContract,
  KernelPathContract,
  KernelDisplayContract,
  KernelInputFormatContract,
  KernelDiscovery,
  KernelAdapter,
  KernelCreateOptions,
  ProviderProfile,
} from "../kernel/types.js";
import {
  CODEX_KERNEL_CONTRACT,
  buildCodexProviderEnv,
  buildCodexRuntimeControls,
  discoverCodexKernel,
  createCodexKernelAdapterFromOptions,
} from "../kernel/adapters/codex.js";
import {
  buildClaudeCodeProviderEnv,
  buildClaudeCodeRuntimeControls,
  discoverClaudeCodeKernel,
  createClaudeCodeKernelAdapterFromOptions,
  claudeCodeKernelContract,
} from "../kernel/adapters/claude-code.js";
import {
  HERMES_KERNEL_CONTRACT,
  buildHermesProviderEnv,
  buildHermesRuntimeControls,
  discoverHermesKernel,
  createHermesKernelAdapterFromOptions,
} from "../kernel/adapters/hermes.js";
import {
  PI_KERNEL_CONTRACT,
  buildPiProviderEnv,
  discoverPiKernel,
  createPiKernelAdapterFromOptions,
} from "../kernel/adapters/pi.js";
import {
  OPENCLAW_GATEWAY_CONTRACT,
  discoverOpenClawKernel,
  createOpenClawGatewayKernelAdapterFromOptions,
} from "../kernel/adapters/openclaw.js";
import {
  OPENCODE_KERNEL_CONTRACT,
  buildOpenCodeProviderEnv,
  opencodeModelIdForProvider,
  opencodeSupportsProvider,
  discoverOpenCodeKernel,
  createOpenCodeKernelAdapterFromOptions,
} from "../kernel/adapters/opencode.js";
import {
  KIMI_KERNEL_CONTRACT,
  buildKimiProviderEnv,
  discoverKimiKernel,
  createKimiKernelAdapterFromOptions,
} from "../kernel/adapters/kimi.js";
import { readClaudeCodeLocalRouteProfile } from "../kernel/adapters/claude-code.js";
import { readCodexLocalRouteProfile } from "../kernel/adapters/codex.js";
import { readHermesLocalRouteProfile } from "../kernel/adapters/hermes.js";
import { readPiLocalRouteProfile } from "../kernel/adapters/pi.js";
import { readOpenClawLocalRouteProfile } from "../kernel/adapters/openclaw.js";
import { readOpenCodeLocalRouteProfile } from "../kernel/adapters/opencode.js";
import { readKimiLocalRouteProfile } from "../kernel/adapters/kimi.js";
import {
  type KernelLocalRouteReadOptions,
  type KernelLocalRouteProfile,
  readOptions,
  stringValue,
} from "../kernel/adapters/profile-utils.js";
import { bridgeKernelSupportsHostTools } from "../kernel/host-tools.js";
import { usesKernelManagedProviderConfig, planProviderBinding } from "./provider-binding.js";
import { providerModelForSelection } from "./models-dev-catalog.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type { KernelLocalRouteProfile, KernelLocalRouteReadOptions };

// ===== Kernel descriptor (static metadata) =====

export type BridgeKernelBindingMode = "native" | "env" | "config-file" | "native-api" | "gateway";

export interface BridgeKernelExternalProviderRoute {
  protocol: BridgeProviderProtocol;
  credentialKinds: BridgeProviderCredentialKind[];
}

export interface BridgeKernelDescriptor {
  id: BridgeKernelId;
  label: string;
  hostTools: boolean;
  accountLogin: boolean;
  externalProviderRoutes: BridgeKernelExternalProviderRoute[];
  bindingMode: BridgeKernelBindingMode;
  nativeControls: {
    reasoning: boolean;
    speed: boolean;
  };
  externalControls: {
    reasoning: boolean;
    speed: boolean;
  };
  thread: {
    isolateByRuntimeBinding: boolean;
    reuseAcrossModelChanges: boolean;
  };
}

const API_CREDENTIALS: BridgeProviderCredentialKind[] = ["api-key", "env-key"];

const KERNEL_DESCRIPTORS: Record<BridgeKernelId, BridgeKernelDescriptor> = {
  codex: {
    id: "codex",
    label: "Codex",
    hostTools: bridgeKernelSupportsHostTools("codex"),
    accountLogin: true,
    externalProviderRoutes: [{ protocol: "openai-compatible", credentialKinds: API_CREDENTIALS }],
    bindingMode: "config-file",
    nativeControls: { reasoning: true, speed: true },
    externalControls: { reasoning: false, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: true },
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Agent",
    hostTools: bridgeKernelSupportsHostTools("claude-code"),
    accountLogin: true,
    externalProviderRoutes: [
      {
        protocol: "anthropic-compatible",
        credentialKinds: [...API_CREDENTIALS, "aws", "google-adc"],
      },
    ],
    bindingMode: "config-file",
    nativeControls: { reasoning: true, speed: false },
    externalControls: { reasoning: true, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: false },
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    hostTools: bridgeKernelSupportsHostTools("hermes"),
    accountLogin: false,
    externalProviderRoutes: [
      { protocol: "openai-compatible", credentialKinds: API_CREDENTIALS },
      { protocol: "anthropic-compatible", credentialKinds: API_CREDENTIALS },
    ],
    bindingMode: "config-file",
    nativeControls: { reasoning: false, speed: false },
    externalControls: { reasoning: false, speed: false },
    thread: { isolateByRuntimeBinding: false, reuseAcrossModelChanges: false },
  },
  pi: {
    id: "pi",
    label: "Pi",
    hostTools: bridgeKernelSupportsHostTools("pi"),
    accountLogin: false,
    externalProviderRoutes: [
      { protocol: "openai-compatible", credentialKinds: API_CREDENTIALS },
      { protocol: "anthropic-compatible", credentialKinds: API_CREDENTIALS },
      { protocol: "gemini-compatible", credentialKinds: API_CREDENTIALS },
    ],
    bindingMode: "native-api",
    nativeControls: { reasoning: false, speed: false },
    externalControls: { reasoning: true, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: true },
  },
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    hostTools: bridgeKernelSupportsHostTools("openclaw"),
    accountLogin: false,
    externalProviderRoutes: [{ protocol: "custom-gateway", credentialKinds: ["gateway-managed"] }],
    bindingMode: "gateway",
    nativeControls: { reasoning: false, speed: false },
    externalControls: { reasoning: false, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: true },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    hostTools: bridgeKernelSupportsHostTools("opencode"),
    accountLogin: false,
    externalProviderRoutes: [
      { protocol: "openai-compatible", credentialKinds: API_CREDENTIALS },
      { protocol: "anthropic-compatible", credentialKinds: ["aws"] },
    ],
    bindingMode: "env",
    nativeControls: { reasoning: false, speed: false },
    externalControls: { reasoning: false, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: false },
  },
  kimi: {
    id: "kimi",
    label: "Kimi Code",
    hostTools: bridgeKernelSupportsHostTools("kimi"),
    accountLogin: true,
    externalProviderRoutes: [
      { protocol: "openai-compatible", credentialKinds: API_CREDENTIALS },
      { protocol: "anthropic-compatible", credentialKinds: API_CREDENTIALS },
    ],
    bindingMode: "env",
    nativeControls: { reasoning: false, speed: false },
    externalControls: { reasoning: false, speed: false },
    thread: { isolateByRuntimeBinding: true, reuseAcrossModelChanges: true },
  },
};

export function getBridgeKernelDescriptor(kernelId: BridgeKernelId): BridgeKernelDescriptor {
  return KERNEL_DESCRIPTORS[kernelId];
}

// ===== Kernel adapter contracts =====

const KERNEL_CONTRACTS: Record<BridgeKernelId, () => KernelAdapterContract> = {
  codex: () => CODEX_KERNEL_CONTRACT,
  "claude-code": claudeCodeKernelContract,
  hermes: () => HERMES_KERNEL_CONTRACT,
  pi: () => PI_KERNEL_CONTRACT,
  openclaw: () => OPENCLAW_GATEWAY_CONTRACT,
  opencode: () => OPENCODE_KERNEL_CONTRACT,
  kimi: () => KIMI_KERNEL_CONTRACT,
};

const PROVIDER_ENV_BUILDERS: Partial<
  Record<BridgeKernelId, (profile: ProviderProfile) => Record<string, string> | undefined>
> = {
  "claude-code": buildClaudeCodeProviderEnv,
  codex: buildCodexProviderEnv,
  hermes: buildHermesProviderEnv,
  opencode: buildOpenCodeProviderEnv,
  pi: buildPiProviderEnv,
  kimi: buildKimiProviderEnv,
};

export function buildProviderEnvForKernel(
  kernelId: BridgeKernelId,
  profile: ProviderProfile,
): Record<string, string> | undefined {
  const builder = PROVIDER_ENV_BUILDERS[kernelId];
  return builder ? builder(profile) : undefined;
}

export function getKernelContract(kernelId: BridgeKernelId): KernelAdapterContract {
  return KERNEL_CONTRACTS[kernelId]();
}

export function getKernelPathContract(kernelId: BridgeKernelId): KernelPathContract {
  return getKernelContract(kernelId).paths;
}

export function getKernelDisplayContract(kernelId: BridgeKernelId): KernelDisplayContract {
  return getKernelContract(kernelId).display;
}

export function getKernelInputFormatContract(kernelId: BridgeKernelId): KernelInputFormatContract {
  return getKernelContract(kernelId).inputFormats;
}

// ===== Kernel-local Login / Provider discovery dispatch =====

const KERNEL_PROFILE_READERS: Record<
  BridgeKernelId,
  (options: KernelLocalRouteReadOptions) => KernelLocalRouteProfile | undefined
> = {
  "claude-code": (options) => readClaudeCodeLocalRouteProfile(options),
  codex: (options) => readCodexLocalRouteProfile(options.configHome),
  hermes: (options) => readHermesLocalRouteProfile(options.configHome),
  pi: (options) => readPiLocalRouteProfile(options.configHome),
  openclaw: (options) => readOpenClawLocalRouteProfile(options.configHome),
  opencode: (options) => readOpenCodeLocalRouteProfile(options.configHome),
  kimi: (options) => readKimiLocalRouteProfile(options.configHome),
};

export function readKernelLocalRouteProfile(
  kernelId: BridgeKernelId,
  input: string | KernelLocalRouteReadOptions = {},
): KernelLocalRouteProfile | undefined {
  const options = readOptions(input);
  const reader = KERNEL_PROFILE_READERS[kernelId];
  return reader?.(options);
}

export function readKernelLocalBaseUrl(
  kernel: BridgeKernelId,
  input: string | KernelLocalRouteReadOptions = {},
): string {
  return readKernelLocalRouteProfile(kernel, input)?.baseUrl ?? "";
}

export function readKernelLocalAuthToken(
  kernel: BridgeKernelId,
  input: string | KernelLocalRouteReadOptions = {},
): string {
  const profile = readKernelLocalRouteProfile(kernel, input);
  if (!profile) return "";
  return (
    stringValue(profile.env.ANTHROPIC_AUTH_TOKEN) ||
    stringValue(profile.env.ANTHROPIC_API_KEY) ||
    stringValue(profile.env.OPENAI_API_KEY) ||
    stringValue(profile.env.GEMINI_API_KEY) ||
    ""
  );
}

export function readKernelLocalConfiguredModel(
  kernel: BridgeKernelId,
  input: string | KernelLocalRouteReadOptions = {},
): string | undefined {
  return readKernelLocalRouteProfile(kernel, input)?.defaultModel;
}

// ===== Kernel account Login route availability =====

export function isKernelLoginRouteAvailable(loginProfile: KernelLocalRouteProfile | undefined): boolean {
  if (loginProfile?.routeKind === "login" && loginProfile.authConfigured) return true;
  return false;
}

// ===== Runtime controls dispatch (from kernel-runtime-controls.ts) =====

// kernelConfigHome inlined here to avoid circular import with kernel-utils.ts
function kernelConfigHomeForRegistry(
  settings: { kernelPathOverrides?: Record<string, { configHome?: string }> },
  kernel: BridgeKernelId,
): string {
  const override = settings.kernelPathOverrides?.[kernel]?.configHome?.trim();
  return override || resolve(homedir(), getKernelPathContract(kernel).defaultConfigHome);
}

type KernelControlsBuilder = (
  state: BridgeState,
  kernel: BridgeKernelId,
  providerModels: BridgeRuntimeControlOption[],
  provider: BridgeProviderProfile | undefined,
) => BridgeRuntimeControls;

const KERNEL_CONTROLS_BUILDERS: Partial<Record<BridgeKernelId, KernelControlsBuilder>> = {
  codex: (state, _kernel, providerModels, provider) =>
    mergeProviderRuntimeControlsInternal(
      buildCodexRuntimeControls(kernelConfigHomeForRegistry(state.settings, "codex")),
      providerModels,
      provider,
    ),
  "claude-code": (state, _kernel, providerModels, provider) => {
    const cfgHome = kernelConfigHomeForRegistry(state.settings, "claude-code");
    const profile = readKernelLocalRouteProfile("claude-code", {
      cwd: resolveBridgeWorkspaceRoot(state.settings),
      configHome: cfgHome,
    });
    return providerModels.length
      ? mergeProviderRuntimeControlsInternal(buildClaudeCodeRuntimeControls(cfgHome, profile), providerModels, provider)
      : buildClaudeCodeRuntimeControls(cfgHome, profile);
  },
  hermes: (_state, _kernel, providerModels, provider) =>
    mergeProviderRuntimeControlsInternal(buildHermesRuntimeControls(), providerModels, provider),
};

export function buildRuntimeControlsForKernel(
  state: BridgeState,
  kernel: BridgeKernelId,
  providerModels: BridgeRuntimeControlOption[],
  provider: BridgeProviderProfile | undefined,
): BridgeRuntimeControls {
  const builder = KERNEL_CONTROLS_BUILDERS[kernel];
  return builder
    ? builder(state, kernel, providerModels, provider)
    : buildExternalRuntimeControlsInternal(kernel, providerModels, provider?.id);
}

export function buildExternalRuntimeControls(
  kernel: BridgeKernelId,
  providerModels: BridgeRuntimeControlOption[],
  providerId: string | undefined,
): BridgeRuntimeControls {
  return buildExternalRuntimeControlsInternal(kernel, providerModels, providerId);
}

function buildExternalRuntimeControlsInternal(
  kernel: BridgeKernelId,
  providerModels: BridgeRuntimeControlOption[],
  providerId: string | undefined,
): BridgeRuntimeControls {
  const supportsReasoning = getBridgeKernelDescriptor(kernel).externalControls.reasoning;
  return {
    kernel,
    source: providerId ? `provider:${providerId}` : "external-cli",
    models: providerModels.length ? providerModels : [{ id: `${kernel}-default`, label: "Default" }],
    defaultModel: providerModels[0]?.id,
    reasoningEfforts: supportsReasoning
      ? ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }))
      : [],
    defaultReasoningEffort: supportsReasoning ? "medium" : undefined,
    speedTiers: [],
  };
}

export function mergeProviderRuntimeControls(
  controls: BridgeRuntimeControls,
  providerModels: BridgeRuntimeControlOption[],
  provider: BridgeProviderProfile | undefined,
): BridgeRuntimeControls {
  return mergeProviderRuntimeControlsInternal(controls, providerModels, provider);
}

function mergeProviderRuntimeControlsInternal(
  controls: BridgeRuntimeControls,
  providerModels: BridgeRuntimeControlOption[],
  provider: BridgeProviderProfile | undefined,
): BridgeRuntimeControls {
  if (!providerModels.length) return controls;
  const plan = planProviderBinding(controls.kernel, provider);
  const descriptor = getBridgeKernelDescriptor(controls.kernel);
  const preserveReasoning = plan.preserveNativeControls
    ? descriptor.nativeControls.reasoning
    : descriptor.externalControls.reasoning;
  const preserveSpeed = plan.preserveNativeControls
    ? descriptor.nativeControls.speed
    : descriptor.externalControls.speed;
  return {
    ...controls,
    source: provider ? `provider:${provider.id}` : controls.source,
    models: providerModels,
    defaultModel: providerModels[0]?.id ?? controls.defaultModel,
    reasoningEfforts: preserveReasoning ? controls.reasoningEfforts : [],
    defaultReasoningEffort: preserveReasoning ? controls.defaultReasoningEffort : undefined,
    speedTiers: preserveSpeed ? controls.speedTiers : [],
    defaultSpeedTier: preserveSpeed ? controls.defaultSpeedTier : undefined,
  };
}

// ===== Kernel model routing =====

export type KernelModelAliasMap = Record<string, string>;

export function kernelModelAliasesForProvider(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
): KernelModelAliasMap {
  if (usesKernelManagedProviderConfig(kernelId, profile)) return {};
  if (!profile) return {};

  const contract = getKernelContract(kernelId);
  if (contract.inputFormats.modelAliasStrategy === "family-alias") {
    return Object.fromEntries(
      profile.models
        .flatMap((model) =>
          [model.id, model.apiModelId, model.canonicalModelId]
            .filter((id): id is string => Boolean(id?.trim()))
            .map((id) => [id, claudeCodeFamilyAliasForProviderModel(model)] as const),
        )
        .filter(([id]) => Boolean(id.trim())),
    );
  }

  return {};
}

export function kernelModelForProviderSelection(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
  selectedModel: string | undefined,
): string | undefined {
  const model = selectedModel?.trim();
  if (!model) return undefined;
  const providerModel = providerModelForSelection(profile, model);
  const routeModel = providerModel?.apiModelId || providerModel?.id || model;
  const alias = resolveKernelModelAlias(routeModel, kernelModelAliasesForProvider(kernelId, profile));
  if (alias) return alias;
  const contract = getKernelContract(kernelId);
  if (
    contract.inputFormats.modelAliasStrategy === "provider-qualified" &&
    profile &&
    opencodeSupportsProvider(profile) &&
    !usesKernelManagedProviderConfig(kernelId, profile)
  ) {
    return opencodeModelIdForProvider(profile.id, routeModel);
  }
  return routeModel;
}

function resolveKernelModelAlias(model: string, aliases: KernelModelAliasMap): string | undefined {
  const direct = aliases[model];
  if (direct) return direct;
  const normalized = model.toLowerCase();
  return Object.entries(aliases).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function claudeCodeFamilyAliasForProviderModel(model: BridgeRuntimeControlOption): "opus" | "sonnet" | "haiku" {
  const text = `${model.family ?? ""} ${model.id} ${model.label} ${model.description ?? ""}`.toLowerCase();
  if (text.includes("haiku")) return "haiku";
  if (text.includes("sonnet")) return "sonnet";
  if (text.includes("opus")) return "opus";
  return "opus";
}

// ===== Kernel display normalization =====

export function normalizeModelForKernelDisplay(kernel: string, model: string): string {
  const value = String(model || "").trim();
  if (!(BRIDGE_KERNEL_IDS as readonly string[]).includes(kernel)) return value || DEFAULT_BRIDGE_MODEL_ID;
  const display = getKernelDisplayContract(kernel as BridgeKernelId);
  if (!value || display.modelDisplayAliases.includes(value)) {
    return display.defaultModelId;
  }
  if (display.modelDisplaySuffixAlias && value.endsWith(display.modelDisplaySuffixAlias)) {
    return display.defaultModelId;
  }
  return value || DEFAULT_BRIDGE_MODEL_ID;
}

// ===== Discovery dispatch =====

export interface DiscoverKernelOptions {
  command?: string;
  cwd: string;
  configHome?: string;
  env?: NodeJS.ProcessEnv;
}

type DiscoverFn = (opts: DiscoverKernelOptions) => KernelDiscovery;

const KERNEL_DISCOVER_TABLE: Record<BridgeKernelId, DiscoverFn> = {
  codex: (opts) => discoverCodexKernel({ command: opts.command, cwd: opts.cwd, env: opts.env }, opts.cwd),
  "claude-code": (opts) =>
    discoverClaudeCodeKernel(
      { ...(opts.command ? { cliPath: opts.command } : {}), cwd: opts.cwd, env: opts.env },
      opts.cwd,
    ),
  hermes: (opts) => discoverHermesKernel({ command: opts.command, cwd: opts.cwd, env: opts.env }, opts.cwd),
  pi: (opts) => discoverPiKernel(opts.command),
  openclaw: (opts) => discoverOpenClawKernel(opts.command, { configHome: opts.configHome, env: opts.env }),
  opencode: (opts) => discoverOpenCodeKernel(opts.command),
  kimi: (opts) => discoverKimiKernel(opts.command),
};

export function discoverKernelById(id: BridgeKernelId, options: DiscoverKernelOptions): KernelDiscovery {
  return KERNEL_DISCOVER_TABLE[id](options);
}

// ===== Kernel adapter factory registry =====

const KERNEL_FACTORIES: Record<BridgeKernelId, (options: KernelCreateOptions) => KernelAdapter> = {
  codex: createCodexKernelAdapterFromOptions,
  "claude-code": createClaudeCodeKernelAdapterFromOptions,
  hermes: createHermesKernelAdapterFromOptions,
  pi: createPiKernelAdapterFromOptions,
  openclaw: createOpenClawGatewayKernelAdapterFromOptions,
  opencode: createOpenCodeKernelAdapterFromOptions,
  kimi: createKimiKernelAdapterFromOptions,
};

export function createKernelAdapter(id: BridgeKernelId, options: KernelCreateOptions): KernelAdapter {
  return KERNEL_FACTORIES[id](options);
}
