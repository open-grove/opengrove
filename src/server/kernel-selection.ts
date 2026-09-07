import type { JsonObject } from "../core.js";
import type { KernelOptionUnavailableCode } from "#agent-protocol";
import type { SupportedLocale } from "../localization/locale-registry.js";
import { readAppEnv } from "../identity.js";
import { resolveCommandPath, resolveUsableCommandPath } from "../kernel/discovery.js";
import { canResolvePiRuntimeModel, resolvePiCommand } from "../kernel/adapters/pi.js";
import { resolveKimiCommand } from "../kernel/adapters/kimi.js";
import { isOpenClawGatewayConfigured, resolveOpenClawCommand } from "../kernel/adapters/openclaw.js";
import { resolveOpenCodeCommand } from "../kernel/adapters/opencode.js";
import { bridgeKernelSupportsHostTools } from "../kernel/host-tools.js";
import type { KernelAdapter } from "../kernel/types.js";
import { applyKernelProxyEnv, resolveKernelProxySettings } from "../runtime/kernel-proxy.js";
import type { BridgeKernelId, BridgeKernelPreference, BridgeModelId, BridgeState } from "./bridge-types.js";
import { BRIDGE_KERNEL_IDS, DEFAULT_BRIDGE_MODEL_ID, LOGIN_PROVIDER_BINDING_ID } from "./bridge-types.js";
import {
  providerEnvForKernel,
  providerProfileForKernel,
  getAllBridgeProviderProfiles,
  resolveProviderForRoute,
} from "./provider-profiles.js";
import { providerBindingFingerprint } from "./provider-binding.js";
import {
  createKernelAdapter,
  getBridgeKernelDescriptor,
  getKernelContract,
  isKernelLoginRouteAvailable,
  kernelModelForProviderSelection,
  readKernelLocalRouteProfile,
} from "./kernel-registry.js";
import {
  buildBridgeRuntimeControlsForKernel,
  buildKernelDiscoverySnapshot,
  defaultKernelConfigHome,
  kernelBinaryPathOverride,
  kernelConfigHome,
  kernelPathEnv,
  resolveKernelProviderSelection,
  resolveProviderSelectedModelForKernel,
  stripUndefined,
} from "./kernel-utils.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";
import { bridgeDataPath } from "./storage-paths.js";
import { resolveClaudeCodeCliPath } from "../runtime/claude-code-runtime.js";
import { resolveCodexCommandPath } from "../runtime/codex-runtime.js";
import { resolveHermesCommandPath } from "../runtime/hermes-runtime.js";
import { hostMessage } from "../localization/host-messages.js";
import { resolveHostLanguageSettings } from "./language-preference.js";

export { isEnabledEnvFlag } from "./env-flags.js";
export {
  resolveKernelRuntimeModel,
  resolveProviderSelectedModelForKernel,
} from "./kernel-utils.js";

export class BridgeKernelUnavailableError extends Error {
  constructor(
    message: string,
    readonly code = "bridge_kernel_unavailable",
  ) {
    super(message);
    this.name = "BridgeKernelUnavailableError";
  }
}

interface AdapterAuthoredAvailabilityPolicy {
  runtimeUnavailableCode: KernelOptionUnavailableCode;
  isAvailable: (state: BridgeState) => boolean;
}

const ADAPTER_AUTHORED_AVAILABILITY = {
  openclaw: {
    runtimeUnavailableCode: "kernel_runtime_unavailable",
    isAvailable: (state: BridgeState) =>
      isOpenClawGatewayConfigured({
        configHome: kernelConfigHome(state.settings, "openclaw"),
        env: { ...process.env, ...kernelPathEnv(state.settings, "openclaw") },
      }),
  },
} satisfies Partial<Record<BridgeKernelId, AdapterAuthoredAvailabilityPolicy>>;

type AdapterAuthoredAvailabilityKernelId = keyof typeof ADAPTER_AUTHORED_AVAILABILITY;
type HostAuthoredAvailabilityKernelId = Exclude<BridgeKernelId, AdapterAuthoredAvailabilityKernelId>;

function hasAdapterAuthoredAvailability(id: BridgeKernelId): id is AdapterAuthoredAvailabilityKernelId {
  return id in ADAPTER_AUTHORED_AVAILABILITY;
}

export function createBridgeKernel(state: BridgeState): KernelAdapter {
  const kernel = state.runtimeOverride?.kernel ?? state.settings.kernel;
  const providerSelection = resolveKernelProviderSelection(state, kernel);
  if (providerSelection.route.binding.kind === "unresolved") {
    throw kernelRouteUnavailableError(state, kernel);
  }
  if (providerSelection.route.binding.kind === "provider" && providerSelection.route.binding.status !== "ready") {
    throw kernelRouteUnavailableError(state, kernel);
  }
  if (providerSelection.route.binding.kind === "login" && !providerSelection.providerAvailable) {
    throw kernelRouteUnavailableError(state, kernel);
  }
  resolveBridgeKernel(kernel, state);
  const workspaceRoot = resolveBridgeWorkspaceRoot(state.settings);
  const provider =
    providerSelection.route.binding.kind === "provider" && providerSelection.route.binding.status === "ready"
      ? providerSelection.route.binding.profile
      : undefined;
  const selectedModel = resolveProviderSelectedModelForKernel(state, kernel, providerSelection.modelId);
  const kernelSelectedModel = kernelModelForProviderSelection(kernel, provider, selectedModel);
  const providerEnv = resolveKernelEnv(state, kernel, provider, selectedModel);
  const descriptor = getBridgeKernelDescriptor(kernel);
  const runtimeBindingFingerprint = providerBindingFingerprint({
    kernelId: kernel,
    provider,
    providerModel: descriptor.thread.reuseAcrossModelChanges ? undefined : selectedModel,
    kernelModel: descriptor.thread.reuseAcrossModelChanges ? undefined : kernelSelectedModel,
    cwd: workspaceRoot,
  });
  const providerProfile = providerProfileForKernel(kernel, provider, kernelSelectedModel);
  const command = resolveKernelCommandPath(state, kernel);
  const runtimeEnv = providerScopedRuntimeEnv(state, kernel, provider, providerEnv);
  try {
    const adapter = createKernelAdapter(kernel, {
      cwd: workspaceRoot,
      configHome: kernelConfigHome(state.settings, kernel),
      command,
      env: runtimeEnv,
      provider: providerProfile,
      model: kernelSelectedModel,
      runtimeBindingFingerprint,
      dataPath: bridgeDataPath(state),
    });
    state.kernel = kernel;
    state.model = selectedModel;
    state.kernelProviderId = provider?.id ?? LOGIN_PROVIDER_BINDING_ID;
    state.kernelRuntimeModel = kernelSelectedModel;
    return adapter;
  } catch (error) {
    throw new BridgeKernelUnavailableError(
      error instanceof Error ? error.message : String(error),
      "kernel_adapter_creation_failed",
    );
  }
}

function kernelRouteUnavailableError(state: BridgeState, kernel: BridgeKernelId): BridgeKernelUnavailableError {
  const kernelTitle = getKernelContract(kernel).labels.title;
  return new BridgeKernelUnavailableError(
    hostMessage(resolveHostLanguageSettings(state.settings), "kernel.route_unavailable", {
      kernel: kernelTitle,
      reason: unavailableReasonForState(kernel, state),
    }),
    unavailableCodeForState(kernel, state),
  );
}

export function providerScopedRuntimeEnv(
  state: BridgeState,
  kernel: BridgeKernelId,
  selectedProvider: ReturnType<typeof resolveProviderForRoute>,
  selectedProviderEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const retainedEnvKeys = new Set(Object.keys(selectedProviderEnv ?? {}));
  if (selectedProvider?.apiKeyEnv) retainedEnvKeys.add(selectedProvider.apiKeyEnv);
  if (!selectedProvider) {
    const localRouteProfile = readKernelLocalRouteProfile(kernel, localRouteProfileOptions(state, kernel));
    for (const key of Object.keys(localRouteProfile?.env ?? {})) retainedEnvKeys.add(key);
    if (localRouteProfile?.apiKeyEnv) retainedEnvKeys.add(localRouteProfile.apiKeyEnv);
  }
  for (const profile of getAllBridgeProviderProfiles(state.settings.customProviders)) {
    if (selectedProvider?.id === profile.id) continue;
    if (profile.apiKeyEnv && !retainedEnvKeys.has(profile.apiKeyEnv)) env[profile.apiKeyEnv] = undefined;
    const candidateEnv = providerEnvForKernel(kernel, profile, profile.models[0]?.id);
    for (const key of Object.keys(candidateEnv ?? {})) {
      if (!retainedEnvKeys.has(key)) env[key] = undefined;
    }
  }
  return { ...env, ...(selectedProviderEnv ?? {}) };
}

export function getBridgeKernelOptions(state: BridgeState): JsonObject[] {
  const options: JsonObject[] = [];

  for (const id of BRIDGE_KERNEL_IDS) {
    const contract = getKernelContract(id);
    const providerSelection = resolveKernelProviderSelection(state, id);
    const binding = providerSelection.route.binding;
    const adapterAvailability = hasAdapterAuthoredAvailability(id) ? ADAPTER_AUTHORED_AVAILABILITY[id] : undefined;
    const adapterDiscovery = adapterAvailability ? buildKernelDiscoverySnapshot(id, state) : undefined;
    const routeAvailable =
      binding.kind === "login"
        ? providerSelection.providerAvailable
        : binding.kind === "provider" && binding.status === "ready";
    const available = adapterDiscovery
      ? adapterDiscovery.available && routeAvailable
      : isBridgeKernelAvailable(state, id);
    const discovery = adapterDiscovery
      ? { ...adapterDiscovery, available }
      : buildKernelDiscoverySnapshot(id, state, available);
    const loginProfile = providerSelection.localRouteProfile;
    const providerAvailable =
      binding.kind === "login" && adapterDiscovery
        ? Boolean(loginProfile?.authConfigured) || adapterDiscovery.available
        : providerSelection.providerAvailable;
    const unavailableReason = available
      ? ""
      : adapterAvailability && routeAvailable
        ? discovery.health?.message || unavailableReasonForState(id, state, "en")
        : unavailableReasonForState(id, state, "en");
    const unavailableCode = available
      ? undefined
      : adapterAvailability && routeAvailable
        ? adapterAvailability.runtimeUnavailableCode
        : unavailableCodeForState(id, state);
    options.push(
      stripUndefined({
        id,
        label: contract.labels.title,
        description: integrationModeDescription(contract.labels.integrationMode),
        integrationKind: contract.labels.integrationMode,
        hostTools: bridgeKernelSupportsHostTools(id),
        available,
        active: state.settings.kernel === id,
        reason: unavailableReason,
        unavailableCode,
        installed: discovery.installed,
        binaryPath: discovery.binaryPath,
        version: discovery.version,
        executableProbe: discovery.executableProbe,
        configHome: discovery.configHome,
        bindingKind: binding.kind,
        bindingStatus:
          binding.kind === "provider"
            ? binding.status
            : binding.kind === "unresolved"
              ? binding.status
              : providerAvailable
                ? "ready"
                : "missing-provider",
        providerAvailable,
        providerId:
          binding.kind === "provider" ? binding.providerId : providerAvailable ? loginProfile?.providerId : undefined,
        providerLabel:
          binding.kind === "provider"
            ? (binding.profile?.name ?? binding.providerId)
            : providerAvailable
              ? loginProfile?.providerLabel
              : undefined,
        capabilityReport: discovery.capabilityReport,
        installActions: discovery.installActions ?? [],
        diagnostics: discovery.diagnostics ?? {},
      }) as JsonObject,
    );
  }

  return options;
}

function integrationModeDescription(mode: string): string {
  const descriptions: Record<string, string> = {
    sdk: "SDK",
    cli: "CLI",
    acp: "ACP",
    gateway: "Gateway",
    "structured-cli": "Structured CLI",
    http: "HTTP",
    runtime: "Runtime",
  };
  return descriptions[mode] ?? mode;
}

export function getBridgeRuntimeControls(state: BridgeState): JsonObject {
  const active = state.settings.kernel;
  const controls = getBridgeRuntimeControlsForKernel(state, active);
  if (state.kernelUnavailableReason) {
    return stripUndefined({
      ...controls,
      unavailableReason: state.kernelUnavailableReason,
    }) as JsonObject;
  }
  return controls;
}

export function getBridgeRuntimeControlsByKernel(state: BridgeState): JsonObject {
  const controlsByKernel: Record<string, JsonObject> = {};
  for (const id of BRIDGE_KERNEL_IDS) {
    controlsByKernel[id] = getBridgeRuntimeControlsForKernel(state, id);
  }
  return controlsByKernel as JsonObject;
}

export function getBridgeRuntimeControlsForKernel(state: BridgeState, kernel: BridgeKernelId): JsonObject {
  return buildBridgeRuntimeControlsForKernel(state, kernel);
}

function resolveKernelEnv(
  state: BridgeState,
  kernel: BridgeKernelId,
  provider: ReturnType<typeof resolveProviderForRoute>,
  selectedModel: string | undefined,
): NodeJS.ProcessEnv | undefined {
  const providerEnv = {
    ...kernelPathEnv(state.settings, kernel),
    ...(providerEnvForKernel(kernel, provider, selectedModel) ?? {}),
  };
  const env = applyKernelProxyEnv(providerEnv, resolveKernelProxySettings(state.settings.kernelProxy, process.env));
  return Object.keys(env).length ? env : undefined;
}

export function resolveBridgeKernel(preferred: BridgeKernelPreference, state: BridgeState): BridgeKernelId {
  if (!isBridgeKernelAvailable(state, preferred)) {
    const language = resolveHostLanguageSettings(state.settings);
    throw new BridgeKernelUnavailableError(
      hostMessage(language, "kernel.route_unavailable", {
        kernel: getKernelContract(preferred).labels.title,
        reason: unavailableReasonForState(preferred, state, language),
      }),
      unavailableCodeForState(preferred, state),
    );
  }
  return preferred;
}

export function isBridgeKernelAvailable(state: BridgeState, id: BridgeKernelId): boolean {
  if (hasAdapterAuthoredAvailability(id)) {
    const adapterAvailability = ADAPTER_AUTHORED_AVAILABILITY[id];
    const binding = resolveStateProviderRoute(state, id).binding;
    if (binding.kind === "unresolved") return false;
    if (binding.kind === "provider" && binding.status !== "ready") return false;
    return adapterAvailability.isAvailable(state);
  }
  if (!hasAvailableProviderRoute(id, state)) return false;
  return KERNEL_AVAILABILITY_CHECKS[id](state);
}

const KERNEL_AVAILABILITY_CHECKS: Record<HostAuthoredAvailabilityKernelId, (state: BridgeState) => boolean> = {
  codex: canUseCodexKernel,
  "claude-code": canUseClaudeKernel,
  hermes: canUseHermesKernel,
  pi: canUsePiKernel,
  opencode: (state) => Boolean(resolveKernelCommandPath(state, "opencode")),
  kimi: (state) => Boolean(resolveKernelCommandPath(state, "kimi")),
};

function hasAvailableProviderRoute(id: BridgeKernelId, state?: BridgeState): boolean {
  if (state) return resolveKernelProviderSelection(state, id).providerAvailable;
  const localRouteProfile = readKernelLocalRouteProfile(id, localRouteProfileOptions(state, id));
  return isKernelLoginRouteAvailable(localRouteProfile);
}

function unavailableReasonForState(id: BridgeKernelId, state?: BridgeState, locale?: SupportedLocale): string {
  const messageLocale = locale ?? (state?.settings ? resolveHostLanguageSettings(state.settings) : "en");
  const stateRoute = state?.settings ? resolveStateProviderRoute(state, id) : undefined;
  if (state?.settings && stateRoute?.binding.kind === "unresolved") {
    return hostMessage(messageLocale, "kernel.provider_selection_required", {
      model: state.model,
    });
  }
  if (state?.settings && stateRoute?.binding.kind === "login" && !hasAvailableProviderRoute(id, state)) {
    return hostMessage(messageLocale, "kernel.login_unavailable", {
      kernel: getKernelContract(id).labels.title,
    });
  }
  const binding = unavailableExplicitProviderBinding(id, state);
  if (binding) {
    const label = binding.profile?.name || binding.providerId;
    if (binding.status === "verification-required") {
      return "Provider credential verification is pending or requires attention. Check its status in Settings.";
    }
    if (binding.status === "missing-key" && binding.providerId === "ww") {
      return "The WW provider key is not ready. Sign in again later to retry, or choose another provider in Settings.";
    }
    if (binding.status === "missing-key") {
      return `The selected ${label} provider is missing valid credentials. Add a key or choose another provider.`;
    }
    if (binding.status === "disabled") {
      return `The selected ${label} provider is disabled. Enable it or choose another provider.`;
    }
    if (binding.status === "unsupported") {
      return `The selected ${label} provider does not support ${getKernelContract(id).labels.title}. Choose a compatible provider.`;
    }
    return `The selected ${label} provider configuration no longer exists. Choose a provider again.`;
  }
  if (id === "claude-code" && resolveKernelCommandPath(state, "claude-code")) {
    return "Claude Agent has no usable credentials. Sign in to WW or configure Anthropic/Claude.";
  }
  if (resolveKernelCommandPath(state, id) && !hasAvailableProviderRoute(id, state)) {
    return `${getKernelContract(id).labels.title} has no available provider configured.`;
  }
  const contract = getKernelContract(id);
  return (
    contract.labels.unavailableReason ??
    hostMessage(messageLocale, "kernel.runtime_unavailable", {
      kernel: contract.labels.title,
    })
  );
}

function unavailableCodeForState(id: BridgeKernelId, state?: BridgeState): KernelOptionUnavailableCode {
  const binding = unavailableExplicitProviderBinding(id, state);
  if (binding?.status === "verification-required") return "provider_verification_required";
  if (binding?.status === "missing-key" && binding.providerId === "ww") return "ww_provider_key_missing";
  if (binding?.status === "missing-key") return "provider_key_missing";
  if (binding?.status === "disabled") return "provider_disabled";
  if (binding?.status === "unsupported") return "provider_unsupported";
  if (binding) return "provider_not_found";
  if (state?.settings && resolveStateProviderRoute(state, id).binding.kind === "unresolved") {
    return "provider_selection_required";
  }
  if (resolveKernelCommandPath(state, id) && !hasAvailableProviderRoute(id, state)) {
    return "kernel_provider_unavailable";
  }
  return "kernel_executable_missing";
}

function unavailableExplicitProviderBinding(id: BridgeKernelId, state?: BridgeState) {
  if (!state?.settings) return undefined;
  const binding = resolveStateProviderRoute(state, id).binding;
  return binding.kind === "provider" && binding.status !== "ready" ? binding : undefined;
}

function canUseClaudeKernel(state?: BridgeState) {
  if (!resolveKernelCommandPath(state, "claude-code")) {
    return false;
  }
  const providerSelection = state ? resolveKernelProviderSelection(state, "claude-code") : undefined;
  const provider =
    providerSelection?.route.binding.kind === "provider" && providerSelection.route.binding.status === "ready"
      ? providerSelection.route.binding.profile
      : undefined;
  const providerEnv = state
    ? providerEnvForKernel(
        "claude-code",
        provider,
        resolveProviderSelectedModelForKernel(state, "claude-code", providerSelection?.modelId),
      )
    : undefined;
  if (hasClaudeRuntimeAuthEnv(providerEnv)) {
    return true;
  }
  const providerRoute = state ? resolveStateProviderRoute(state, "claude-code") : undefined;
  if (providerRoute?.binding.kind === "provider") {
    return false;
  }
  const profile = readKernelLocalRouteProfile("claude-code", localRouteProfileOptions(state, "claude-code"));
  if (profile?.baseUrl && profile.authConfigured) {
    return true;
  }
  return Boolean(
    readAppEnv("ANTHROPIC_API_KEY")?.trim() || readAppEnv("ANTHROPIC_AUTH_TOKEN")?.trim() || profile?.authConfigured,
  );
}

function hasClaudeRuntimeAuthEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(
    env?.ANTHROPIC_AUTH_TOKEN?.trim() ||
      env?.ANTHROPIC_API_KEY?.trim() ||
      env?.AWS_BEARER_TOKEN_BEDROCK?.trim() ||
      env?.CLAUDE_CODE_USE_BEDROCK?.trim() ||
      env?.CLAUDE_CODE_USE_VERTEX?.trim(),
  );
}

function canUseCodexKernel(state?: BridgeState) {
  return Boolean(resolveKernelCommandPath(state, "codex"));
}

function canUseHermesKernel(state?: BridgeState) {
  return Boolean(resolveKernelCommandPath(state, "hermes"));
}

function canUsePiKernel(state?: BridgeState) {
  const providerSelection = state ? resolveKernelProviderSelection(state, "pi") : undefined;
  const provider =
    providerSelection?.route.binding.kind === "provider" && providerSelection.route.binding.status === "ready"
      ? providerSelection.route.binding.profile
      : undefined;
  const selectedModel = state
    ? resolveProviderSelectedModelForKernel(state, "pi", providerSelection?.modelId)
    : undefined;
  const env = state
    ? { ...process.env, ...(resolveKernelEnv(state, "pi", provider, selectedModel) ?? {}) }
    : process.env;
  return canResolvePiRuntimeModel(env);
}

function resolveStateProviderRoute(state: BridgeState, kernel: BridgeKernelId) {
  return resolveKernelProviderSelection(state, kernel).route;
}

export function normalizeBridgeKernelPreference(
  value: unknown,
  fallback: BridgeKernelPreference,
): BridgeKernelPreference {
  if (typeof value === "string" && (BRIDGE_KERNEL_IDS as readonly string[]).includes(value)) {
    return value as BridgeKernelPreference;
  }
  return fallback;
}

export function defaultBridgeKernelPreference(): BridgeKernelPreference {
  return "claude-code";
}

export function defaultBridgeModelId(): BridgeModelId {
  return DEFAULT_BRIDGE_MODEL_ID;
}

// ===== Kernel command resolution (moved from kernel-command-resolution.ts) =====

export function resolveKernelCommandPath(state: BridgeState | undefined, id: BridgeKernelId): string | undefined {
  const override = state ? kernelBinaryPathOverride(state.settings, id) : undefined;
  if (override) {
    return KERNELS_REQUIRING_EXECUTABLE.has(id) ? resolveUsableCommandPath(override) : resolveCommandPath(override);
  }
  return KERNEL_COMMAND_RESOLVERS[id](state);
}

const KERNELS_REQUIRING_EXECUTABLE = new Set<BridgeKernelId>(["codex", "claude-code", "hermes", "opencode", "kimi"]);

const KERNEL_COMMAND_RESOLVERS: Record<BridgeKernelId, (state: BridgeState | undefined) => string | undefined> = {
  codex: () => resolveUsableCommandPath(resolveCodexCommandPath()),
  "claude-code": (state) =>
    resolveUsableCommandPath(
      resolveClaudeCodeCliPath(state ? resolveBridgeWorkspaceRoot(state.settings) : process.cwd()),
    ),
  hermes: () => resolveHermesCommandPath(),
  opencode: () => resolveOpenCodeCommand(),
  kimi: () => resolveKimiCommand(),
  pi: () => resolvePiCommand(),
  openclaw: () => resolveOpenClawCommand(),
};

export function localRouteProfileOptions(
  state: BridgeState | undefined,
  id: BridgeKernelId,
): { cwd: string; configHome: string; binaryPath?: string } {
  return {
    cwd: state ? resolveBridgeWorkspaceRoot(state.settings) : process.cwd(),
    configHome: kernelConfigHomeFromState(state, id),
    binaryPath: resolveKernelCommandPath(state, id),
  };
}

export function kernelConfigHomeFromState(state: BridgeState | undefined, id: BridgeKernelId): string {
  return state ? kernelConfigHome(state.settings, id) : defaultKernelConfigHome(id);
}
