import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonObject } from "../core.js";
import { toSafeJsonValue } from "../core/safe-json.js";
import type { KernelLocalRouteProfile } from "../kernel/adapters/profile-utils.js";
import type { KernelDiscovery } from "../kernel/types.js";
import { buildKnownKernelCapabilityReport } from "../kernel/capabilities/report-for-kernel.js";
import { normalizeClaudeRuntimeModelId } from "../runtime/claude-model-normalize.js";
import type {
  BridgeKernelId,
  BridgeKernelPathOverride,
  BridgeRuntimeOverride,
  BridgeRuntimeControls,
  BridgeSettings,
  BridgeState,
} from "./bridge-types.js";
import { DEFAULT_BRIDGE_MODEL_ID } from "./bridge-types.js";
import {
  buildRuntimeControlsForKernel,
  discoverKernelById,
  getKernelContract,
  getKernelPathContract,
  isKernelLoginRouteAvailable,
  kernelModelAliasesForProvider,
  kernelModelForProviderSelection,
  readKernelLocalRouteProfile,
} from "./kernel-registry.js";
import {
  providerModelsForKernel,
  resolveProviderForRoute,
  resolveProviderRoute,
  type BridgeResolvedProviderRoute,
} from "./provider-profiles.js";
import { providerModelForSelection } from "./models-dev-catalog.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";

// ===== Selection utilities (from kernel-selection-utils.ts) =====

export function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return toSafeJsonValue(input, {
    omitUndefinedProperties: true,
  }) as Record<string, unknown>;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Re-export from profile-utils (leaf module, safe for adapter consumers)
export { numberValue } from "../kernel/adapters/profile-utils.js";

// ===== Path utilities (from kernel-paths.ts) =====

export function normalizeKernelPathOverrides(
  input: unknown,
  fallback: Record<string, BridgeKernelPathOverride> = {},
): Record<string, BridgeKernelPathOverride> {
  if (input === undefined || input === null) {
    return cloneKernelPathOverrides(fallback);
  }
  const source = record(input);
  const output: Record<string, BridgeKernelPathOverride> = {};
  for (const [kernelId, value] of Object.entries(source)) {
    const item = record(value);
    const override: BridgeKernelPathOverride = {};
    const binaryPath = pathString(item.binaryPath);
    const configHome = pathString(item.configHome);
    if (binaryPath) override.binaryPath = binaryPath;
    if (configHome) override.configHome = configHome;
    if (Object.keys(override).length) {
      output[kernelId] = override;
    }
  }
  return output;
}

export function kernelPathOverride(
  settings: Pick<BridgeSettings, "kernelPathOverrides">,
  kernel: BridgeKernelId,
): BridgeKernelPathOverride {
  return settings.kernelPathOverrides?.[kernel] ?? {};
}

export function kernelBinaryPathOverride(
  settings: Pick<BridgeSettings, "kernelPathOverrides">,
  kernel: BridgeKernelId,
): string | undefined {
  const path = kernelPathOverride(settings, kernel).binaryPath?.trim();
  return path || undefined;
}

export function kernelConfigHome(
  settings: Pick<BridgeSettings, "kernelPathOverrides">,
  kernel: BridgeKernelId,
): string {
  return kernelPathOverride(settings, kernel).configHome?.trim() || defaultKernelConfigHome(kernel);
}

export function kernelPathEnv(
  settings: Pick<BridgeSettings, "kernelPathOverrides">,
  kernel: BridgeKernelId,
): NodeJS.ProcessEnv {
  const configHomeValue = kernelPathOverride(settings, kernel).configHome?.trim();
  if (!configHomeValue) return {};
  const envVar = getKernelPathContract(kernel).configHomeEnvVar;
  if (!envVar) return {};
  return { [envVar]: configHomeValue };
}

export function defaultKernelConfigHome(kernel: BridgeKernelId): string {
  return resolve(homedir(), getKernelPathContract(kernel).defaultConfigHome);
}

export function isExecutablePath(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const stats = statSync(resolve(value.trim()));
    return stats.isFile();
  } catch {
    return false;
  }
}

export function existingPath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const path = resolve(value.trim());
  return existsSync(path) ? path : undefined;
}

function cloneKernelPathOverrides(
  value: Record<string, BridgeKernelPathOverride>,
): Record<string, BridgeKernelPathOverride> {
  return Object.fromEntries(Object.entries(value).map(([kernelId, override]) => [kernelId, { ...override }]));
}

function pathString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ===== Runtime controls shared logic (from kernel-runtime-controls.ts) =====

function runtimeOverrideForKernel(state: BridgeState, kernel: BridgeKernelId): BridgeRuntimeOverride | undefined {
  return state.runtimeOverride?.kernel === kernel ? state.runtimeOverride : undefined;
}

export function resolveProviderSelectedModelForKernel(
  state: BridgeState,
  kernel: BridgeKernelId,
  requestedModel?: string,
): string {
  const runtimeOverride = runtimeOverrideForKernel(state, kernel);
  const provider = resolveProviderForRoute(
    kernel,
    requestedModel ?? runtimeOverride?.model ?? state.model,
    runtimeOverride?.providerOverride?.providerId,
    state.settings.modelProviderBindings,
    state.settings.customProviders,
  );
  const providerModelOptions = providerModelsForKernel(kernel, provider);
  const requested = requestedModel?.trim();
  if (providerModelOptions.length) {
    if (requested && providerModelForSelection(provider, requested)) {
      return requested;
    }
    if (providerModelForSelection(provider, state.model)) {
      return state.model;
    }
    return providerModelOptions[0]?.id ?? requested ?? state.model ?? DEFAULT_BRIDGE_MODEL_ID;
  }
  return requested || state.model || DEFAULT_BRIDGE_MODEL_ID;
}

export function resolveKernelRuntimeModel(state: BridgeState, kernel: BridgeKernelId, requestedModel?: string): string {
  const runtimeOverride = runtimeOverrideForKernel(state, kernel);
  const provider = resolveProviderForRoute(
    kernel,
    requestedModel ?? runtimeOverride?.model ?? state.model,
    runtimeOverride?.providerOverride?.providerId,
    state.settings.modelProviderBindings,
    state.settings.customProviders,
  );
  const aliases = kernelModelAliasesForProvider(kernel, provider);
  const contract = getKernelContract(kernel);
  const concreteClaudeModel =
    !provider && contract.inputFormats.nativeModelNormalization
      ? normalizeClaudeRuntimeModelId(requestedModel, aliases)
      : undefined;
  if (concreteClaudeModel) {
    return concreteClaudeModel;
  }
  if (!provider) {
    const nativeModel = readKernelLocalRouteProfile(kernel, {
      cwd: resolveBridgeWorkspaceRoot(state.settings),
      configHome: kernelConfigHome(state.settings, kernel),
    })?.defaultModel;
    if (nativeModel) {
      return nativeModel;
    }
  }
  const selectedModel = resolveProviderSelectedModelForKernel(state, kernel, requestedModel);
  return kernelModelForProviderSelection(kernel, provider, selectedModel) || selectedModel;
}

export interface KernelProviderSelection {
  modelId: string;
  route: BridgeResolvedProviderRoute;
  localRouteProfile?: KernelLocalRouteProfile;
  providerAvailable: boolean;
}

/**
 * Selects the Provider route used to present or bootstrap one Kernel.
 * The live model belongs to the active Kernel, so other Kernels must resolve
 * against their own defaults and configured model routes.
 */
export function resolveKernelProviderSelection(state: BridgeState, kernel: BridgeKernelId): KernelProviderSelection {
  const runtimeOverride = runtimeOverrideForKernel(state, kernel);
  const localRouteProfile = readKernelLocalRouteProfile(kernel, {
    cwd: resolveBridgeWorkspaceRoot(state.settings),
    configHome: kernelConfigHome(state.settings, kernel),
  });
  const loginAvailable = isKernelLoginRouteAvailable(localRouteProfile);
  const routeForModel = (modelId: string): KernelProviderSelection => {
    const route = resolveProviderRoute(
      kernel,
      modelId,
      runtimeOverride?.providerOverride?.providerId,
      state.settings.modelProviderBindings,
      state.settings.customProviders,
      runtimeOverride?.providerOverride ? "runtime" : "employee",
    );
    return {
      modelId,
      route,
      localRouteProfile: route.binding.kind === "login" ? localRouteProfile : undefined,
      providerAvailable:
        route.binding.kind === "provider"
          ? route.binding.status === "ready"
          : route.binding.kind === "login" && loginAvailable,
    };
  };

  const targetsKernel = Boolean(runtimeOverride) || state.kernel === kernel || state.settings.kernel === kernel;
  const preferredModel = runtimeOverride?.model ?? (targetsKernel ? state.model : `${kernel}-default`);
  const preferred = routeForModel(preferredModel);
  if (targetsKernel) return preferred;
  if (preferred.providerAvailable) return preferred;

  // A non-active Kernel may use an explicit route owned by one of its actual
  // Employees. Never borrow an unrelated model merely because some Provider
  // catalog happens to support this Kernel.
  const candidateModels = new Set<string>();
  const members = state.appInitialized ? state.app.rooms.listMembers() : [];
  for (const member of members) {
    if (member.disabled || member.kernel !== kernel || !member.model?.trim()) continue;
    candidateModels.add(member.model.trim());
  }
  candidateModels.delete(preferredModel);

  for (const modelId of candidateModels) {
    const candidate = routeForModel(modelId);
    if (candidate.providerAvailable) return candidate;
  }
  return preferred;
}

export function resolveBridgeRuntimeControlsForKernel(
  state: BridgeState,
  kernel: BridgeKernelId,
): BridgeRuntimeControls {
  const selection = resolveKernelProviderSelection(state, kernel);
  const binding = selection.route.binding;
  if (!selection.providerAvailable) {
    const controls = buildRuntimeControlsForKernel(state, kernel, [], undefined);
    return {
      ...controls,
      source: "provider-unavailable",
      models: [],
    };
  }
  const provider = binding.kind === "provider" && binding.status === "ready" ? binding.profile : undefined;
  const providerModels = provider?.models ?? selection.localRouteProfile?.models ?? [];
  return buildRuntimeControlsForKernel(state, kernel, providerModels, provider);
}

export function buildBridgeRuntimeControlsForKernel(state: BridgeState, kernel: BridgeKernelId): JsonObject {
  const controls = resolveBridgeRuntimeControlsForKernel(state, kernel);
  return stripUndefined(controls as unknown as Record<string, unknown>) as JsonObject;
}

// ===== Discovery shared logic (from kernel-discovery.ts) =====

export function buildKernelDiscoverySnapshot(
  id: BridgeKernelId,
  state: BridgeState,
  available?: boolean,
): KernelDiscovery {
  const cwd = resolveBridgeWorkspaceRoot(state.settings);
  const discovery = discoverKernelByIdInternal(id, state, cwd, available);
  return withKernelCapabilityReport(id, discovery);
}

function withKernelCapabilityReport(kernel: BridgeKernelId, discovery: KernelDiscovery): KernelDiscovery {
  return {
    ...discovery,
    capabilityReport: discovery.capabilityReport ?? buildKnownKernelCapabilityReport(kernel),
  };
}

function rewriteDiscoveryConfigHome(
  kernel: BridgeKernelId,
  state: BridgeState,
  discovery: KernelDiscovery,
): KernelDiscovery {
  const home = kernelConfigHome(state.settings, kernel);
  const defaultHome = defaultKernelConfigHome(kernel);
  if (!state.settings.kernelPathOverrides[kernel]?.configHome || home === defaultHome) {
    return discovery;
  }
  return {
    ...discovery,
    configHome: home,
    knowledgeSources: discovery.knowledgeSources.map((source) => ({
      ...source,
      path: source.path ? replacePathRoot(source.path, defaultHome, home) : source.path,
    })),
  };
}

function replacePathRoot(path: string, fromRoot: string, toRoot: string): string {
  const normalizedPath = resolve(path);
  const normalizedFrom = resolve(fromRoot);
  if (normalizedPath === normalizedFrom) return toRoot;
  if (normalizedPath.startsWith(`${normalizedFrom}/`)) {
    return resolve(toRoot, normalizedPath.slice(normalizedFrom.length + 1));
  }
  return path;
}

function discoverKernelByIdInternal(
  id: BridgeKernelId,
  state: BridgeState,
  cwd: string,
  available?: boolean,
): KernelDiscovery {
  const discoveryCommand = kernelBinaryPathOverride(state.settings, id);
  const discovery = discoverKernelById(id, {
    command: discoveryCommand || undefined,
    cwd,
    configHome: kernelConfigHome(state.settings, id),
    env: { ...process.env, ...kernelPathEnv(state.settings, id) },
  });
  const withAvailability = available === undefined ? discovery : { ...discovery, available };
  if (KERNELS_WITH_SETTINGS_CONFIG_HOME.has(id)) {
    return rewriteDiscoveryConfigHome(id, state, withAvailability);
  }
  return withAvailability;
}

const KERNELS_WITH_SETTINGS_CONFIG_HOME = new Set<BridgeKernelId>(["pi", "openclaw", "opencode", "kimi"]);
