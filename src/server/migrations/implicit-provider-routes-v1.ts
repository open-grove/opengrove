import type { BridgeKernelId, BridgeModelProviderBinding, BridgeProviderProfile } from "../bridge-types.js";
import { LEGACY_NATIVE_PROVIDER_BINDING_ID, LOGIN_PROVIDER_BINDING_ID } from "../bridge-types.js";
import { isLoginProviderProfile, usesKernelManagedProviderConfig } from "../provider-binding.js";
import { describeProviderRoute, providerCanBindKernel } from "../provider-profiles.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/612
 * Supports: OpenGrove <=0.6.1 installations whose effective Provider route was inferred but never persisted.
 * Remove when: direct upgrades from <=0.6.1 move to the standalone importer.
 */
export const CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION = 1 as const;

export function resolveLegacyNativeEmployeeProviderId(input: {
  kernelId: BridgeKernelId;
  modelId: string;
  employeeProviderId?: string;
  providers: BridgeProviderProfile[];
}): string | undefined {
  if (input.employeeProviderId !== LEGACY_NATIVE_PROVIDER_BINDING_ID) return input.employeeProviderId;
  const routes = input.providers.filter(
    (provider) =>
      provider.origin === "discovered" &&
      provider.sourceKernel === input.kernelId &&
      provider.authConfigured === true &&
      provider.enabled !== false &&
      provider.provisioningBlocked !== true &&
      providerCanBindKernel(input.kernelId, provider) &&
      usesKernelManagedProviderConfig(input.kernelId, provider),
  );
  const matchingModelRoutes = routes.filter((provider) =>
    provider.models.some(
      (model) => model.id === input.modelId || (!input.modelId.includes("/") && model.id.endsWith(`/${input.modelId}`)),
    ),
  );
  const candidates = matchingModelRoutes.length ? matchingModelRoutes : routes;
  const providerIds = new Set(
    candidates.map((provider) =>
      isLoginProviderProfile(input.kernelId, provider) ? LOGIN_PROVIDER_BINDING_ID : provider.id,
    ),
  );
  return providerIds.size === 1 ? [...providerIds][0] : undefined;
}

export function migrateImplicitProviderRoutesToExplicit(input: {
  migrationVersion: number;
  modelBindings: BridgeModelProviderBinding[];
  providers: BridgeProviderProfile[];
  defaultKernelId?: BridgeKernelId;
  targets?: Array<{ kernelId: BridgeKernelId; modelId: string; employeeProviderId?: string }>;
}): {
  migrationVersion: number;
  modelBindings: BridgeModelProviderBinding[];
  versionAdvanced: boolean;
  bindingsChanged: boolean;
} {
  const legacyNativeBindings = input.modelBindings.filter(
    (binding) => binding.providerId === LEGACY_NATIVE_PROVIDER_BINDING_ID,
  );
  if (input.migrationVersion >= CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION && legacyNativeBindings.length === 0) {
    return {
      migrationVersion: input.migrationVersion,
      modelBindings: input.modelBindings.map((binding) => ({ ...binding })),
      versionAdvanced: false,
      bindingsChanged: false,
    };
  }

  const explicitBindings = new Map(
    input.modelBindings
      .filter((binding) => binding.providerId !== LEGACY_NATIVE_PROVIDER_BINDING_ID)
      .map((binding) => [binding.modelId, { ...binding }]),
  );
  const migrated = new Map<string, BridgeModelProviderBinding>();
  let hasUnresolvedLegacyBinding = false;
  for (const binding of input.modelBindings) {
    if (migrated.has(binding.modelId)) continue;
    const explicit = explicitBindings.get(binding.modelId);
    if (explicit) {
      migrated.set(binding.modelId, explicit);
      continue;
    }
    const kernelIds = legacyKernelIdsForStoredBinding(input.targets ?? [], binding.modelId, input.defaultKernelId);
    const providerId = legacyKernelManagedProviderIdForKernels(input.providers, kernelIds);
    migrated.set(binding.modelId, providerId ? { ...binding, providerId } : { ...binding });
    if (!providerId) hasUnresolvedLegacyBinding = true;
  }
  const targetsByModel = legacyTargetsByModel(input.targets ?? []);
  for (const [modelId, targets] of targetsByModel) {
    if (migrated.has(modelId)) continue;
    const providerId = legacyEffectiveProviderIdForTargets(targets, modelId, input.providers);
    if (providerId) {
      migrated.set(modelId, { modelId, providerId });
    }
  }

  const modelBindings = [...migrated.values()];
  const bindingsChanged = !sameModelProviderBindings(modelBindings, input.modelBindings);
  const versionAdvanced =
    input.migrationVersion < CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION && !hasUnresolvedLegacyBinding;

  return {
    migrationVersion: versionAdvanced ? CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION : input.migrationVersion,
    modelBindings,
    versionAdvanced,
    bindingsChanged,
  };
}

function sameModelProviderBindings(left: BridgeModelProviderBinding[], right: BridgeModelProviderBinding[]): boolean {
  if (left.length !== right.length) return false;
  const rightByModel = new Map(right.map((binding) => [binding.modelId, binding.providerId]));
  return (
    rightByModel.size === right.length &&
    left.every((binding) => rightByModel.get(binding.modelId) === binding.providerId)
  );
}

function legacyKernelIdsForStoredBinding(
  targets: Array<{ kernelId: BridgeKernelId; modelId: string }>,
  modelId: string,
  defaultKernelId: BridgeKernelId | undefined,
): BridgeKernelId[] {
  const kernelIds = new Set(
    targets.filter((target) => target.modelId.trim() === modelId).map((target) => target.kernelId),
  );
  if (!kernelIds.size && defaultKernelId) kernelIds.add(defaultKernelId);
  return [...kernelIds];
}

function legacyKernelManagedProviderIdForKernels(
  providers: BridgeProviderProfile[],
  kernelIds: BridgeKernelId[],
): string | undefined {
  if (!kernelIds.length) return undefined;
  const providerIds = kernelIds.map((kernelId) => legacyKernelManagedRoute(providers, kernelId));
  if (providerIds.some((providerId) => !providerId)) return undefined;
  const unique = new Set(providerIds as string[]);
  return unique.size === 1 ? [...unique][0] : undefined;
}

function legacyTargetsByModel(
  targets: Array<{ kernelId: BridgeKernelId; modelId: string; employeeProviderId?: string }>,
): Map<string, BridgeKernelId[]> {
  const output = new Map<string, BridgeKernelId[]>();
  for (const target of targets) {
    const modelId = target.modelId.trim();
    if (!modelId || target.employeeProviderId?.trim()) continue;
    const kernels = output.get(modelId) ?? [];
    if (!kernels.includes(target.kernelId)) kernels.push(target.kernelId);
    output.set(modelId, kernels);
  }
  return output;
}

function legacyEffectiveProviderIdForTargets(
  kernelIds: BridgeKernelId[],
  modelId: string,
  providers: BridgeProviderProfile[],
): string | undefined {
  const resolvedRoutes: string[] = [];
  for (const kernelId of kernelIds) {
    const inferred = legacyInferredProviderSelection(kernelId, modelId, providers);
    if (inferred) {
      if (!inferred.runnable) return undefined;
      resolvedRoutes.push(inferred.providerId);
      continue;
    }
    const fallbackRoute = legacyKernelManagedRoute(providers, kernelId);
    if (!fallbackRoute) return undefined;
    resolvedRoutes.push(fallbackRoute);
  }
  const routes = new Set(resolvedRoutes);
  return routes.size === 1 ? [...routes][0] : undefined;
}

function legacyInferredProviderSelection(
  kernelId: BridgeKernelId,
  modelId: string,
  providers: BridgeProviderProfile[],
): { providerId: string; runnable: boolean } | undefined {
  const matchingProviders = providers.filter(
    (provider) =>
      provider.enabled !== false &&
      provider.provisioningBlocked !== true &&
      provider.models.some((model) => model.id === modelId) &&
      providerCanBindKernel(kernelId, provider),
  );
  if (!matchingProviders.length) return undefined;

  const preferredProviderIds = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.id === modelId && model.defaultProviderId)
        .map((model) => model.defaultProviderId as string),
    ),
  );
  const preferredProviders = matchingProviders.filter((provider) => preferredProviderIds.has(provider.id));
  const routedProviders = preferredProviders.length ? preferredProviders : matchingProviders;
  const candidates = new Set(
    routedProviders.map((provider) =>
      isLoginProviderProfile(kernelId, provider) ? LOGIN_PROVIDER_BINDING_ID : provider.id,
    ),
  );
  if (candidates.size !== 1) return undefined;
  const providerId = [...candidates][0];
  if (!providerId) return undefined;
  const runnable = routedProviders.some(
    (provider) =>
      (isLoginProviderProfile(kernelId, provider) ? LOGIN_PROVIDER_BINDING_ID : provider.id) === providerId &&
      legacyProviderRouteWasRunnable(kernelId, modelId, provider, providers),
  );
  return { providerId, runnable };
}

function legacyProviderRouteWasRunnable(
  kernelId: BridgeKernelId,
  modelId: string,
  provider: BridgeProviderProfile,
  providers: BridgeProviderProfile[],
): boolean {
  if (usesKernelManagedProviderConfig(kernelId, provider)) {
    return provider.origin === "discovered" && provider.sourceKernel === kernelId && provider.authConfigured === true;
  }
  const binding = describeProviderRoute(kernelId, provider.id, providers, modelId);
  return binding.kind === "provider" && binding.status === "ready";
}

function legacyKernelManagedRoute(providers: BridgeProviderProfile[], kernelId: BridgeKernelId): string | undefined {
  const routes = providers
    .filter(
      (provider) =>
        provider.origin === "discovered" &&
        provider.sourceKernel === kernelId &&
        provider.authConfigured === true &&
        provider.enabled !== false &&
        provider.provisioningBlocked !== true &&
        providerCanBindKernel(kernelId, provider) &&
        usesKernelManagedProviderConfig(kernelId, provider),
    )
    .map((provider) => (isLoginProviderProfile(kernelId, provider) ? LOGIN_PROVIDER_BINDING_ID : provider.id));
  return new Set(routes).size === 1 ? routes[0] : undefined;
}
