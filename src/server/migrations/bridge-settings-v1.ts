import type { BridgeKernelId, BridgeModelProviderBinding, BridgeProviderProfile } from "../bridge-types.js";
import {
  BRIDGE_KERNEL_IDS,
  LEGACY_NATIVE_MODEL_ID,
  LEGACY_NATIVE_PROVIDER_BINDING_ID,
  LOGIN_PROVIDER_BINDING_ID,
} from "../bridge-types.js";
import { isLoginProviderProfile } from "../provider-binding.js";
import { providerCanBindKernel } from "../provider-profiles.js";
import { readKernelLocalRouteProfile } from "../kernel-registry.js";
import { providerProfileFromLocalRoute } from "../system-provider-discovery.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 unversioned Bridge settings.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export const CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION = 1 as const;

export interface BridgeSettingsV1SourceMigration {
  source: Record<string, unknown>;
  legacyKernelProviderBindings: Record<string, string>;
  changed: boolean;
}

export function migrateBridgeSettingsSourceToV1(input: Record<string, unknown>): BridgeSettingsV1SourceMigration {
  const source = { ...input };
  let changed = source.settingsSchemaVersion !== CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION;
  // Issue: https://github.com/open-grove/opengrove/issues/602
  // Supports: OpenGrove <=0.6.x settings that persisted the retired automatic Kernel preference.
  // Remove when: schema v2 no longer accepts direct upgrades from settings that can contain `kernel: "auto"`.
  if (source.kernel === "auto") {
    source.kernel = "claude-code";
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(source, "kernelKnowledgeSourceEnabled")) {
    delete source.kernelKnowledgeSourceEnabled;
    changed = true;
  }
  const legacyKernelProviderBindings = normalizeLegacyKernelProviderBindings(source.kernelProviderBindings);
  if (Object.prototype.hasOwnProperty.call(source, "kernelProviderBindings")) {
    delete source.kernelProviderBindings;
    changed = true;
  }

  if (Array.isArray(source.customProviders)) {
    source.customProviders = source.customProviders.map((value) => {
      if (!isRecord(value)) return value;
      const provider = { ...value };
      if (provider.wireApi === undefined && provider.codexWireApi !== undefined) {
        provider.wireApi = provider.codexWireApi;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(provider, "codexWireApi")) {
        delete provider.codexWireApi;
        changed = true;
      }
      return provider;
    });
  }

  source.settingsSchemaVersion = CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION;
  return { source, legacyKernelProviderBindings, changed };
}

export function migrateLegacyKernelProviderBindingsToModels(input: {
  legacyBindings: Record<string, string>;
  modelBindings: BridgeModelProviderBinding[];
  providers: BridgeProviderProfile[];
  preferredKernel?: string;
}): BridgeModelProviderBinding[] {
  const migrated = new Map(input.modelBindings.map((binding) => [binding.modelId, { ...binding }]));

  const legacyEntries = Object.entries(input.legacyBindings).sort(
    ([left], [right]) => Number(right === input.preferredKernel) - Number(left === input.preferredKernel),
  );
  for (const [rawKernelId, providerId] of legacyEntries) {
    if (!isBridgeKernelId(rawKernelId)) continue;
    let routeProviderId: string;
    let providerModels: BridgeProviderProfile["models"];
    if (providerId === LOGIN_PROVIDER_BINDING_ID) {
      routeProviderId = LOGIN_PROVIDER_BINDING_ID;
      providerModels = [];
    } else if (providerId === LEGACY_NATIVE_PROVIDER_BINDING_ID) {
      const localCandidates = input.providers.filter(
        (candidate) =>
          candidate.sourceKernel === rawKernelId &&
          providerCanBindKernel(rawKernelId, candidate) &&
          candidate.authConfigured === true,
      );
      const localProfile =
        localCandidates[0] ?? providerProfileFromLocalRoute(readKernelLocalRouteProfile(rawKernelId));
      if (!localProfile || !providerCanBindKernel(rawKernelId, localProfile)) continue;
      routeProviderId = isLoginProviderProfile(rawKernelId, localProfile) ? LOGIN_PROVIDER_BINDING_ID : localProfile.id;
      providerModels = localProfile.models;
    } else {
      const provider = input.providers.find((candidate) => candidate.id === providerId);
      if (!provider || !providerCanBindKernel(rawKernelId, provider)) continue;
      routeProviderId = isLoginProviderProfile(rawKernelId, provider) ? LOGIN_PROVIDER_BINDING_ID : provider.id;
      providerModels = provider.models;
    }
    const modelIds = new Set([
      LEGACY_NATIVE_MODEL_ID,
      ...providerModels.map((model) => model.id.trim()).filter(Boolean),
    ]);
    for (const modelId of modelIds) {
      if (migrated.has(modelId)) continue;
      migrated.set(modelId, { modelId, providerId: routeProviderId });
    }
  }

  return [...migrated.values()];
}

function normalizeLegacyKernelProviderBindings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [kernelId, providerId] of Object.entries(value)) {
    if (typeof providerId === "string" && providerId.trim()) output[kernelId] = providerId.trim();
  }
  return output;
}

// forwarding-boundary: narrows untrusted persisted keys to the current Kernel id union.
function isBridgeKernelId(value: string): value is BridgeKernelId {
  return (BRIDGE_KERNEL_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
