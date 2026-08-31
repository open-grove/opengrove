import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_NATIVE_PROVIDER_BINDING_ID, LOGIN_PROVIDER_BINDING_ID } from "../server/bridge-types.js";
import {
  defaultBridgeSettings,
  loadBridgeSettings,
  normalizeBridgeSettingsPatch,
} from "../server/bridge-settings-store.js";
import {
  getBridgeProviderProfiles,
  normalizeCustomProviderProfiles,
  providerEnvForKernel,
  resolveProviderRoute,
} from "../server/provider-profiles.js";
import { providerScopedRuntimeEnv } from "../server/kernel-selection.js";
import type { BridgeState } from "../server/bridge-types.js";
import {
  migrateBridgeSettingsSourceToV1,
  migrateLegacyKernelProviderBindingsToModels,
} from "../server/migrations/bridge-settings-v1.js";
import {
  CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
  migrateImplicitProviderRoutesToExplicit,
  resolveLegacyNativeEmployeeProviderId,
} from "../server/migrations/implicit-provider-routes-v1.js";
import { createBridgeState } from "../server/bridge-state.js";
import { mergeOpenClawGatewayProviders } from "../server/openclaw-provider-discovery.js";

const defaults = defaultBridgeSettings();
assert.equal(
  defaults.providerRouteMigrationVersion,
  CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
  "fresh installations must start after the legacy implicit-route migration boundary",
);
assert.equal(
  getBridgeProviderProfiles().find((provider) => provider.id === "deepseek")?.wireApi,
  "responses",
  "Codex must use DeepSeek's native Responses API",
);
assert.equal(
  getBridgeProviderProfiles().find((provider) => provider.id === "volc-coding-plan")?.wireApi,
  "chat",
  "Codex must retain the provider's generic wire API setting",
);
const sourceMigration = migrateBridgeSettingsSourceToV1({
  kernelKnowledgeSourceEnabled: {
    "claude-code": { "claude.user-skills": false },
  },
  customProviders: [
    {
      id: "legacy-wire-api",
      name: "Legacy wire API",
      codexWireApi: "chat",
      openaiBaseUrl: "https://legacy.example/v1",
      apiKey: "legacy-test-key",
      models: [{ id: "legacy-model", label: "Legacy Model" }],
    },
  ],
  kernelProviderBindings: { codex: "legacy-wire-api" },
});
const migratedProfiles = normalizeCustomProviderProfiles(sourceMigration.source.customProviders);
assert.equal(
  migratedProfiles[0]?.wireApi,
  "chat",
  "legacy persisted codexWireApi must migrate at the settings boundary",
);
assert.deepEqual(
  migrateLegacyKernelProviderBindingsToModels({
    legacyBindings: sourceMigration.legacyKernelProviderBindings,
    modelBindings: [],
    providers: migratedProfiles,
  }),
  [
    { modelId: "native", providerId: "legacy-wire-api" },
    { modelId: "legacy-model", providerId: "legacy-wire-api" },
  ],
  "a legacy Kernel Provider choice must become a model default exactly once",
);
assert.equal(Object.prototype.hasOwnProperty.call(sourceMigration.source, "kernelProviderBindings"), false);
assert.equal(Object.prototype.hasOwnProperty.call(sourceMigration.source, "kernelKnowledgeSourceEnabled"), false);
assert.equal(Object.prototype.hasOwnProperty.call(migratedProfiles[0] ?? {}, "codexWireApi"), false);

assert.deepEqual(
  migrateLegacyKernelProviderBindingsToModels({
    legacyBindings: { "claude-code": LOGIN_PROVIDER_BINDING_ID },
    modelBindings: [],
    providers: [],
  }),
  [{ modelId: "native", providerId: LOGIN_PROVIDER_BINDING_ID }],
  "an explicit legacy native choice must survive migration instead of becoming eligible for WW auto-binding",
);

const implicitRouteMigration = migrateImplicitProviderRoutesToExplicit({
  migrationVersion: 0,
  modelBindings: [{ modelId: "manual-model", providerId: "manual-provider" }],
  providers: [
    {
      id: "legacy-custom",
      name: "Legacy Custom",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://legacy-custom.example/v1",
      apiKey: "legacy-custom-key",
      models: [{ id: "legacy-custom-model", label: "Legacy Custom Model" }],
    },
    {
      id: "openai",
      name: "OpenAI",
      origin: "discovered",
      sourceKernel: "codex",
      authConfigured: true,
      routeKind: "login",
      protocol: "native-oauth",
      credentialKind: "native-login",
      models: [{ id: "gpt-5.6", label: "GPT-5.6" }],
    },
    {
      id: "ambiguous-a",
      name: "Ambiguous A",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://ambiguous-a.example/v1",
      apiKey: "ambiguous-a-key",
      models: [{ id: "ambiguous-model", label: "Ambiguous Model" }],
    },
    {
      id: "ambiguous-b",
      name: "Ambiguous B",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://ambiguous-b.example/v1",
      apiKey: "ambiguous-b-key",
      models: [{ id: "ambiguous-model", label: "Ambiguous Model" }],
    },
    {
      id: "catalogued-but-unconfigured",
      name: "Catalogued But Unconfigured",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://unconfigured.example/v1",
      apiKeyEnv: "OPENGROVE_TEST_MISSING_PROVIDER_KEY",
      credentialKind: "env-key",
      models: [
        {
          id: "unconfigured-model",
          label: "Unconfigured Model",
          defaultProviderId: "catalogued-but-unconfigured",
        },
      ],
    },
    {
      id: "runnable-but-not-preferred",
      name: "Runnable But Not Preferred",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://runnable.example/v1",
      apiKey: "runnable-key",
      models: [{ id: "unconfigured-model", label: "Unconfigured Model" }],
    },
  ],
  targets: [
    { kernelId: "codex", modelId: "legacy-custom-model" },
    { kernelId: "codex", modelId: "gpt-5.6" },
    { kernelId: "codex", modelId: "unconfigured-model" },
  ],
});
assert.deepEqual(
  implicitRouteMigration,
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [
      { modelId: "manual-model", providerId: "manual-provider" },
      { modelId: "legacy-custom-model", providerId: "legacy-custom" },
      { modelId: "gpt-5.6", providerId: LOGIN_PROVIDER_BINDING_ID },
    ],
    versionAdvanced: true,
    bindingsChanged: true,
  },
  "an existing installation must persist only runnable, unambiguous routes that the legacy runtime actually selected",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [{ modelId: "gpt-5.6", providerId: "$native" }],
    providers: [
      {
        id: "codex-login",
        name: "ChatGPT",
        origin: "discovered",
        sourceKernel: "codex",
        authConfigured: true,
        routeKind: "login",
        protocol: "native-oauth",
        credentialKind: "native-login",
        models: [{ id: "gpt-5.6", label: "GPT-5.6" }],
      },
    ],
    targets: [{ kernelId: "codex", modelId: "gpt-5.6" }],
  }),
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [{ modelId: "gpt-5.6", providerId: LOGIN_PROVIDER_BINDING_ID }],
    versionAdvanced: true,
    bindingsChanged: true,
  },
  "v0.6.1 $native bindings must be read once and rewritten as $login",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [
      { modelId: "pending-model", providerId: LEGACY_NATIVE_PROVIDER_BINDING_ID },
      { modelId: "manual-model", providerId: "manual-provider" },
    ],
    providers: [],
  }),
  {
    migrationVersion: 0,
    modelBindings: [
      { modelId: "pending-model", providerId: LEGACY_NATIVE_PROVIDER_BINDING_ID },
      { modelId: "manual-model", providerId: "manual-provider" },
    ],
    versionAdvanced: false,
    bindingsChanged: false,
  },
  "an unresolved legacy route must stay pending without reporting an order-only binding change",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [
      { modelId: "duplicate-model", providerId: LEGACY_NATIVE_PROVIDER_BINDING_ID },
      { modelId: "duplicate-model", providerId: "manual-provider" },
    ],
    providers: [],
  }).modelBindings,
  [{ modelId: "duplicate-model", providerId: "manual-provider" }],
  "an explicit Provider must win over a duplicate legacy $native entry",
);
const legacyDiscoveredProfiles = normalizeCustomProviderProfiles([
  {
    id: "anthropic",
    name: "Claude Official",
    origin: "discovered",
    sourceKernel: "claude-code",
    authConfigured: true,
    protocol: "anthropic-compatible",
    credentialKind: "kernel-native",
    models: [],
  },
  {
    id: "aws-bedrock",
    name: "AWS Bedrock",
    origin: "discovered",
    sourceKernel: "claude-code",
    authConfigured: true,
    protocol: "anthropic-compatible",
    credentialKind: "aws",
    models: [],
  },
  {
    id: "google",
    name: "Google",
    origin: "discovered",
    sourceKernel: "opencode",
    authConfigured: true,
    protocol: "openai-compatible",
    credentialKind: "kernel-native",
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    origin: "discovered",
    sourceKernel: "codex",
    authConfigured: true,
    protocol: "openai-compatible",
    credentialKind: "kernel-native",
    models: [],
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    origin: "discovered",
    sourceKernel: "kimi",
    authConfigured: true,
    protocol: "openai-compatible",
    credentialKind: "kernel-native",
    models: [],
  },
]);
assert.deepEqual(
  legacyDiscoveredProfiles.map((profile) => [profile.id, profile.routeKind]),
  [
    ["anthropic", "login"],
    ["aws-bedrock", "provider"],
    ["google", "provider"],
    ["openai", "login"],
    ["kimi-code", "login"],
  ],
  "legacy discovery data must classify only product-account credentials as Login",
);

const refreshedGatewayProviders = mergeOpenClawGatewayProviders(
  [
    {
      id: "openclaw-gateway-deleted",
      name: "Deleted upstream",
      protocol: "custom-gateway",
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      deleted: true,
      models: [],
    },
    {
      id: "openclaw-gateway-disabled",
      name: "Disabled upstream",
      protocol: "custom-gateway",
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      enabled: false,
      models: [{ id: "disabled/old", label: "Old" }],
    },
    {
      id: "openclaw-gateway-user-owned",
      name: "User-owned collision",
      protocol: "openai-compatible",
      origin: "user",
      models: [{ id: "user/model", label: "User model" }],
    },
  ],
  [
    {
      id: "openclaw-gateway-deleted",
      name: "Deleted upstream",
      protocol: "custom-gateway",
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      enabled: true,
      models: [{ id: "deleted/new", label: "New" }],
    },
    {
      id: "openclaw-gateway-disabled",
      name: "Disabled upstream",
      protocol: "custom-gateway",
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      enabled: true,
      models: [{ id: "disabled/new", label: "New" }],
    },
    {
      id: "openclaw-gateway-user-owned",
      name: "Gateway collision",
      protocol: "custom-gateway",
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      enabled: true,
      models: [{ id: "gateway/model", label: "Gateway model" }],
    },
  ],
);
assert.equal(
  refreshedGatewayProviders.find((provider) => provider.id === "openclaw-gateway-deleted")?.deleted,
  true,
  "Gateway discovery must preserve a user deletion tombstone instead of reviving the Provider",
);
assert.deepEqual(
  refreshedGatewayProviders.find((provider) => provider.id === "openclaw-gateway-disabled"),
  {
    id: "openclaw-gateway-disabled",
    name: "Disabled upstream",
    protocol: "custom-gateway",
    origin: "discovered",
    sourceKernel: "openclaw",
    credentialKind: "gateway-managed",
    enabled: false,
    models: [{ id: "disabled/new", label: "New" }],
  },
  "Gateway discovery must refresh the catalog without undoing a user-disabled Provider",
);
assert.equal(
  refreshedGatewayProviders.filter((provider) => provider.id === "openclaw-gateway-user-owned").length,
  1,
  "Gateway refresh must deduplicate an id already owned by a user Provider",
);
assert.equal(
  refreshedGatewayProviders.find((provider) => provider.id === "openclaw-gateway-user-owned")?.origin,
  "user",
  "a user-owned Provider must win an id collision with Gateway discovery",
);
assert.equal(
  resolveLegacyNativeEmployeeProviderId({
    kernelId: "claude-code",
    modelId: "claude-opus-4-8",
    employeeProviderId: "$native",
    providers: [
      {
        id: "claude-code-login",
        name: "Claude Agent",
        origin: "discovered",
        sourceKernel: "claude-code",
        authConfigured: true,
        routeKind: "login",
        protocol: "native-oauth",
        credentialKind: "native-login",
        models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
      },
    ],
  }),
  LOGIN_PROVIDER_BINDING_ID,
  "a legacy Employee $native override must migrate to the discovered product Login",
);
assert.equal(
  resolveLegacyNativeEmployeeProviderId({
    kernelId: "openclaw",
    modelId: "anthropic/claude-opus-4-6",
    employeeProviderId: "$native",
    providers: [
      {
        id: "openclaw-gateway-anthropic",
        name: "Anthropic",
        origin: "discovered",
        sourceKernel: "openclaw",
        authConfigured: true,
        routeKind: "provider",
        protocol: "custom-gateway",
        credentialKind: "gateway-managed",
        models: [{ id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" }],
      },
      {
        id: "openclaw-gateway-google",
        name: "Google",
        origin: "discovered",
        sourceKernel: "openclaw",
        authConfigured: true,
        routeKind: "provider",
        protocol: "custom-gateway",
        credentialKind: "gateway-managed",
        models: [{ id: "google/gemini-3-pro", label: "Gemini 3 Pro" }],
      },
    ],
  }),
  "openclaw-gateway-anthropic",
  "a legacy OpenClaw Employee route must migrate to the exact Gateway Provider matching its model",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [],
    providers: [
      {
        id: "must-not-reapply",
        name: "Must Not Reapply",
        protocol: "openai-compatible",
        openaiBaseUrl: "https://must-not-reapply.example/v1",
        apiKey: "must-not-reapply-key",
        models: [{ id: "later-model", label: "Later Model" }],
      },
    ],
  }),
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [],
    versionAdvanced: false,
    bindingsChanged: false,
  },
  "the compatibility migration must never reapply after the user changes a route later",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [],
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        origin: "discovered",
        sourceKernel: "codex",
        authConfigured: true,
        routeKind: "login",
        protocol: "native-oauth",
        credentialKind: "native-login",
        models: [],
      },
    ],
    targets: [{ kernelId: "codex", modelId: "gpt-5.6-private" }],
  }),
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [{ modelId: "gpt-5.6-private", providerId: LOGIN_PROVIDER_BINDING_ID }],
    versionAdvanced: true,
    bindingsChanged: true,
  },
  "a concrete legacy Employee model must preserve its working Login route even when discovery has no model catalog",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [],
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        origin: "discovered",
        sourceKernel: "codex",
        authConfigured: true,
        routeKind: "login",
        protocol: "native-oauth",
        credentialKind: "native-login",
        models: [],
      },
    ],
    targets: [
      { kernelId: "codex", modelId: "shared-private-model" },
      { kernelId: "claude-code", modelId: "shared-private-model" },
    ],
  }),
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [],
    versionAdvanced: true,
    bindingsChanged: false,
  },
  "a global model binding must not be inferred when every Employee Kernel cannot reproduce the same working route",
);
assert.deepEqual(
  migrateImplicitProviderRoutesToExplicit({
    migrationVersion: 0,
    modelBindings: [],
    providers: [],
    targets: [],
  }),
  {
    migrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    modelBindings: [],
    versionAdvanced: true,
    bindingsChanged: false,
  },
  "an empty legacy migration must persist its marker without rebuilding the Bridge App",
);

const startupMigrationDirectory = mkdtempSync(join(tmpdir(), "opengrove-provider-startup-migration-"));
try {
  const existingInstallRoot = join(startupMigrationDirectory, "existing");
  mkdirSync(existingInstallRoot, { recursive: true });
  const existingSettingsPath = join(existingInstallRoot, "bridge-settings.json");
  writeFileSync(
    existingSettingsPath,
    `${JSON.stringify(
      {
        settingsSchemaVersion: 1,
        kernel: "codex",
        modelProviderBindings: [],
        customProviders: [
          {
            id: "legacy-custom",
            name: "Legacy Custom",
            protocol: "openai-compatible",
            openaiBaseUrl: "https://legacy-custom.example/v1",
            apiKey: "legacy-custom-key",
            models: [{ id: "legacy-custom-model", label: "Legacy Custom Model" }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const existingState = createBridgeState({ statePath: join(existingInstallRoot, "state.sqlite") });
  assert.equal(existingState.settings.providerRouteMigrationVersion, CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION);
  assert.equal(
    existingState.settings.modelProviderBindings.some((binding) => binding.modelId === "legacy-custom-model"),
    false,
    "startup must not create a model default for a catalog model that no persisted Employee currently uses",
  );
  const persistedExistingSettings = JSON.parse(readFileSync(existingSettingsPath, "utf8")) as Record<string, unknown>;
  assert.equal(
    persistedExistingSettings.providerRouteMigrationVersion,
    CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
    "the migration marker must survive the next process even when no Employee route was added",
  );
  await existingState.store.close?.();

  const employeeReferenceRoot = join(startupMigrationDirectory, "employee-reference");
  mkdirSync(employeeReferenceRoot, { recursive: true });
  const employeeReferenceStatePath = join(employeeReferenceRoot, "state.sqlite");
  const employeeReferenceSettingsPath = join(employeeReferenceRoot, "bridge-settings.json");
  const employeeSeedState = createBridgeState({ statePath: employeeReferenceStatePath });
  employeeSeedState.app.rooms.upsertMember(
    {
      id: "legacy-deepseek-worker",
      name: "Legacy DeepSeek Worker",
      kernel: "codex",
      model: "deepseek-v4",
      providerId: "deepseek",
      role: "Persisted employee with an explicit Provider route.",
      status: "idle",
      color: "#64748b",
      lastActive: "configured",
      source: "local",
      userOverrides: ["providerId"],
    },
    { emitEvent: false },
  );
  employeeSeedState.store.saveFrom(employeeSeedState.app);
  await employeeSeedState.store.close?.();
  writeFileSync(
    employeeReferenceSettingsPath,
    `${JSON.stringify(
      {
        settingsSchemaVersion: 1,
        providerSetupVersion: 2,
        kernel: "codex",
        modelProviderBindings: [],
        customProviders: [],
      },
      null,
      2,
    )}\n`,
  );
  const employeeMigratedState = createBridgeState({ statePath: employeeReferenceStatePath });
  assert.equal(
    employeeMigratedState.settings.customProviders.find((provider) => provider.id === "deepseek")?.enabled,
    true,
    "startup migration must keep an Employee-referenced built-in Provider active",
  );
  await employeeMigratedState.store.close?.();

  const freshInstallRoot = join(startupMigrationDirectory, "fresh");
  mkdirSync(freshInstallRoot, { recursive: true });
  const freshState = createBridgeState({ statePath: join(freshInstallRoot, "state.sqlite") });
  assert.equal(freshState.settings.providerRouteMigrationVersion, CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION);
  assert.deepEqual(
    freshState.settings.modelProviderBindings,
    [],
    "a fresh installation must wait for WW product defaults instead of importing legacy inferred routes",
  );
  await freshState.store.close?.();
} finally {
  rmSync(startupMigrationDirectory, { recursive: true, force: true });
}

const migrationDirectory = mkdtempSync(join(tmpdir(), "opengrove-provider-migration-"));
try {
  const settingsPath = join(migrationDirectory, "bridge-settings.json");
  const state = {
    store: { kind: "json", path: join(migrationDirectory, "state.json") },
  } as BridgeState;
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        kernelKnowledgeSourceEnabled: {
          "claude-code": { "claude.user-skills": false },
        },
        kernelProviderBindings: {
          codex: "openai",
          "claude-code": LOGIN_PROVIDER_BINDING_ID,
        },
        customProviders: [
          {
            id: "openai",
            name: "Codex Official",
            origin: "discovered",
            sourceKernel: "codex",
            authConfigured: true,
            routeKind: "login",
            protocol: "native-oauth",
            credentialKind: "native-login",
            models: [{ id: "gpt-5.6", label: "GPT-5.6" }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const firstLoad = loadBridgeSettings(state);
  assert.deepEqual(
    firstLoad.modelProviderBindings,
    [
      { modelId: "native", providerId: LOGIN_PROVIDER_BINDING_ID },
      { modelId: "gpt-5.6", providerId: LOGIN_PROVIDER_BINDING_ID },
    ],
    "legacy Kernel choices must collapse into one default per model",
  );
  const migratedFile = readFileSync(settingsPath, "utf8");
  assert.equal(existsSync(`${settingsPath}.pre-settings-schema-v1.bak`), true);
  assert.doesNotMatch(
    migratedFile,
    /kernelKnowledgeSourceEnabled|kernelProviderBindings|codexWireApi|authConfigured/,
    "persisted settings must contain Provider configuration and activation only, never runtime credential observations",
  );

  const secondLoad = loadBridgeSettings(state);
  assert.deepEqual(secondLoad, firstLoad, "the migration must be idempotent on the next startup");
  assert.equal(readFileSync(settingsPath, "utf8"), migratedFile, "the next startup must not rewrite migrated settings");
} finally {
  rmSync(migrationDirectory, { recursive: true, force: true });
}

const corruptSettingsDirectory = mkdtempSync(join(tmpdir(), "opengrove-provider-corrupt-settings-"));
try {
  const settingsPath = join(corruptSettingsDirectory, "bridge-settings.json");
  const corruptContents = '{"customProviders":[{"id":"must-survive"}';
  const state = {
    store: { kind: "json", path: join(corruptSettingsDirectory, "state.json") },
  } as BridgeState;
  writeFileSync(settingsPath, corruptContents);

  const warnings: unknown[][] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let recovered;
  try {
    recovered = loadBridgeSettings(state);
  } finally {
    console.warn = previousWarn;
  }

  assert.deepEqual(recovered, defaults, "a malformed settings file may start from defaults only after quarantine");
  const corruptBackups = readdirSync(corruptSettingsDirectory).filter(
    (name) => name.startsWith("bridge-settings.json.corrupt-") && name.endsWith(".bak"),
  );
  assert.equal(corruptBackups.length, 1, "a malformed settings file must be quarantined exactly once");
  assert.equal(readFileSync(join(corruptSettingsDirectory, corruptBackups[0]!), "utf8"), corruptContents);
  assert.equal(existsSync(settingsPath), false, "the corrupt source must not remain at the live settings path");
  assert.equal(
    warnings.some(([message]) => message === "bridge_settings_quarantined"),
    true,
    "startup diagnostics must expose the quarantine instead of silently degrading",
  );
  assert.match(
    readFileSync(join(corruptSettingsDirectory, "diagnostics", "problems.jsonl"), "utf8"),
    /"code":"bridge_settings_quarantined"/,
    "the quarantine must remain visible in the persisted diagnostic bundle",
  );

  const futureContents = `${JSON.stringify({
    settingsSchemaVersion: 2,
    customProviders: [{ id: "future-provider", apiKey: "future-secret" }],
  })}\n`;
  writeFileSync(settingsPath, futureContents);
  const futureWarnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => futureWarnings.push(args);
  try {
    assert.deepEqual(
      loadBridgeSettings(state),
      defaults,
      "an older runtime must not normalize and overwrite a newer settings schema",
    );
  } finally {
    console.warn = previousWarn;
  }
  const futureBackup = readdirSync(corruptSettingsDirectory)
    .map((name) => join(corruptSettingsDirectory, name))
    .find(
      (candidate) =>
        candidate.includes("bridge-settings.json.corrupt-") && readFileSync(candidate, "utf8") === futureContents,
    );
  assert.ok(futureBackup, "unsupported future settings must remain recoverable from quarantine");
  assert.equal(
    futureWarnings.some(([message]) => message === "bridge_settings_quarantined"),
    true,
  );
} finally {
  rmSync(corruptSettingsDirectory, { recursive: true, force: true });
}

const codexProviders = [
  {
    id: "openai-local-native",
    name: "OpenAI Official",
    origin: "discovered" as const,
    sourceKernel: "codex" as const,
    enabled: true,
    authConfigured: true,
    routeKind: "provider" as const,
    protocol: "openai-compatible" as const,
    credentialKind: "kernel-native" as const,
    models: [{ id: "gpt-official", label: "GPT Official" }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible" as const,
    enabled: true,
    openaiBaseUrl: "https://api.deepseek.example/v1",
    apiKey: "test-deepseek-key",
    credentialKind: "api-key" as const,
    models: [{ id: "deepseek-v4", label: "DeepSeek V4" }],
  },
];

const normalizedModelDefaults = normalizeBridgeSettingsPatch(
  {
    modelProviderBindings: [
      {
        modelId: "shared-model",
        providerId: "deepseek",
      },
    ],
  },
  defaults,
);
assert.deepEqual(normalizedModelDefaults.modelProviderBindings, [
  {
    modelId: "shared-model",
    providerId: "deepseek",
  },
]);

assert.deepEqual(
  resolveProviderRoute(
    "codex",
    "shared-model",
    LOGIN_PROVIDER_BINDING_ID,
    normalizedModelDefaults.modelProviderBindings,
    codexProviders,
  ),
  {
    providerId: LOGIN_PROVIDER_BINDING_ID,
    source: "employee",
    binding: { kind: "login" },
  },
  "an Employee override must beat model defaults",
);
assert.deepEqual(
  resolveProviderRoute(
    "codex",
    "shared-model",
    undefined,
    normalizedModelDefaults.modelProviderBindings,
    codexProviders,
  ).providerId,
  "deepseek",
  "a model default must select the configured Provider",
);
assert.deepEqual(
  resolveProviderRoute(
    "codex",
    "pending-legacy-model",
    undefined,
    [{ modelId: "pending-legacy-model", providerId: LEGACY_NATIVE_PROVIDER_BINDING_ID }],
    codexProviders,
  ),
  {
    providerId: LEGACY_NATIVE_PROVIDER_BINDING_ID,
    source: "model",
    binding: { kind: "unresolved", status: "selection-required" },
  },
  "an unresolved legacy $native route must render as pending selection rather than a broken Provider id",
);
assert.deepEqual(
  resolveProviderRoute(
    "codex",
    "codex-default",
    undefined,
    normalizedModelDefaults.modelProviderBindings,
    codexProviders,
  ),
  {
    providerId: "$unconfigured",
    source: "unresolved",
    binding: { kind: "unresolved", status: "selection-required" },
  },
  "a Kernel placeholder must not borrow a Provider default from another concrete model",
);
assert.deepEqual(
  resolveProviderRoute("codex", "gpt-official", undefined, [], codexProviders),
  {
    providerId: "$unconfigured",
    source: "unresolved",
    binding: { kind: "unresolved", status: "selection-required" },
  },
  "a discovered Kernel-managed Provider must remain unselected until the user chooses it",
);
assert.deepEqual(
  resolveProviderRoute("codex", "deepseek-v4", undefined, [], codexProviders),
  {
    providerId: "$unconfigured",
    source: "unresolved",
    binding: { kind: "unresolved", status: "selection-required" },
  },
  "an external Provider must also remain unselected without a user model default",
);

const claudeProviders = [
  {
    id: "ww",
    name: "WW",
    protocol: "anthropic-compatible" as const,
    anthropicBaseUrl: "https://ww.example.test",
    apiKey: "ww_sk_test",
    credentialKind: "api-key" as const,
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
  },
  {
    id: "aws-bedrock-api-key",
    name: "AWS Bedrock (API Key)",
    protocol: "anthropic-compatible" as const,
    anthropicBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    apiKey: "ABSKtest",
    credentialKind: "aws" as const,
    models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
  },
  {
    id: "flexible-anthropic",
    name: "Flexible Anthropic",
    protocol: "anthropic-compatible" as const,
    anthropicBaseUrl: "https://flexible.example.test",
    apiKey: "flexible-test-key",
    credentialKind: "api-key" as const,
    modelsPinned: false,
    models: [{ id: "catalog-hint-only", label: "Catalog Hint Only" }],
  },
];
const wwClaudeProviderRoute = resolveProviderRoute("claude-code", "deepseek-v4-flash", "ww", [], claudeProviders);
assert.equal(
  wwClaudeProviderRoute.binding.kind === "provider" ? wwClaudeProviderRoute.binding.status : "unexpected-route-kind",
  "ready",
  "Claude Code must keep WW as an Anthropic-compatible route for its advertised DeepSeek model",
);
const mismatchedClaudeProviderRoute = resolveProviderRoute(
  "claude-code",
  "deepseek-v4-flash",
  "aws-bedrock-api-key",
  [],
  claudeProviders,
);
assert.equal(
  mismatchedClaudeProviderRoute.binding.kind === "provider"
    ? mismatchedClaudeProviderRoute.binding.status
    : "unexpected-route-kind",
  "unsupported",
  "an explicit Provider that does not advertise the selected model must fail before reaching upstream",
);
assert.equal(
  mismatchedClaudeProviderRoute.providerId,
  "aws-bedrock-api-key",
  "an invalid explicit Provider choice must remain visible instead of silently falling back",
);
const flexibleClaudeProviderRoute = resolveProviderRoute(
  "claude-code",
  "deepseek-v4-flash",
  "flexible-anthropic",
  [],
  claudeProviders,
);
assert.equal(
  flexibleClaudeProviderRoute.binding.kind === "provider" ? flexibleClaudeProviderRoute.binding.status : "native",
  "ready",
  "one Provider's catalog must not make another unpinned Provider reject the selected model",
);

const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousDeepSeekKey = process.env.OPENGROVE_DEEPSEEK_API_KEY;
const previousAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
try {
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.OPENGROVE_DEEPSEEK_API_KEY = "deepseek-secret";
  process.env.ANTHROPIC_AUTH_TOKEN = "native-anthropic-secret";
  process.env.ANTHROPIC_BASE_URL = "https://native-anthropic.example";
  const deepSeek = codexProviders[1];
  const deepSeekEnv = providerEnvForKernel("codex", deepSeek, "deepseek-v4");
  const scopedDeepSeekEnv = providerScopedRuntimeEnv(
    { settings: { ...defaults, customProviders: codexProviders } } as BridgeState,
    "codex",
    deepSeek,
    deepSeekEnv,
  );
  assert.equal(scopedDeepSeekEnv.OPENAI_API_KEY, undefined);
  assert.ok(Object.values(scopedDeepSeekEnv).includes("test-deepseek-key"));

  const scopedLoginEnv = providerScopedRuntimeEnv(
    { settings: { ...defaults, customProviders: codexProviders } } as BridgeState,
    "codex",
    undefined,
    undefined,
  );
  assert.equal(scopedLoginEnv.OPENAI_API_KEY, "openai-secret");
  assert.equal(scopedLoginEnv.OPENGROVE_DEEPSEEK_API_KEY, undefined);

  const scopedLoginClaudeEnv = providerScopedRuntimeEnv(
    { settings: { ...defaults, customProviders: codexProviders } } as BridgeState,
    "claude-code",
    undefined,
    undefined,
  );
  assert.equal(scopedLoginClaudeEnv.ANTHROPIC_AUTH_TOKEN, "native-anthropic-secret");
  assert.equal(scopedLoginClaudeEnv.ANTHROPIC_BASE_URL, "https://native-anthropic.example");
} finally {
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousDeepSeekKey === undefined) delete process.env.OPENGROVE_DEEPSEEK_API_KEY;
  else process.env.OPENGROVE_DEEPSEEK_API_KEY = previousDeepSeekKey;
  if (previousAnthropicToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = previousAnthropicToken;
  if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
}

console.log(
  "✓ provider routing keeps Employee > model priority, separates Login from Providers, and migrates legacy settings once",
);
