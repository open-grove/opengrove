import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import { normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import { readAppEnv } from "../identity.js";
import type { JsonObject } from "../core.js";
import {
  DEFAULT_KERNEL_NO_PROXY,
  DEFAULT_KERNEL_PROXY_URL,
  kernelProxySummary,
  resolveKernelProxySettings,
} from "../runtime/kernel-proxy.js";
import { bridgeDataPath } from "./storage-paths.js";
import type {
  BridgeAppStoreSettings,
  BridgeKernelProxySettings,
  BridgeModelProviderBinding,
  BridgeMountedAppSettings,
  BridgeProviderProfile,
  BridgeRoomCollaborationSettings,
  BridgeSettings,
  BridgeState,
} from "./bridge-types.js";
import { getBridgeKernelOptions, normalizeBridgeKernelPreference } from "./kernel-selection.js";
import { isEnabledEnvFlag } from "./env-flags.js";
import {
  getAllBridgeProviderProfiles,
  getBridgeProviderSummaries,
  normalizeCustomProviderProfiles,
} from "./provider-profiles.js";
import {
  CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION,
  migrateBridgeSettingsSourceToV1,
  migrateLegacyKernelProviderBindingsToModels,
} from "./migrations/bridge-settings-v1.js";
import { CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION } from "./migrations/implicit-provider-routes-v1.js";
import { CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION } from "./migrations/native-employee-model-v1.js";
import { normalizeKernelPathOverrides } from "./kernel-utils.js";
import { normalizeWorkspaceRootValue, resolveBridgeWorkspaceRoot } from "./workspace-root.js";
import { writePrivateFileAtomically } from "../storage/private-file.js";
import {
  defaultBridgeVoiceSettings,
  getBridgeSttProviderCatalog,
  normalizeBridgeVoiceSettings,
} from "./voice/settings.js";
import { DEFAULT_ROOM_DELEGATION_CHAIN_DEPTH, DEFAULT_ROOM_DELEGATIONS_PER_RUN } from "./room-delegation-budget.js";
import { mountedAppManifestIssue, readMountedAppManifest } from "./mounted-apps.js";
import { normalizeHostLanguagePreference, normalizeHostSystemLanguage } from "./language-preference.js";
import { isRetiredKnowledgeVaultMount, RETIRED_KNOWLEDGE_VAULT_PACKAGE_KEY } from "./retired-apps.js";
import { recordProblem } from "./problem-records.js";
import { kernelLoginRouteProfiles } from "./kernel-login.js";
import { providerView } from "./provider-state.js";

export function getBridgeSettingsSnapshot(state: BridgeState): JsonObject {
  const providerSummaries = getBridgeProviderSummaries(state.settings.customProviders);
  const loginRouteSummaries = kernelLoginRouteProfiles(state).map((profile) => ({
    ...providerView(profile),
    models: [],
    modelCount: profile.models.length,
    modelCatalogRevision: `login:${profile.models.map((model) => model.id).join(",")}`,
  }));
  return {
    settingsSchemaVersion: state.settings.settingsSchemaVersion,
    developerMode: state.settings.developerMode,
    directKernelChatEnabled: state.settings.directKernelChatEnabled === true,
    ...(state.settings.languagePreference ? { languagePreference: state.settings.languagePreference } : {}),
    ...(state.settings.systemLanguage ? { systemLanguage: state.settings.systemLanguage } : {}),
    kernel: state.settings.kernel,
    workspaceRoot: resolveBridgeWorkspaceRoot(state.settings),
    workspaceRootConfigured: Boolean(state.settings.workspaceRoot),
    providerSetupVersion: state.settings.providerSetupVersion ?? 0,
    activeKernel: state.kernel,
    activeModel: state.model,
    ...(state.kernelUnavailableCode ? { kernelUnavailableCode: state.kernelUnavailableCode } : {}),
    ...(state.kernelUnavailableReason ? { kernelUnavailableReason: state.kernelUnavailableReason } : {}),
    kernels: getBridgeKernelOptions(state),
    providers: [...providerSummaries, ...loginRouteSummaries] as unknown as JsonObject[],
    modelProviderBindings: state.settings.modelProviderBindings as unknown as JsonObject[],
    customProviders: providerSettingsForClient(state.settings.customProviders),
    kernelPathOverrides: state.settings.kernelPathOverrides as unknown as JsonObject,
    kernelProxy: kernelProxySummary(resolveKernelProxySettings(state.settings.kernelProxy, process.env)),
    appStore: state.settings.appStore as unknown as JsonObject,
    appUpdates: state.settings.appUpdates as unknown as JsonObject,
    voice: {
      ...state.settings.voice,
      sttProviders: getBridgeSttProviderCatalog(state.settings.voice),
    } as unknown as JsonObject,
    mountedApps: effectiveMountedApps(state) as unknown as JsonObject[],
    roomCollaboration: state.settings.roomCollaboration as unknown as JsonObject,
    settingsPath: bridgeSettingsPath(state),
  };
}

export function getPublicBridgeSettingsSnapshot(state: BridgeState): JsonObject {
  const snapshot = getBridgeSettingsSnapshot(state);
  return stripUndefinedLocal({
    developerMode: snapshot.developerMode,
    directKernelChatEnabled: snapshot.directKernelChatEnabled,
    languagePreference: snapshot.languagePreference,
    systemLanguage: snapshot.systemLanguage,
    kernel: snapshot.kernel,
    providerSetupVersion: snapshot.providerSetupVersion,
    activeKernel: snapshot.activeKernel,
    activeModel: snapshot.activeModel,
    ...(typeof snapshot.kernelUnavailableCode === "string"
      ? { kernelUnavailableCode: snapshot.kernelUnavailableCode }
      : {}),
    ...(typeof snapshot.kernelUnavailableReason === "string"
      ? { kernelUnavailableReason: snapshot.kernelUnavailableReason }
      : {}),
    kernels: sanitizeKernelOptions(snapshot.kernels),
    providers: sanitizeProviderProfiles(snapshot.providers),
    modelProviderBindings: snapshot.modelProviderBindings,
    customProviders: sanitizeProviderProfiles(snapshot.customProviders),
    kernelPathOverrides: {},
    kernelProxy: snapshot.kernelProxy,
    appStore: sanitizeAppStoreSettings(snapshot.appStore),
    appUpdates: sanitizeAppUpdateSettings(snapshot.appUpdates),
    voice: sanitizeVoiceSettings(snapshot.voice),
    mountedApps: [],
    workspaceRootConfigured: false,
  }) as JsonObject;
}

export function normalizeBridgeSettingsPatch(input: unknown, base: BridgeSettings): BridgeSettings {
  const object = record(input);
  const source = Object.keys(record(object.settings)).length > 0 ? record(object.settings) : object;
  const mountedApps = normalizeMountedApps(source.mountedApps, base.mountedApps);
  const uninstalledStoreAppIds = normalizedUninstalledStoreAppIds(
    normalizeStringList(source.uninstalledStoreAppIds, base.uninstalledStoreAppIds),
    mountedApps,
  );
  const kernel = normalizeBridgeKernelPreference(source.kernel, base.kernel);
  return {
    settingsSchemaVersion: CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION,
    developerMode: typeof source.developerMode === "boolean" ? source.developerMode : base.developerMode,
    directKernelChatEnabled:
      typeof source.directKernelChatEnabled === "boolean"
        ? source.directKernelChatEnabled
        : base.directKernelChatEnabled,
    languagePreference: normalizeHostLanguagePreference(source.languagePreference, base.languagePreference),
    systemLanguage: normalizeHostSystemLanguage(source.systemLanguage, base.systemLanguage),
    kernel,
    workspaceRoot: normalizeWorkspaceRootValue(source.workspaceRoot, base.workspaceRoot),
    providerSetupVersion: numberOrUndefined(source.providerSetupVersion) ?? base.providerSetupVersion,
    providerRouteMigrationVersion: base.providerRouteMigrationVersion,
    employeeModelMigrationVersion: base.employeeModelMigrationVersion,
    mountedApps,
    uninstalledStoreAppIds,
    defaultAppSync: normalizeDefaultAppSyncSettings(source.defaultAppSync, base.defaultAppSync),
    appUpdates: normalizeAppUpdateSettings(source.appUpdates, base.appUpdates),
    kernelProxy: normalizeKernelProxySettings(source.kernelProxy, base.kernelProxy),
    appStore:
      explicitAppStoreSettings() ??
      normalizeAppStoreSettings(source.appStore ?? record(source.cloud).appStore, base.appStore),
    voice: normalizeBridgeVoiceSettings(source.voice, base.voice),
    kernelPathOverrides: normalizeKernelPathOverrides(source.kernelPathOverrides, base.kernelPathOverrides),
    modelProviderBindings: normalizeModelProviderBindings(source.modelProviderBindings, base.modelProviderBindings),
    customProviders: Object.prototype.hasOwnProperty.call(source, "customProviders")
      ? normalizeCustomProviderSettingsPatch(source.customProviders, base.customProviders)
      : base.customProviders,
    roomCollaboration: normalizeRoomCollaborationSettings(source.roomCollaboration, base.roomCollaboration),
  };
}

function sanitizeKernelOptions(value: unknown): JsonObject[] {
  return arrayRecords(value).map(
    (kernel) =>
      stripUndefinedLocal({
        id: kernel.id,
        label: kernel.label,
        description: kernel.description,
        available: kernel.available,
        active: kernel.active,
        reason: kernel.reason,
        installed: kernel.installed,
        version: kernel.version,
        executableProbe: kernel.executableProbe,
        bindingKind: kernel.bindingKind,
        bindingStatus: kernel.bindingStatus,
        providerAvailable: kernel.providerAvailable,
        providerId: kernel.providerId,
        providerLabel: kernel.providerLabel,
      }) as JsonObject,
  );
}

function sanitizeProviderProfiles(value: unknown): JsonObject[] {
  return arrayRecords(value).map(
    (provider) =>
      stripUndefinedLocal({
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        custom: provider.custom,
        deleted: provider.deleted,
        enabled: provider.enabled,
        origin: provider.origin,
        sourceKernel: provider.sourceKernel,
        runtime: sanitizeProviderRuntime(provider.runtime),
        routeKind: provider.routeKind,
        description: provider.description,
        descriptionCode: provider.descriptionCode,
        openaiBaseUrl: provider.openaiBaseUrl,
        anthropicBaseUrl: provider.anthropicBaseUrl,
        geminiBaseUrl: provider.geminiBaseUrl,
        apiKeyEnv: provider.apiKeyEnv,
        credentialKind: provider.credentialKind,
        wireApi: provider.wireApi,
        modelsPinned: provider.modelsPinned,
        models: provider.models,
        modelCount: provider.modelCount,
        modelCatalogRevision: provider.modelCatalogRevision,
        websiteUrl: provider.websiteUrl,
        catalogProviderId: provider.catalogProviderId,
        docsUrl: provider.docsUrl,
      }) as JsonObject,
  );
}

function sanitizeProviderRuntime(value: unknown): JsonObject | undefined {
  const runtime = record(value);
  const credential = record(runtime.credential);
  if (!Object.keys(runtime).length) return undefined;
  return stripUndefinedLocal({
    active: runtime.active,
    usable: runtime.usable,
    credential: stripUndefinedLocal({
      status: credential.status,
      configured: credential.configured,
      source: credential.source,
      writable: credential.writable,
    }) as JsonObject,
  }) as JsonObject;
}

function providerSettingsForClient(providers: BridgeProviderProfile[]): JsonObject[] {
  return providerProfilesWithoutCredentialObservations(providers).map((provider) => provider as unknown as JsonObject);
}

function providerProfilesWithoutCredentialObservations(providers: BridgeProviderProfile[]): BridgeProviderProfile[] {
  return providers.map(({ authConfigured: _runtimeObservation, ...provider }) => provider);
}

/** Renderer writes are preferences/configuration only; runtime credential observations stay server-owned. */
function normalizeCustomProviderSettingsPatch(
  value: unknown,
  current: BridgeProviderProfile[],
): BridgeProviderProfile[] {
  return normalizeCustomProviderProfiles(value).map((provider) => {
    const existing = current.find((candidate) => candidate.id === provider.id);
    const sourceManaged = existing?.origin === "discovered" || Boolean(existing?.sourceKernel);
    const wwCredentialChanged =
      provider.id === "ww" &&
      (provider.apiKey !== existing?.apiKey ||
        provider.apiKeyEnv !== existing?.apiKeyEnv ||
        provider.anthropicBaseUrl !== existing?.anthropicBaseUrl);
    return {
      ...provider,
      authConfigured: sourceManaged ? existing?.authConfigured : undefined,
      ...(provider.id === "ww"
        ? {
            provisioning: wwCredentialChanged
              ? { status: "pending" as const, reason: "credential_changed", attempt: 0 }
              : existing?.provisioning,
            provisioningBlocked: wwCredentialChanged ? true : existing?.provisioningBlocked,
          }
        : {}),
    };
  });
}

function sanitizeAppStoreSettings(value: unknown): JsonObject {
  const source = record(value);
  const registryUrl = stringOrUndefined(source.registryUrl);
  const releaseControlUrl = stringOrUndefined(source.releaseControlUrl);
  return stripUndefinedLocal({
    registryUrl,
    releaseControlUrl,
  }) as JsonObject;
}

function sanitizeAppUpdateSettings(value: unknown): JsonObject {
  const source = record(value);
  return stripUndefinedLocal({
    automatic: source.automatic !== false,
    lastSuccessfulCheckAt: stringOrUndefined(source.lastSuccessfulCheckAt),
  }) as JsonObject;
}

function sanitizeVoiceSettings(value: unknown): JsonObject {
  const source = record(value);
  return stripUndefinedLocal({
    sttProvider: source.sttProvider,
    language: source.language,
    sttProviders: sanitizeProviderProfiles(source.sttProviders),
  }) as JsonObject;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function stripUndefinedLocal(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function effectiveMountedApps(state: BridgeState): BridgeSettings["mountedApps"] {
  return state.settings.mountedApps
    .filter((app) => !isRetiredKnowledgeVaultMount(app))
    .map((app) => {
      if (!app.path?.trim()) return app;
      const manifestRead = readMountedAppManifest(app.path);
      const policyIssue = mountedAppManifestIssue(app.path, manifestRead);
      return policyIssue ? { ...app, enabled: false, policyIssue } : app;
    });
}

export function loadBridgeSettings(state: BridgeState): BridgeSettings {
  const defaults = defaultBridgeSettings();
  const path = bridgeSettingsPath(state);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = validatedBridgeSettingsSource(JSON.parse(contents));
  } catch (error) {
    const corruptBackupPath = `${path}.corrupt-${Date.now()}-${randomUUID()}.bak`;
    renameSync(path, corruptBackupPath);
    console.warn("bridge_settings_quarantined", {
      settingsPath: path,
      corruptBackupPath,
      error: error instanceof Error ? error.message : String(error),
    });
    recordProblem(state, {
      category: "bridge",
      phase: "settings-load",
      code: "bridge_settings_quarantined",
      level: "error",
      error,
      retryable: false,
      context: {
        settingsFile: basename(path),
        backupFile: basename(corruptBackupPath),
      },
    });
    return defaults;
  }
  const migration = migrateBridgeSettingsSourceToV1(parsed);
  parsed = migration.source;
  const kernel = normalizeBridgeKernelPreference(parsed.kernel, defaults.kernel);
  const customProviders = normalizeCustomProviderProfiles(parsed.customProviders ?? defaults.customProviders);
  const normalizedPersistedModelBindings = normalizeModelProviderBindings(
    parsed.modelProviderBindings,
    defaults.modelProviderBindings,
  );
  const modelProviderBindings = migrateLegacyKernelProviderBindingsToModels({
    legacyBindings: migration.legacyKernelProviderBindings,
    modelBindings: normalizedPersistedModelBindings,
    providers: getAllBridgeProviderProfiles(customProviders),
    preferredKernel: kernel,
  });
  const mountedApps = normalizeMountedApps(parsed.mountedApps, defaults.mountedApps);
  const uninstalledStoreAppIds = normalizedUninstalledStoreAppIds(
    normalizeStringList(parsed.uninstalledStoreAppIds, defaults.uninstalledStoreAppIds),
    mountedApps,
  );
  const settings: BridgeSettings = {
    settingsSchemaVersion: CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION,
    developerMode: typeof parsed.developerMode === "boolean" ? parsed.developerMode : defaults.developerMode,
    directKernelChatEnabled:
      typeof parsed.directKernelChatEnabled === "boolean"
        ? parsed.directKernelChatEnabled
        : defaults.directKernelChatEnabled,
    languagePreference: normalizeHostLanguagePreference(parsed.languagePreference, defaults.languagePreference),
    systemLanguage: normalizeHostSystemLanguage(parsed.systemLanguage, defaults.systemLanguage),
    kernel,
    workspaceRoot: normalizeWorkspaceRootValue(parsed.workspaceRoot, defaults.workspaceRoot),
    providerSetupVersion: numberOrUndefined(parsed.providerSetupVersion) ?? defaults.providerSetupVersion,
    providerRouteMigrationVersion: numberOrUndefined(parsed.providerRouteMigrationVersion) ?? 0,
    employeeModelMigrationVersion: numberOrUndefined(parsed.employeeModelMigrationVersion) ?? 0,
    mountedApps,
    uninstalledStoreAppIds,
    defaultAppSync: normalizeDefaultAppSyncSettings(parsed.defaultAppSync, defaults.defaultAppSync),
    appUpdates: normalizeAppUpdateSettings(parsed.appUpdates, defaults.appUpdates),
    kernelProxy: normalizeKernelProxySettings(parsed.kernelProxy, defaults.kernelProxy),
    appStore:
      explicitAppStoreSettings() ??
      normalizeAppStoreSettings(parsed.appStore ?? record(parsed.cloud).appStore, defaults.appStore),
    voice: normalizeBridgeVoiceSettings(parsed.voice, defaults.voice),
    kernelPathOverrides: normalizeKernelPathOverrides(parsed.kernelPathOverrides, defaults.kernelPathOverrides),
    modelProviderBindings,
    customProviders: providerProfilesWithoutCredentialObservations(customProviders),
    roomCollaboration: normalizeRoomCollaborationSettings(parsed.roomCollaboration, defaults.roomCollaboration),
  };
  const persistedModelBindings = Array.isArray(parsed.modelProviderBindings) ? parsed.modelProviderBindings : [];
  const persistedRuntimeCredentialState = arrayRecords(parsed.customProviders).some((provider) =>
    Object.prototype.hasOwnProperty.call(provider, "authConfigured"),
  );
  if (
    migration.changed ||
    persistedRuntimeCredentialState ||
    JSON.stringify(persistedModelBindings) !== JSON.stringify(modelProviderBindings)
  ) {
    const backupPath = `${path}.pre-settings-schema-v1.bak`;
    if (!existsSync(backupPath)) copyFileSync(path, backupPath);
    writePrivateFileAtomically(path, `${JSON.stringify(settingsForPersistence(settings), null, 2)}\n`);
  }
  return settings;
}

export function saveBridgeSettings(state: BridgeState): void {
  const path = bridgeSettingsPath(state);
  writePrivateFileAtomically(path, `${JSON.stringify(settingsForPersistence(state.settings), null, 2)}\n`);
}

function settingsForPersistence(settings: BridgeSettings): BridgeSettings {
  return {
    ...settings,
    customProviders: providerProfilesWithoutCredentialObservations(settings.customProviders),
  };
}

export function clearMountedAppUninstallMarkers(
  settings: Pick<BridgeSettings, "uninstalledStoreAppIds">,
  appIds: Iterable<string>,
): boolean {
  const mountedAppIds = new Set([...appIds].map((appId) => appId.trim()).filter(Boolean));
  if (!mountedAppIds.size) return false;
  const filtered = settings.uninstalledStoreAppIds.filter((appId) => !mountedAppIds.has(appId));
  if (filtered.length === settings.uninstalledStoreAppIds.length) return false;
  settings.uninstalledStoreAppIds = filtered;
  return true;
}

export function defaultBridgeSettings(): BridgeSettings {
  return {
    settingsSchemaVersion: CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION,
    developerMode: false,
    directKernelChatEnabled: false,
    kernel: normalizeBridgeKernelPreference(readAppEnv("KERNEL"), "claude-code"),
    workspaceRoot: normalizeWorkspaceRootValue(readAppEnv("WORKSPACE_ROOT"), undefined),
    providerSetupVersion: 0,
    providerRouteMigrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    employeeModelMigrationVersion: CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION,
    mountedApps: defaultMountedApps(),
    uninstalledStoreAppIds: [],
    defaultAppSync: { managedPackageKeys: [] },
    appUpdates: { automatic: true },
    kernelProxy: defaultKernelProxySettings(),
    appStore: explicitAppStoreSettings(),
    voice: defaultBridgeVoiceSettings(),
    kernelPathOverrides: {},
    modelProviderBindings: [],
    customProviders: [],
    roomCollaboration: {
      maxDelegationsPerRun: DEFAULT_ROOM_DELEGATIONS_PER_RUN,
      maxDelegationChainDepth: DEFAULT_ROOM_DELEGATION_CHAIN_DEPTH,
    },
  };
}

function normalizeDefaultAppSyncSettings(
  input: unknown,
  fallback: BridgeSettings["defaultAppSync"],
): BridgeSettings["defaultAppSync"] {
  const source = record(input);
  const managedPackageKeys = normalizeStringList(source.managedPackageKeys, fallback.managedPackageKeys).flatMap(
    (value) => {
      const packageKey = normalizeAppStorePackageKey(value);
      return packageKey ? [packageKey] : [];
    },
  );
  const releaseNumber = positiveInteger(
    source.lastSuccessfulClientReleaseNumber,
    fallback.lastSuccessfulClientReleaseNumber ?? 0,
  );
  return {
    managedPackageKeys: [...new Set(managedPackageKeys)]
      .filter((packageKey) => packageKey !== RETIRED_KNOWLEDGE_VAULT_PACKAGE_KEY)
      .sort(),
    ...(releaseNumber > 0 ? { lastSuccessfulClientReleaseNumber: releaseNumber } : {}),
  };
}

function normalizeAppUpdateSettings(
  input: unknown,
  fallback: BridgeSettings["appUpdates"],
): BridgeSettings["appUpdates"] {
  const source = record(input);
  const lastSuccessfulCheckAt = validIsoTimestamp(source.lastSuccessfulCheckAt)
    ? String(source.lastSuccessfulCheckAt)
    : validIsoTimestamp(fallback.lastSuccessfulCheckAt)
      ? fallback.lastSuccessfulCheckAt
      : undefined;
  return {
    automatic: typeof source.automatic === "boolean" ? source.automatic : fallback.automatic,
    ...(lastSuccessfulCheckAt ? { lastSuccessfulCheckAt } : {}),
  };
}

function validIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function normalizeRoomCollaborationSettings(
  input: unknown,
  fallback: BridgeRoomCollaborationSettings,
): BridgeRoomCollaborationSettings {
  const source = record(input);
  return {
    maxDelegationsPerRun: positiveInteger(source.maxDelegationsPerRun, fallback.maxDelegationsPerRun),
    maxDelegationChainDepth: positiveInteger(source.maxDelegationChainDepth, fallback.maxDelegationChainDepth),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function defaultMountedApps(): BridgeMountedAppSettings[] {
  const raw = readAppEnv("APP_DIRS") || readAppEnv("MOUNTED_APPS") || "";
  if (!raw.trim()) return [];
  return normalizeMountedApps(
    raw.split(delimiter).map((path) => ({ path })),
    [],
  );
}

function normalizeMountedApps(input: unknown, fallback: BridgeMountedAppSettings[]): BridgeMountedAppSettings[] {
  if (input === undefined || input === null) {
    return fallback.filter((item) => !isRetiredKnowledgeVaultMount(item)).map((item) => ({ ...item }));
  }
  const rawItems = Array.isArray(input) ? input : typeof input === "string" ? input.split(delimiter) : [];
  const output: BridgeMountedAppSettings[] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();

  for (const rawItem of rawItems) {
    const item = typeof rawItem === "string" ? { path: rawItem } : record(rawItem);
    const path = stringOrUndefined(item.path);
    if (!path) continue;

    const normalizedPath = resolvePathLike(path);
    if (seenPaths.has(normalizedPath)) continue;
    seenPaths.add(normalizedPath);

    const title = stringOrUndefined(item.title) ?? stringOrUndefined(item.name);
    const workspacePath = stringOrUndefined(item.workspacePath);
    let id = slug(stringOrUndefined(item.id) ?? title ?? basename(normalizedPath) ?? "app");
    if (!id) id = "app";
    const baseId = id;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    const mountedApp: BridgeMountedAppSettings = {
      id,
      path: normalizedPath,
      ...(workspacePath ? { workspacePath: resolvePathLike(workspacePath) } : {}),
      enabled: item.enabled === false ? false : true,
      ...(title ? { title } : {}),
      ...(item.appBuilderEnabled === true ? { appBuilderEnabled: true } : {}),
    };
    if (!isRetiredKnowledgeVaultMount(mountedApp)) output.push(mountedApp);
  }

  return output;
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(process.env.HOME || "");
  if (path.startsWith("~/")) return resolve(process.env.HOME || "", path.slice(2));
  return resolve(path);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultKernelProxySettings(): BridgeKernelProxySettings {
  return {
    enabled: isEnabledEnvFlag(readAppEnv("KERNEL_PROXY")),
    proxyUrl: readAppEnv("KERNEL_PROXY_URL") || DEFAULT_KERNEL_PROXY_URL,
    noProxy: readAppEnv("KERNEL_PROXY_NO_PROXY") || DEFAULT_KERNEL_NO_PROXY,
    nodeUseEnvProxy: isEnabledEnvFlag(readAppEnv("KERNEL_PROXY_NODE_USE_ENV_PROXY")),
  };
}

function explicitAppStoreSettings(): BridgeAppStoreSettings | undefined {
  const registryUrl = readAppEnv("APP_STORE_REGISTRY_URL") || readRawEnv("APP_STORE_REGISTRY_URL");
  if (!registryUrl) return undefined;
  // Process credentials stay process-scoped. Keeping them out of Bridge settings
  // prevents an environment-provided token from being persisted by a later UI edit.
  return normalizeAppStoreSettings({
    registryUrl,
    releaseControlUrl: readAppEnv("RELEASE_CONTROL_URL") || undefined,
  });
}

function readRawEnv(name: string): string {
  return process.env[name]?.trim() || "";
}

function normalizeAppStoreSettings(
  input: unknown,
  fallback?: BridgeAppStoreSettings,
): BridgeAppStoreSettings | undefined {
  if (input === undefined || input === null) {
    return fallback ? { ...fallback } : undefined;
  }
  const source = record(input);
  const rawRegistryUrl = Object.prototype.hasOwnProperty.call(source, "registryUrl")
    ? (stringOrUndefined(source.registryUrl) ?? "")
    : (fallback?.registryUrl ?? "");
  const registryUrl = normalizeRegistryBaseUrl(rawRegistryUrl);
  const registryToken = Object.prototype.hasOwnProperty.call(source, "registryToken")
    ? stringOrUndefined(source.registryToken)
    : fallback?.registryToken;
  const releaseControlUrl = Object.prototype.hasOwnProperty.call(source, "releaseControlUrl")
    ? normalizeRegistryBaseUrl(stringOrUndefined(source.releaseControlUrl) ?? "")
    : fallback?.releaseControlUrl;
  return registryUrl
    ? {
        registryUrl,
        ...(registryToken ? { registryToken } : {}),
        ...(releaseControlUrl ? { releaseControlUrl } : {}),
      }
    : undefined;
}

function normalizeRegistryBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/g, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/g, "");
  } catch {
    return trimmed.replace(/\/+$/g, "");
  }
}

function bridgeSettingsPath(state: BridgeState): string {
  const explicit = readAppEnv("BRIDGE_SETTINGS_PATH");
  if (explicit) return resolve(explicit);
  return bridgeDataPath(state, "bridge-settings.json");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function validatedBridgeSettingsSource(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bridge_settings_root_invalid");
  }
  const source = value as Record<string, unknown>;
  const schemaVersion = source.settingsSchemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== CURRENT_BRIDGE_SETTINGS_SCHEMA_VERSION) {
    throw new Error(`bridge_settings_schema_unsupported:${String(schemaVersion)}`);
  }
  return source;
}

function normalizeStringList(input: unknown, fallback: string[]): string[] {
  const values = input === undefined || input === null ? fallback : Array.isArray(input) ? input : [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizedUninstalledStoreAppIds(appIds: string[], mountedApps: BridgeMountedAppSettings[]): string[] {
  const mountedAppIds = new Set(mountedApps.map((app) => app.id.trim()).filter(Boolean));
  return appIds.filter((appId) => !mountedAppIds.has(appId));
}

function normalizeModelProviderBindings(
  input: unknown,
  fallback: BridgeModelProviderBinding[],
): BridgeModelProviderBinding[] {
  if (input === undefined || input === null) {
    return fallback.map((binding) => ({ ...binding }));
  }
  if (!Array.isArray(input)) return fallback.map((binding) => ({ ...binding }));
  const normalized = new Map<string, BridgeModelProviderBinding>();
  for (const value of input) {
    const item = record(value);
    const modelId = nonEmptyString(item.modelId);
    const providerId = nonEmptyString(item.providerId);
    if (!modelId || !providerId || Object.prototype.hasOwnProperty.call(item, "kernelId")) continue;
    normalized.set(modelId, { modelId, providerId });
  }
  return [...normalized.values()];
}

function normalizeKernelProxySettings(input: unknown, fallback: BridgeKernelProxySettings): BridgeKernelProxySettings {
  const source = record(input);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    proxyUrl: nonEmptyString(source.proxyUrl) ?? fallback.proxyUrl,
    noProxy: nonEmptyString(source.noProxy) ?? fallback.noProxy,
    nodeUseEnvProxy: typeof source.nodeUseEnvProxy === "boolean" ? source.nodeUseEnvProxy : fallback.nodeUseEnvProxy,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bridgeSettingsFileExists(state: BridgeState): boolean {
  return existsSync(bridgeSettingsPath(state));
}
