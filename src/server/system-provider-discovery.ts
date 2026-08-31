import type { BridgeProviderProfile, BridgeSettings } from "./bridge-types.js";
import { BRIDGE_KERNEL_IDS } from "./bridge-types.js";
import { kernelBinaryPathOverride, kernelConfigHome } from "./kernel-utils.js";
import { type KernelLocalRouteProfile, readKernelLocalRouteProfile } from "./kernel-registry.js";
import { getAllBridgeProviderProfiles, getBridgeProviderProfiles } from "./provider-profiles.js";

export const CURRENT_PROVIDER_SETUP_VERSION = 4;

export function applyProviderSetupMigration(settings: BridgeSettings): BridgeSettings {
  const needsExplicitActivation = (settings.providerSetupVersion ?? 0) < CURRENT_PROVIDER_SETUP_VERSION;
  let next: BridgeSettings = {
    ...settings,
    providerSetupVersion: CURRENT_PROVIDER_SETUP_VERSION,
    modelProviderBindings: settings.modelProviderBindings.map((binding) => ({ ...binding })),
    customProviders: settings.customProviders.map((provider) =>
      needsExplicitActivation && provider.deleted !== true && typeof provider.enabled !== "boolean"
        ? { ...provider, enabled: true }
        : provider,
    ),
  };
  if (needsExplicitActivation) {
    next = activateLegacyProviderReferences(
      next,
      settings.modelProviderBindings.map((binding) => binding.providerId),
    );
  }
  const removedProviderIds = new Set(
    next.customProviders.filter(isKernelScannedProvider).map((provider) => provider.id),
  );
  next.customProviders = next.customProviders.filter((provider) => !removedProviderIds.has(provider.id));
  next.modelProviderBindings = next.modelProviderBindings.filter(
    (binding) => !removedProviderIds.has(binding.providerId),
  );

  return next;
}

/**
 * OpenGrove <=0.6.3 treated a referenced built-in Provider as active without
 * persisting an enabled override. Materialize only those references during the
 * one-time activation migration. Provider setup v4 retires automatic imports
 * from Kernel configuration entirely.
 */
export function activateLegacyProviderReferences(
  settings: BridgeSettings,
  providerIds: Iterable<string | undefined>,
): BridgeSettings {
  const referencedIds = new Set(
    [...providerIds]
      .map((providerId) => providerId?.trim() ?? "")
      .filter((providerId) => providerId && !providerId.startsWith("$")),
  );
  if (!referencedIds.size) return settings;

  let changed = false;
  const customProviders = settings.customProviders.map((provider) => {
    if (!referencedIds.has(provider.id) || provider.deleted === true || typeof provider.enabled === "boolean") {
      return provider;
    }
    changed = true;
    return { ...provider, enabled: true };
  });
  const existingIds = new Set(customProviders.map((provider) => provider.id));
  const presetsById = new Map(getBridgeProviderProfiles().map((provider) => [provider.id, provider]));
  for (const providerId of referencedIds) {
    if (existingIds.has(providerId)) continue;
    const preset = presetsById.get(providerId);
    if (!preset) continue;
    customProviders.push({
      id: preset.id,
      name: preset.name,
      protocol: preset.protocol,
      custom: true,
      enabled: true,
      models: [],
    });
    existingIds.add(providerId);
    changed = true;
  }
  return changed ? { ...settings, customProviders } : settings;
}

/**
 * OpenGrove <=0.6.1 inferred Provider routes from Kernel configuration without
 * persisting the effective route. Recreate that read-only directory only while
 * the standalone route migration is pending. The returned profiles must never
 * be saved back into Host settings.
 */
export function legacyProviderProfilesForImplicitRouteMigration(settings: BridgeSettings): BridgeProviderProfile[] {
  let customProviders = removeLegacyOpenClawDiscoveredProviders(
    settings.customProviders.map((provider) => ({ ...provider })),
  );

  for (const kernel of BRIDGE_KERNEL_IDS) {
    if (kernel === "openclaw") continue;
    const discovered = providerProfileFromLocalRoute(
      readKernelLocalRouteProfile(kernel, {
        binaryPath: kernelBinaryPathOverride(settings, kernel),
        configHome: kernelConfigHome(settings, kernel),
      }),
    );
    if (!discovered) {
      customProviders = removeDiscoveredProvidersForKernel(customProviders, kernel);
      continue;
    }
    if (isDeletedProvider(customProviders, discovered.id)) continue;
    customProviders = upsertDiscoveredProvider(customProviders, discovered);
    customProviders = removeStaleDiscoveredAliases(customProviders, discovered);
  }

  return getAllBridgeProviderProfiles(customProviders);
}

function isKernelScannedProvider(provider: BridgeProviderProfile): boolean {
  return provider.origin === "discovered" && provider.credentialKind !== "gateway-managed";
}

function removeLegacyOpenClawDiscoveredProviders(current: BridgeProviderProfile[]): BridgeProviderProfile[] {
  return current.filter(
    (provider) =>
      provider.deleted === true ||
      provider.origin !== "discovered" ||
      provider.sourceKernel !== "openclaw" ||
      provider.credentialKind === "gateway-managed",
  );
}

function removeDiscoveredProvidersForKernel(
  current: BridgeProviderProfile[],
  kernel: BridgeProviderProfile["sourceKernel"],
): BridgeProviderProfile[] {
  return current.filter(
    (provider) => provider.deleted === true || provider.origin !== "discovered" || provider.sourceKernel !== kernel,
  );
}

export function providerProfileFromLocalRoute(
  profile: KernelLocalRouteProfile | undefined,
): BridgeProviderProfile | undefined {
  if (!profile || !shouldMaterializeLocalRoute(profile)) return undefined;
  const materializer = PROVIDER_MATERIALIZERS[profile.kernel];
  return materializer ? materializer(profile) : genericProviderFromLocalRoute(profile);
}

const PROVIDER_MATERIALIZERS: Partial<Record<string, (profile: KernelLocalRouteProfile) => BridgeProviderProfile>> = {
  codex: codexProviderFromLocalRoute,
  "claude-code": claudeProviderFromLocalRoute,
};

function shouldMaterializeLocalRoute(profile: KernelLocalRouteProfile): boolean {
  return Boolean(profile.authConfigured || profile.baseUrl || profile.models.length);
}

function codexProviderFromLocalRoute(profile: KernelLocalRouteProfile): BridgeProviderProfile {
  const login = profile.routeKind === "login";
  const id = login ? "codex-login" : profile.baseUrl ? slug(profile.providerId || "codex-provider") : "openai";
  return {
    id,
    name: login ? "ChatGPT" : profile.providerLabel || (id === "openai" ? "OpenAI API" : id),
    custom: true,
    origin: "discovered",
    sourceKernel: profile.kernel,
    source: profile.source,
    sourcePaths: profile.sourcePaths,
    authConfigured: profile.authConfigured,
    routeKind: profile.routeKind,
    protocol: login ? "native-oauth" : "openai-compatible",
    openaiBaseUrl: profile.baseUrl,
    apiKeyEnv: profile.apiKeyEnv,
    credentialKind: login ? "native-login" : profile.apiKeyEnv ? "env-key" : "kernel-native",
    models: profile.models,
  };
}

function claudeProviderFromLocalRoute(profile: KernelLocalRouteProfile): BridgeProviderProfile {
  const login = profile.routeKind === "login";
  const id = login ? "claude-code-login" : slug(profile.providerId || "anthropic");
  return {
    id,
    name: login ? "Claude Agent" : profile.providerLabel || (id === "anthropic" ? "Anthropic" : id),
    custom: true,
    origin: "discovered",
    sourceKernel: profile.kernel,
    source: profile.source,
    sourcePaths: profile.sourcePaths,
    authConfigured: profile.authConfigured,
    routeKind: profile.routeKind,
    protocol: login ? "native-oauth" : "anthropic-compatible",
    anthropicBaseUrl: profile.baseUrl || (id === "anthropic" ? "https://api.anthropic.com" : undefined),
    apiKeyEnv: profile.apiKeyEnv,
    credentialKind: login ? "native-login" : claudeCredentialKind(id, profile.apiKeyEnv),
    models: profile.models,
  };
}

function genericProviderFromLocalRoute(profile: KernelLocalRouteProfile): BridgeProviderProfile {
  return {
    // Provider identity includes the Kernel custody boundary. A Pi-managed
    // OpenAI credential and an OpenGrove-managed OpenAI API key are different
    // routes even though they reach the same upstream vendor.
    id: slug(`${profile.kernel}-${profile.providerId || "provider"}`),
    name: profile.providerLabel || profile.kernel,
    custom: true,
    origin: "discovered",
    sourceKernel: profile.kernel,
    source: profile.source,
    sourcePaths: profile.sourcePaths,
    authConfigured: profile.authConfigured,
    routeKind: profile.routeKind,
    protocol: profile.protocol || "openai-compatible",
    openaiBaseUrl: profile.protocol === "anthropic-compatible" ? undefined : profile.baseUrl,
    anthropicBaseUrl: profile.protocol === "anthropic-compatible" ? profile.baseUrl : undefined,
    geminiBaseUrl: profile.protocol === "gemini-compatible" ? profile.baseUrl : undefined,
    apiKeyEnv: profile.apiKeyEnv,
    credentialKind: profile.apiKeyEnv ? "env-key" : "kernel-native",
    models: profile.models,
  };
}

function claudeCredentialKind(id: string, apiKeyEnv: string | undefined): BridgeProviderProfile["credentialKind"] {
  if (id.includes("bedrock")) return "aws";
  if (id.includes("vertex")) return "google-adc";
  return apiKeyEnv ? "env-key" : "kernel-native";
}

function upsertDiscoveredProvider(
  current: BridgeProviderProfile[],
  discovered: BridgeProviderProfile,
): BridgeProviderProfile[] {
  const index = current.findIndex((provider) => provider.id === discovered.id);
  if (index < 0) return [...current, { ...discovered, enabled: true }];

  const existing = current[index]!;
  if (existing.origin && existing.origin !== "discovered" && !canRefreshStaleDiscoveredProvider(existing, discovered)) {
    return current;
  }
  if (!existing.origin && existing.custom && !existing.sourceKernel) return current;

  const next = [...current];
  next[index] = {
    ...existing,
    ...withoutUndefined(discovered),
    custom: true,
    deleted: false,
    enabled: existing.enabled ?? true,
    origin: "discovered",
  };
  return next;
}

function canRefreshStaleDiscoveredProvider(
  existing: BridgeProviderProfile,
  discovered: BridgeProviderProfile,
): boolean {
  if (existing.id !== discovered.id) return false;
  if (existing.sourceKernel || discovered.sourceKernel) return true;
  return existing.custom === true && existing.id.endsWith("-native");
}

function removeStaleDiscoveredAliases(
  current: BridgeProviderProfile[],
  discovered: BridgeProviderProfile,
): BridgeProviderProfile[] {
  return current.filter((provider) => {
    if (provider.deleted === true) return true;
    if (provider.id === discovered.id) return true;
    if (provider.origin !== "discovered" || provider.sourceKernel !== discovered.sourceKernel) return true;
    if (isClaudeBedrockDiscoveredAlias(provider) && provider.apiKey?.trim()) return true;
    return false;
  });
}

function isClaudeBedrockDiscoveredAlias(provider: BridgeProviderProfile): boolean {
  return (
    provider.sourceKernel === "claude-code" &&
    provider.origin === "discovered" &&
    (provider.id === "aws-bedrock" || provider.id === "aws-bedrock-api-key")
  );
}

function isDeletedProvider(providers: BridgeProviderProfile[], providerId: string): boolean {
  return providers.some((provider) => provider.id === providerId && provider.deleted);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
