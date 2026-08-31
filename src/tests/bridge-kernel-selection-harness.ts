import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import { codexProviderConfigFromProfile, createCodexKernelAdapterFromOptions } from "../kernel/adapters/codex.js";
import { createKimiKernelAdapter } from "../kernel/adapters/kimi.js";
import {
  BRIDGE_KERNEL_IDS,
  LOGIN_PROVIDER_BINDING_ID,
  type BridgeKernelId,
  type BridgeProviderProfile,
  type BridgeState,
} from "../server/bridge-types.js";
import { createBridgeState, recreateBridgeApp, shouldDisableRemovedKernelEmployee } from "../server/bridge-state.js";
import {
  defaultBridgeSettings,
  getBridgeSettingsSnapshot,
  normalizeBridgeSettingsPatch,
} from "../server/bridge-settings-store.js";
import {
  BridgeKernelUnavailableError,
  createBridgeKernel,
  getBridgeKernelOptions,
  isBridgeKernelAvailable,
  normalizeBridgeKernelPreference,
  resolveBridgeKernel,
  resolveKernelRuntimeModel,
} from "../server/kernel-selection.js";
import {
  getBridgeKernelDescriptor,
  getKernelContract,
  kernelModelAliasesForProvider,
  kernelModelForProviderSelection,
} from "../server/kernel-registry.js";
import {
  buildBridgeRuntimeControlsForKernel,
  resolveKernelProviderSelection,
  resolveProviderSelectedModelForKernel,
} from "../server/kernel-utils.js";
import { filterPrimaryKnowledgeDocuments } from "../server/knowledge-files.js";
import {
  describeProviderRoute,
  getAllBridgeProviderProfiles,
  getBridgeProviderModelCatalog,
  getBridgeProviderProfiles,
  getBridgeProviderViews,
  normalizeCustomProviderProfiles,
  providerEnvForKernel,
  providerProfileForKernel,
  providerSupportsKernel,
  resolveProviderApiKey,
  resolveProviderForRoute,
} from "../server/provider-profiles.js";
import { providerRuntimeState } from "../server/provider-state.js";
import {
  normalizeAnthropicModelsResponse,
  normalizeOpenAiModelsResponse,
  readDiscoveredProviderModels,
  refreshProviderModelDiscovery,
} from "../server/provider-model-discovery.js";
import { normalizeCodexModelId } from "../runtime/codex/policy.js";
import { codexResponsesChatProxyStatus } from "../runtime/codex/responses-chat-proxy.js";
import { resolveClaudeCodeCliPath } from "../runtime/claude-code-runtime.js";
import { readKernelLocalRouteProfile } from "../server/kernel-registry.js";
import {
  activateLegacyProviderReferences,
  applyProviderSetupMigration,
  providerProfileFromLocalRoute,
} from "../server/system-provider-discovery.js";
import { providerBindingFingerprint } from "../server/provider-binding.js";
import { resolveSystemEmployeeRuntime } from "../server/system-employee-runtime.js";
import { PM_AGENT_SKILL_NAME } from "../server/bridge-mounted-app-employees.js";
import { normalizeMember as normalizeRoomMember } from "../rooms/channel-normalize.js";
import { OPENGROVE_PM_MEMBER_ID, pmAgentMemberId } from "../rooms/room-pm.js";
import {
  resolveRoomExecutionTarget,
  resolveRoomTargetModel,
  resolveRoomTargetProviderRoute,
} from "../server/room-runs/execution-state.js";
import { withEnv } from "./env.js";
import { migrateMountedAppManifestV1 } from "../server/migrations/app-manifest-v1.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-bridge-kernel-"));
  for (const kernelId of ["codex", "claude-code", "hermes", "opencode", "kimi"] as const) {
    assert.equal(
      getKernelContract(kernelId).labels.unavailableReason,
      undefined,
      `${kernelId} must use the Host-localized generic runtime-unavailable message`,
    );
  }
  assert.match(getKernelContract("openclaw").labels.unavailableReason ?? "", /OPENCLAW_GATEWAY_URL/);
  assert.match(getKernelContract("pi").labels.unavailableReason ?? "", /API key/);
  const preAppState = {
    get app() {
      throw new Error("bridge_app_not_initialized");
    },
    appInitialized: false,
    kernel: "claude-code",
    model: "claude-opus-4-8",
    settings: defaultBridgeSettings(),
  } as unknown as BridgeState;
  assert.doesNotThrow(
    () => resolveKernelProviderSelection(preAppState, "codex"),
    "cold-start Provider discovery must not read the Bridge app before initialization completes",
  );
  await withEnv({ [appEnvName("KERNEL")]: undefined }, async () => {
    assert.equal(
      defaultBridgeSettings().kernel,
      "claude-code",
      "new installations must default to the bundled Claude Kernel",
    );
  });
  await withEnv({ [appEnvName("VOLC_CODING_API_KEY")]: undefined }, async () => {
    const profile = getAllBridgeProviderProfiles(undefined).find((provider) => provider.id === "volc-coding-plan");
    const view = getBridgeProviderViews(undefined).find((provider) => provider.id === "volc-coding-plan");
    assert.equal(
      profile?.authConfigured,
      undefined,
      "the Provider directory must not contain derived credential state",
    );
    assert.equal(view?.runtime.credential.status, "missing");
    assert.equal(view?.runtime.active, false, "a built-in Provider must remain inactive until the user enables it");
  });
  await withEnv({ [appEnvName("VOLC_CODING_API_KEY")]: "configured-test-key" }, async () => {
    const preset = getBridgeProviderProfiles().find((provider) => provider.id === "volc-coding-plan");
    assert.ok(preset);
    const view = getBridgeProviderViews(undefined).find((provider) => provider.id === "volc-coding-plan");
    assert.equal(view?.runtime.credential.configured, true, "the read model must resolve environment credentials live");
    assert.equal(view?.runtime.active, false, "credential discovery must not activate a Provider");
    assert.equal(view?.runtime.usable, false);
    const patched = normalizeBridgeSettingsPatch(
      {
        customProviders: [{ ...preset, custom: true, enabled: true, authConfigured: false }],
      },
      defaultBridgeSettings(),
    );
    assert.equal(
      patched.customProviders[0]?.authConfigured,
      undefined,
      "renderer settings writes must discard derived credential observations",
    );
    const activated = getBridgeProviderViews(patched.customProviders).find(
      (provider) => provider.id === "volc-coding-plan",
    );
    assert.equal(activated?.runtime.active, true);
    assert.equal(
      activated?.runtime.credential.configured,
      true,
      "a stale renderer boolean must not hide a newly available credential",
    );
    assert.equal(activated?.runtime.usable, true);
  });
  for (const providerId of ["aws-bedrock-api-key", "google-vertex"] as const) {
    const preset = getBridgeProviderProfiles().find((provider) => provider.id === providerId);
    assert.ok(preset);
    const runtime = providerRuntimeState({ ...preset, custom: true, enabled: true });
    assert.deepEqual(
      {
        active: runtime.active,
        usable: runtime.usable,
        credentialStatus: runtime.credential.status,
        credentialSource: runtime.credential.source,
      },
      {
        active: true,
        usable: true,
        credentialStatus: "not-required",
        credentialSource: "ambient",
      },
      `${providerId} must defer credential validation to its ambient SDK credential chain`,
    );
  }
  const persistedGatewayProvider = normalizeCustomProviderProfiles([
    {
      id: "openclaw-gateway-openai",
      name: "Gateway OpenAI",
      protocol: "custom-gateway",
      custom: true,
      enabled: true,
      origin: "discovered",
      sourceKernel: "openclaw",
      credentialKind: "gateway-managed",
      models: [{ id: "openai/gpt-5.5", label: "GPT-5.5" }],
    },
  ])[0];
  assert.ok(persistedGatewayProvider);
  assert.equal(
    providerRuntimeState(persistedGatewayProvider).usable,
    true,
    "a last-known Gateway catalog must remain usable while an optional refresh is unavailable",
  );
  const persistedGatewayRoute = describeProviderRoute(
    "openclaw",
    persistedGatewayProvider.id,
    [persistedGatewayProvider],
    "openai/gpt-5.5",
  );
  assert.equal(
    persistedGatewayRoute.kind === "provider" ? persistedGatewayRoute.status : undefined,
    "ready",
    "Gateway-managed routes must not depend on a persisted authConfigured observation",
  );
  const employeeReferencedPreset = activateLegacyProviderReferences(
    { ...defaultBridgeSettings(), providerSetupVersion: 3 },
    ["anthropic"],
  );
  assert.equal(
    employeeReferencedPreset.customProviders.find((provider) => provider.id === "anthropic")?.enabled,
    true,
    "the one-time upgrade must materialize an Employee-referenced built-in Provider",
  );
  const fakeHermes = writeFakeCli(
    cwd,
    "fake-hermes",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "hermes-fake 0.0.0"',
      "  exit 0",
      "fi",
      'echo "bridge hermes ok"',
    ],
    ["@echo off", 'if "%~1"=="--version" (', "  echo hermes-fake 0.0.0", "  exit /b 0", ")", "echo bridge hermes ok"],
  );

  const fakeCodex = writeFakeCli(
    cwd,
    "fake-codex",
    ["#!/bin/sh", 'if [ "$1" = "--version" ]; then', '  echo "codex-fake 0.0.0"', "  exit 0", "fi", 'echo "{}"'],
    ["@echo off", 'if "%~1"=="--version" (', "  echo codex-fake 0.0.0", "  exit /b 0", ")", "echo {}"],
  );

  const fakeClaude = writeFakeCli(
    cwd,
    "fake-claude",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "claude-fake 0.0.0"',
      "  exit 0",
      "fi",
      'echo \'{"type":"result","result":"claude fake ok","is_error":false}\'',
    ],
    [
      "@echo off",
      'if "%~1"=="--version" (',
      "  echo claude-fake 0.0.0",
      "  exit /b 0",
      ")",
      'echo {"type":"result","result":"claude fake ok","is_error":false}',
    ],
  );

  const fakeAuthenticatedClaude = writeFakeCli(
    cwd,
    "fake-authenticated-claude",
    [
      "#!/bin/sh",
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  echo \'{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}\'',
      "  exit 0",
      "fi",
      'echo "claude-fake 0.0.0"',
    ],
    [
      "@echo off",
      'if "%~1"=="auth" if "%~2"=="status" (',
      '  echo {"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}',
      "  exit /b 0",
      ")",
      "echo claude-fake 0.0.0",
    ],
  );

  const coldStartConfigRoot = join(cwd, "cold-start-config");
  const coldStartSettingsPath = join(cwd, "cold-start-settings.json");
  mkdirSync(coldStartConfigRoot, { recursive: true });
  writeFileSync(
    join(coldStartConfigRoot, ".claude.json"),
    `${JSON.stringify({ hasCompletedOnboarding: true, numStartups: 1 })}\n`,
    "utf8",
  );
  await withEnv(
    {
      HOME: coldStartConfigRoot,
      CLAUDE_CONFIG_DIR: join(coldStartConfigRoot, "claude-code"),
      [appEnvName("BRIDGE_SETTINGS_PATH")]: coldStartSettingsPath,
      [appEnvName("CODEX_BIN")]: undefined,
      [appEnvName("HERMES_BIN")]: undefined,
      [appEnvName("WW_API_KEY")]: undefined,
      [appEnvName("VOLC_CODING_API_KEY")]: undefined,
      [appEnvName("ANTHROPIC_API_KEY")]: undefined,
      [appEnvName("ANTHROPIC_AUTH_TOKEN")]: undefined,
      [appEnvName("OPENCLAW_GATEWAY_URL")]: undefined,
      [appEnvName("OPENCLAW_WS_URL")]: undefined,
      [appEnvName("OPENCLAW_GATEWAY_TOKEN")]: undefined,
      [appEnvName("OPENCLAW_TOKEN")]: undefined,
      OPENAI_API_KEY: undefined,
      MODEL_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_WS_URL: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_SESSION_KEY: undefined,
      AWS_BEARER_TOKEN_BEDROCK: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
    },
    async () => {
      const coldStartSettings = {
        ...defaultBridgeSettings(),
        // Persist the retired value to prove the settings migration selects the bundled Claude Kernel.
        kernel: "auto" as const,
        customProviders: [],
        kernelPathOverrides: Object.fromEntries(
          BRIDGE_KERNEL_IDS.map((kernelId) => [
            kernelId,
            {
              binaryPath: kernelId === "claude-code" ? fakeClaude : join(cwd, `missing-${kernelId}`),
              configHome: join(coldStartConfigRoot, kernelId),
            },
          ]),
        ),
      };
      writeFileSync(coldStartSettingsPath, `${JSON.stringify(coldStartSettings, null, 2)}\n`, "utf8");

      const coldStartState = createBridgeState({ statePath: join(cwd, "cold-start-state.json") });
      const preAppState = { ...coldStartState, appInitialized: false };
      Object.defineProperty(preAppState, "app", {
        configurable: true,
        get() {
          throw new Error("bridge_app_not_initialized");
        },
      });
      assert.doesNotThrow(
        () => getBridgeKernelOptions(preAppState),
        "kernel discovery during cold start must not read the App before it is initialized",
      );
      assert.equal(coldStartState.settings.kernel, "claude-code");
      assert.equal(coldStartState.kernel, "claude-code");
      assert.equal(coldStartState.kernelUnavailableCode, "provider_selection_required");
      assert.match(coldStartState.kernelUnavailableReason ?? "", /(?:credential|provider|\u51ed\u636e)/i);
      assert.equal(coldStartState.kernelCapabilities?.streaming, false);
      assert.equal(
        getBridgeKernelOptions(coldStartState).some((option) => option.id === "auto"),
        false,
        "the retired automatic Kernel option must not enter the runtime settings model",
      );

      coldStartState.settings.kernel = "claude-code";
      recreateBridgeApp(coldStartState);
      const unavailableClaude = getBridgeKernelOptions(coldStartState).find((option) => option.id === "claude-code");
      assert.equal(unavailableClaude?.active, true);
      assert.equal(unavailableClaude?.available, false);
      assert.equal(unavailableClaude?.unavailableCode, "provider_selection_required");
      assert.equal(coldStartState.kernelUnavailableCode, "provider_selection_required");
      assert.match(
        coldStartState.kernelUnavailableReason ?? "",
        /(?:credential|provider|\u51ed\u636e)/i,
        "an explicitly selected kernel without a provider must keep the desktop bootable",
      );
      assert.throws(
        () => createBridgeKernel(coldStartState),
        (error) =>
          error instanceof BridgeKernelUnavailableError &&
          error.code === "provider_selection_required" &&
          /(?:select|choose|provider|credential|\u9009择|\u51ed据)/i.test(error.message),
        "worker creation must fail with selection-required before adapter creation",
      );
      coldStartState.settings.languagePreference = "zh-CN";
      assert.throws(
        () => createBridgeKernel(coldStartState),
        (error) =>
          error instanceof BridgeKernelUnavailableError &&
          error.code === "provider_selection_required" &&
          /Claude Agent 当前不可用/.test(error.message) &&
          !/is not available/i.test(error.message),
        "kernel route failures must localize the complete message instead of retaining an English prefix",
      );
      coldStartState.settings.languagePreference = "en";
      coldStartState.settings.modelProviderBindings = [
        {
          modelId: coldStartState.model,
          providerId: "missing-provider",
        },
      ];
      assert.throws(
        () => createBridgeKernel(coldStartState),
        (error) =>
          error instanceof BridgeKernelUnavailableError &&
          error.code === "provider_not_found" &&
          /missing-provider|no longer exists|choose a provider/i.test(error.message),
        "worker creation must reject an unavailable concrete Provider before adapter creation",
      );
      const coldStartClaudeModel = coldStartState.model;
      const unavailableCodexHome = join(coldStartConfigRoot, "codex-login-unavailable");
      mkdirSync(unavailableCodexHome, { recursive: true });
      coldStartState.settings.kernel = "codex";
      coldStartState.model = "codex-default";
      coldStartState.settings.kernelPathOverrides.codex = {
        binaryPath: fakeCodex,
        configHome: unavailableCodexHome,
      };
      coldStartState.settings.modelProviderBindings = [
        {
          modelId: coldStartState.model,
          providerId: LOGIN_PROVIDER_BINDING_ID,
        },
      ];
      assert.throws(
        () => createBridgeKernel(coldStartState),
        (error) => {
          assert.ok(error instanceof BridgeKernelUnavailableError);
          assert.equal(error.code, "kernel_provider_unavailable");
          assert.match(error.message, /Login.*not available|\u767b录.*不可用/i);
          return true;
        },
        "worker creation must reject an unavailable Login before adapter creation",
      );
      coldStartState.settings.kernel = "claude-code";
      coldStartState.model = coldStartClaudeModel;
      coldStartState.settings.modelProviderBindings = [];

      await withEnv(
        {
          [appEnvName("WW_BASE_URL")]: "https://ww.example.test",
          [appEnvName("WW_API_KEY")]: "ww_sk_cold_start_test",
        },
        async () => {
          coldStartState.settings.kernel = "claude-code";
          coldStartState.model = "claude-opus-4-8";
          coldStartState.settings.modelProviderBindings = [
            {
              modelId: coldStartState.model,
              providerId: "ww",
            },
          ];
          const wwPreset = getBridgeProviderProfiles().find((provider) => provider.id === "ww");
          assert.ok(wwPreset);
          coldStartState.settings.customProviders = [{ ...wwPreset, custom: true, enabled: true }];
          recreateBridgeApp(coldStartState);
        },
      );
      assert.equal(coldStartState.kernel, "claude-code");
      assert.equal(coldStartState.kernelUnavailableReason, undefined);
      assert.equal(coldStartState.kernelCapabilities?.streaming, true);
    },
  );

  await withEnv(
    {
      [appEnvName("HERMES_BIN")]: fakeHermes,
      [appEnvName("DATA_DIR")]: join(cwd, "opengrove-data"),
      [appEnvName("CODEX_BIN")]: fakeCodex,
      [appEnvName("BRIDGE_SETTINGS_PATH")]: join(cwd, "bridge-settings.json"),
      [appEnvName("VOLC_CODING_API_KEY")]: "test-key",
      [appEnvName("WW_BASE_URL")]: "https://ww.example.test",
      [appEnvName("WW_API_KEY")]: "ww_sk_test",
      [appEnvName("CLAUDE_CLI_PATH")]: fakeClaude,
      OPENAI_API_KEY: "openai-test-key",
      ANTHROPIC_AUTH_TOKEN: "anthropic-test-key",
    },
    async () => {
      assert.equal(
        resolveClaudeCodeCliPath(cwd),
        fakeClaude,
        "bridge kernel selection harness must use its per-harness Claude stub",
      );

      const claudeHome = join(cwd, "claude-home");
      mkdirSync(claudeHome, { recursive: true });
      writeFileSync(
        join(claudeHome, "settings.json"),
        `${JSON.stringify({
          env: {
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_REGION: "us-east-1",
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
          },
          model: "opus",
        })}\n`,
        "utf8",
      );
      const staleBedrockApiKeyProvider: BridgeProviderProfile = {
        id: "aws-bedrock-api-key",
        name: "AWS Bedrock (API Key)",
        custom: true,
        origin: "discovered",
        sourceKernel: "claude-code",
        authConfigured: true,
        protocol: "anthropic-compatible",
        credentialKind: "aws",
        anthropicBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [{ id: "opus", label: "Opus" }],
      };
      const discoveredBedrockSettings = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        kernelPathOverrides: {
          "claude-code": { configHome: claudeHome },
        },
        customProviders: [staleBedrockApiKeyProvider],
      });
      const modelBoundPresetSettings = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        providerSetupVersion: 2,
        modelProviderBindings: [{ modelId: "deepseek-v4", providerId: "deepseek" }],
      });
      assert.equal(
        modelBoundPresetSettings.customProviders.find((provider) => provider.id === "deepseek")?.enabled,
        true,
        "the setup migration must keep a model-bound built-in Provider active",
      );
      const discoveredBedrockIds = discoveredBedrockSettings.customProviders
        .filter((provider) => provider.sourceKernel === "claude-code" && provider.id.includes("aws-bedrock"))
        .map((provider) => provider.id);
      assert.deepEqual(
        discoveredBedrockIds,
        [],
        "Host settings must discard Providers scanned from Claude Code configuration",
      );
      const discoveredBedrockProfiles = getAllBridgeProviderProfiles(discoveredBedrockSettings.customProviders);
      assert.equal(
        discoveredBedrockProfiles.some((provider) => provider.id === "aws-bedrock"),
        false,
        "a Kernel-scanned Provider must not enter the Host Provider directory",
      );
      assert.equal(
        discoveredBedrockProfiles.some((provider) => provider.id === "aws-bedrock-api-key"),
        true,
        "the explicit OpenGrove Bedrock catalog entry remains available through Add Provider",
      );
      const userBedrockSettings = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        kernelPathOverrides: {
          "claude-code": { configHome: claudeHome },
        },
        customProviders: [
          {
            ...staleBedrockApiKeyProvider,
            origin: "user",
            apiKey: "ABSKinline-bedrock-test-key",
          },
        ],
      });
      assert.ok(
        userBedrockSettings.customProviders.some(
          (provider) => provider.id === "aws-bedrock-api-key" && provider.origin === "user",
        ),
        "User-created AWS Bedrock providers should not be removed as stale discovered aliases",
      );
      assert.equal(
        getAllBridgeProviderProfiles(userBedrockSettings.customProviders).some(
          (provider) => provider.id === "aws-bedrock-api-key" && provider.origin === "user",
        ),
        true,
        "User-created AWS Bedrock API key providers should still be listed",
      );
      const removedScannedRouteSettings = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        kernel: "claude-code",
        modelProviderBindings: [{ modelId: "claude-opus-4-8", providerId: "aws-bedrock" }],
        customProviders: [{ ...staleBedrockApiKeyProvider, id: "aws-bedrock" }],
      });
      assert.equal(
        removedScannedRouteSettings.customProviders.some((provider) => provider.id === "aws-bedrock"),
        false,
        "upgrading must remove previously persisted Kernel-scanned Providers",
      );
      assert.equal(
        removedScannedRouteSettings.modelProviderBindings.some((binding) => binding.providerId === "aws-bedrock"),
        false,
        "upgrading must remove model defaults that pointed at a retired Kernel-scanned Provider",
      );

      const hermesHome = join(cwd, "hermes-home");
      mkdirSync(hermesHome, { recursive: true });
      writeFileSync(
        join(hermesHome, "config.yaml"),
        [
          "model:",
          '  provider: "volcengine"',
          '  default: "glm-5.1"',
          '  base_url: "https://ark.cn-beijing.volces.com/api/coding/v3"',
          '  api_mode: "chat_completions"',
          `  key_env: "${appEnvName("VOLC_CODING_API_KEY")}"`,
          "providers:",
          '  "volcengine":',
          '    name: "Volcengine Ark"',
          "    models:",
          '      "glm-5.1": {}',
          '      "minimax-m2.7": {}',
        ].join("\n"),
        "utf8",
      );
      const hermesNative = readKernelLocalRouteProfile("hermes", { configHome: hermesHome });
      const hermesProvider = providerProfileFromLocalRoute(hermesNative);
      assert.ok(hermesProvider, "Hermes Kernel configuration must materialize as a concrete Provider");
      assert.equal(hermesProvider.routeKind, "provider");
      assert.equal(hermesNative?.providerId, "volcengine");
      assert.equal(hermesNative?.providerLabel, "Volcengine Ark");
      assert.equal(hermesNative?.baseUrl, "https://ark.cn-beijing.volces.com/api/coding/v3");
      assert.equal(hermesNative?.apiKeyEnv, appEnvName("VOLC_CODING_API_KEY"));
      assert.equal(hermesNative?.authConfigured, true);
      assert.equal(hermesNative?.defaultModel, "glm-5.1");
      assert.deepEqual(
        hermesNative?.models.map((model) => model.id),
        ["glm-5.1", "minimax-m2.7"],
      );

      const codexAuthHome = join(cwd, "codex-auth-home");
      mkdirSync(codexAuthHome, { recursive: true });
      writeFileSync(join(codexAuthHome, "auth.json"), "{}\n", "utf8");
      await withEnv({ OPENAI_API_KEY: undefined }, async () => {
        assert.equal(
          readKernelLocalRouteProfile("codex", { configHome: codexAuthHome })?.authConfigured,
          false,
          "An empty Codex auth file must not count as an available provider",
        );
        writeFileSync(
          join(codexAuthHome, "auth.json"),
          `${JSON.stringify({ tokens: { access_token: "test-token" } })}\n`,
          "utf8",
        );
        assert.equal(
          readKernelLocalRouteProfile("codex", { configHome: codexAuthHome })?.authConfigured,
          true,
          "Codex account credentials should make its Login route available",
        );
        writeFileSync(join(codexAuthHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
        const namedOpenAiLogin = readKernelLocalRouteProfile("codex", { configHome: codexAuthHome });
        assert.equal(namedOpenAiLogin?.routeKind, "login");
        assert.equal(
          namedOpenAiLogin?.authConfigured,
          true,
          "Codex model_provider=openai must keep using an existing ChatGPT Login when no external endpoint/key is configured",
        );
      });

      const piAuthHome = join(cwd, "pi-auth-home");
      mkdirSync(join(piAuthHome, "agent"), { recursive: true });
      writeFileSync(join(piAuthHome, "agent", "auth.json"), "{}\n", "utf8");
      await withEnv(
        {
          OPENAI_API_KEY: undefined,
          MODEL_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("pi", { configHome: piAuthHome })?.authConfigured,
            false,
            "An empty Pi auth file must not count as an available provider",
          );
          const clearedPiDiscovery = applyProviderSetupMigration({
            ...defaultBridgeSettings(),
            kernelPathOverrides: { pi: { configHome: piAuthHome } },
            modelProviderBindings: [{ modelId: "pi-default", providerId: "pi-native" }],
            customProviders: [
              {
                id: "pi-native",
                name: "Pi",
                custom: true,
                origin: "discovered",
                sourceKernel: "pi",
                authConfigured: true,
                routeKind: "provider",
                protocol: "openai-compatible",
                credentialKind: "kernel-native",
                models: [],
              },
            ],
          });
          assert.equal(
            clearedPiDiscovery.customProviders.some((provider) => provider.sourceKernel === "pi"),
            false,
            "A stale discovered Provider must be removed when its source configuration no longer exists",
          );
          assert.equal(
            clearedPiDiscovery.modelProviderBindings.some((binding) => binding.providerId === "pi-native"),
            false,
            "retiring Kernel Provider scanning must remove its now-invalid model defaults",
          );
          const preservedPiTombstone = applyProviderSetupMigration({
            ...defaultBridgeSettings(),
            kernelPathOverrides: { pi: { configHome: piAuthHome } },
            customProviders: [
              {
                id: "pi-native",
                name: "Pi",
                custom: true,
                deleted: true,
                origin: "discovered",
                sourceKernel: "pi",
                authConfigured: false,
                routeKind: "provider",
                protocol: "openai-compatible",
                credentialKind: "kernel-native",
                models: [],
              },
            ],
          });
          assert.equal(
            preservedPiTombstone.customProviders.some(
              (provider) => provider.id === "pi-native" && provider.deleted === true,
            ),
            false,
            "obsolete Kernel-scanned Provider tombstones must leave the Host settings collection",
          );
          const piWithoutRuntimeCredentials = createBridgeState({
            statePath: join(cwd, "pi-without-runtime-credentials-state.json"),
          });
          piWithoutRuntimeCredentials.settings = {
            ...defaultBridgeSettings(),
            kernel: "pi",
            kernelPathOverrides: { pi: { configHome: piAuthHome } },
            modelProviderBindings: [{ modelId: "pi-default", providerId: "pi-native-test" }],
            customProviders: [
              {
                id: "pi-native-test",
                name: "Pi native test",
                custom: true,
                enabled: true,
                origin: "user",
                sourceKernel: "pi",
                authConfigured: true,
                routeKind: "provider",
                protocol: "openai-compatible",
                credentialKind: "kernel-native",
                models: [{ id: "pi-default", label: "Pi Default" }],
              },
            ],
          };
          piWithoutRuntimeCredentials.kernel = "pi";
          piWithoutRuntimeCredentials.model = "pi-default";
          assert.throws(
            () => resolveBridgeKernel("pi", piWithoutRuntimeCredentials),
            (error: unknown) => {
              assert.ok(error instanceof BridgeKernelUnavailableError);
              assert.match(error.message, /No usable API key is configured for Pi/);
              return true;
            },
            "Pi runtime failures must retain the contract's credential-specific diagnosis",
          );
        },
      );

      const openCodeHome = join(cwd, "opencode-home");
      mkdirSync(openCodeHome, { recursive: true });
      writeFileSync(
        join(openCodeHome, "opencode.json"),
        `${JSON.stringify({ $schema: "https://opencode.ai/config.json" })}\n`,
        "utf8",
      );
      assert.equal(
        readKernelLocalRouteProfile("opencode", { configHome: openCodeHome })?.authConfigured,
        false,
        "An OpenCode settings file without credentials must not count as a provider",
      );
      writeFileSync(
        join(openCodeHome, "auth.json"),
        `${JSON.stringify({ google: { type: "api", key: "test-key" } })}\n`,
        "utf8",
      );
      const openCodeNative = readKernelLocalRouteProfile("opencode", { configHome: openCodeHome });
      assert.equal(openCodeNative?.authConfigured, true);
      assert.equal(openCodeNative?.providerLabel, "Google");
      const rediscoveredOpenCode = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        kernelPathOverrides: { opencode: { configHome: openCodeHome } },
        customProviders: [
          {
            id: "opencode-native",
            name: "OpenCode",
            custom: true,
            origin: "discovered",
            sourceKernel: "opencode",
            authConfigured: true,
            routeKind: "provider",
            protocol: "openai-compatible",
            credentialKind: "kernel-native",
            models: [],
          },
        ],
      });
      assert.deepEqual(
        rediscoveredOpenCode.customProviders
          .filter((provider) => provider.sourceKernel === "opencode")
          .map((provider) => provider.id),
        [],
        "OpenCode credentials must not be imported as OpenGrove Providers",
      );
      writeFileSync(
        join(openCodeHome, "auth.json"),
        `${JSON.stringify({ anthropic: { type: "api", key: "test-key" } })}\n`,
        "utf8",
      );
      const switchedOpenCode = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        kernelPathOverrides: { opencode: { configHome: openCodeHome } },
        customProviders: [
          {
            id: "google",
            name: "Google",
            custom: true,
            deleted: true,
            origin: "discovered",
            sourceKernel: "opencode",
            authConfigured: false,
            routeKind: "provider",
            protocol: "openai-compatible",
            credentialKind: "kernel-native",
            models: [],
          },
        ],
      });
      assert.equal(
        switchedOpenCode.customProviders.some((provider) => provider.id === "google" && provider.deleted === true),
        false,
        "old Kernel-scanned tombstones are removed with the retired discovery path",
      );
      assert.equal(
        switchedOpenCode.customProviders.some(
          (provider) => provider.id === "opencode-anthropic" && provider.deleted !== true,
        ),
        false,
        "switching OpenCode credentials must not mutate the Host Provider list",
      );

      const kimiHome = join(cwd, "kimi-home");
      mkdirSync(kimiHome, { recursive: true });
      writeFileSync(join(kimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n', "utf8");
      assert.equal(
        readKernelLocalRouteProfile("kimi", { configHome: kimiHome })?.authConfigured,
        false,
        "Kimi model configuration without credentials must not count as a provider",
      );
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(
        join(kimiHome, "credentials", "kimi-code.json"),
        `${JSON.stringify({ access_token: "expired-test-token", expires_at: 1 })}\n`,
        "utf8",
      );
      assert.equal(
        readKernelLocalRouteProfile("kimi", { configHome: kimiHome })?.authConfigured,
        false,
        "An expired Kimi access token without a refresh token must not count as available",
      );
      writeFileSync(
        join(kimiHome, "credentials", "kimi-code.json"),
        `${JSON.stringify({ access_token: "expired-test-token", refresh_token: "test-refresh-token", expires_at: 1 })}\n`,
        "utf8",
      );
      const kimiNative = readKernelLocalRouteProfile("kimi", { configHome: kimiHome });
      assert.equal(kimiNative?.authConfigured, true);
      assert.deepEqual(
        kimiNative?.models.map((model) => model.id),
        ["kimi-code/kimi-for-coding"],
      );

      const claudeAuthHome = join(cwd, "claude-auth-home");
      mkdirSync(claudeAuthHome, { recursive: true });
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: "incomplete-access-key",
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_CONFIG_FILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            false,
            "An AWS access key id without a secret must not make Claude available",
          );
        },
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: "bedrock-profile",
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_CONFIG_FILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            false,
            "An AWS profile must not authenticate Claude unless Bedrock mode is enabled",
          );
        },
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: "missing-bedrock-profile",
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_CONFIG_FILE: join(cwd, "missing-aws-config"),
          AWS_SHARED_CREDENTIALS_FILE: join(cwd, "missing-aws-credentials"),
          CLAUDE_CODE_USE_BEDROCK: "1",
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            false,
            "A missing AWS profile must not make enabled Claude Bedrock available",
          );
        },
      );
      const awsConfigPath = join(cwd, "aws-config");
      writeFileSync(
        awsConfigPath,
        "[profile bedrock-profile]\nregion = us-west-2\ncredential_process = test-credential-provider\n",
        "utf8",
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: "bedrock-profile",
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_CONFIG_FILE: awsConfigPath,
          AWS_SHARED_CREDENTIALS_FILE: join(cwd, "missing-aws-credentials"),
          CLAUDE_CODE_USE_BEDROCK: "1",
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            true,
            "An AWS profile from the process environment should make enabled Claude Bedrock available",
          );
        },
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: join(cwd, "missing-web-identity-token"),
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test-role",
          AWS_CONFIG_FILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          CLAUDE_CODE_USE_BEDROCK: "1",
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            false,
            "A missing web identity token file must not make Claude Bedrock available",
          );
        },
      );
      const webIdentityTokenPath = join(cwd, "web-identity-token");
      writeFileSync(webIdentityTokenPath, "test-token\n", "utf8");
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: webIdentityTokenPath,
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test-role",
          AWS_CONFIG_FILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          CLAUDE_CODE_USE_BEDROCK: "1",
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            true,
            "An existing web identity token file with a role should make Claude Bedrock available",
          );
        },
      );
      const googleApplicationCredentials = join(cwd, "google-application-credentials.json");
      writeFileSync(googleApplicationCredentials, "{}\n", "utf8");
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_PROFILE: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials,
          GOOGLE_CLOUD_PROJECT: "project-with-adc",
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            true,
            "An existing Google application credentials file should make Claude Vertex available",
          );
        },
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: "project-without-adc",
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", {
              binaryPath: fakeClaude,
              cwd,
              configHome: claudeAuthHome,
            })?.authConfigured,
            false,
            "A Google Cloud project without ADC must not make Claude available",
          );
        },
      );
      await withEnv(
        {
          HOME: join(cwd, "isolated-claude-home"),
          [appEnvName("CLAUDE_CLI_PATH")]: fakeAuthenticatedClaude,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_BEARER_TOKEN_BEDROCK: undefined,
          AWS_PROFILE: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_CONFIG_FILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_VERTEX: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
        },
        async () => {
          assert.equal(
            readKernelLocalRouteProfile("claude-code", { cwd, configHome: claudeAuthHome })?.authConfigured,
            true,
            "Claude Code auth status should recognize a real CLI login",
          );
        },
      );

      const openClawHome = join(cwd, "openclaw-home");
      mkdirSync(openClawHome, { recursive: true });
      writeFileSync(join(openClawHome, "openclaw.json"), "{}\n", "utf8");
      assert.equal(
        readKernelLocalRouteProfile("openclaw", { configHome: openClawHome })?.authConfigured,
        false,
        "An OpenClaw gateway config without a provider credential must not count as a provider",
      );
      mkdirSync(join(openClawHome, "agents", "main", "agent"), { recursive: true });
      writeFileSync(
        join(openClawHome, "agents", "main", "agent", "auth-profiles.json"),
        `${JSON.stringify({ profiles: { "openai-codex:default": { type: "oauth", access: "test-token" } } })}\n`,
        "utf8",
      );
      const openClawNative = readKernelLocalRouteProfile("openclaw", { configHome: openClawHome });
      assert.equal(
        openClawNative?.authConfigured,
        false,
        "OpenClaw auth files do not constitute a Login route; Gateway discovery owns Provider readiness",
      );
      assert.equal(openClawNative?.routeKind, "provider");
      assert.equal(openClawNative?.providerLabel, "OpenAI Codex");

      const prunedLegacyOpenClaw = applyProviderSetupMigration({
        ...defaultBridgeSettings(),
        customProviders: [
          {
            id: "openclaw-openai-codex",
            name: "OpenAI Codex",
            custom: true,
            origin: "discovered",
            sourceKernel: "openclaw",
            authConfigured: true,
            routeKind: "provider",
            protocol: "openai-compatible",
            credentialKind: "kernel-native",
            models: [],
          },
          {
            id: "openclaw-gateway-openai",
            name: "OpenAI",
            custom: true,
            origin: "discovered",
            sourceKernel: "openclaw",
            authConfigured: true,
            routeKind: "provider",
            protocol: "custom-gateway",
            credentialKind: "gateway-managed",
            models: [],
          },
        ],
      });
      assert.equal(
        prunedLegacyOpenClaw.customProviders.some((provider) => provider.id === "openclaw-openai-codex"),
        false,
        "0.6.1 OpenClaw local-auth discovery rows must be pruned instead of remaining selectable orphans",
      );
      assert.equal(
        prunedLegacyOpenClaw.customProviders.some((provider) => provider.id === "openclaw-gateway-openai"),
        true,
        "current Gateway-managed OpenClaw Providers must survive legacy cleanup",
      );

      const openClawModel = "openai/gpt-test";
      const openClawProvider: BridgeProviderProfile = {
        id: "openclaw-gateway-openai",
        name: "OpenAI",
        custom: true,
        enabled: true,
        origin: "discovered",
        sourceKernel: "openclaw",
        source: "OpenClaw Gateway",
        authConfigured: true,
        routeKind: "provider",
        protocol: "custom-gateway",
        credentialKind: "gateway-managed",
        modelsPinned: false,
        models: [{ id: openClawModel, label: "GPT Test" }],
      };
      const providerRouteSettings = {
        ...defaultBridgeSettings(),
        customProviders: [openClawProvider],
        modelProviderBindings: [
          {
            modelId: "pi-default",
            providerId: "pi-openai",
          },
          {
            modelId: openClawModel,
            providerId: openClawProvider.id,
          },
        ],
        kernelPathOverrides: {
          pi: { configHome: piAuthHome },
          openclaw: { configHome: join(cwd, "openclaw-gateway-only") },
        },
      };
      await withEnv(
        {
          OPENAI_API_KEY: "pi-environment-key",
          [appEnvName("OPENCLAW_GATEWAY_URL")]: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
        },
        async () => {
          const piState = createBridgeState({
            statePath: join(cwd, "pi-environment-state.json"),
          });
          piState.settings = applyProviderSetupMigration({ ...providerRouteSettings, kernel: "pi" });
          piState.model = "pi-default";
          recreateBridgeApp(piState);
          const piOption = getBridgeKernelOptions(piState).find((option) => option.id === "pi");
          assert.equal(
            piState.settings.customProviders.some((provider) => provider.sourceKernel === "pi"),
            false,
            "Bridge shell API keys must not materialize a persistent Pi Provider",
          );
          assert.equal(piOption?.available, false);
          assert.equal(piOption?.providerAvailable, false);
          assert.equal(
            piOption?.bindingStatus,
            "unknown",
            "a shell API key may make an explicitly selected built-in Provider usable, but cannot invent a Pi-owned route",
          );
        },
      );
      await withEnv(
        {
          OPENAI_API_KEY: undefined,
          MODEL_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        },
        async () => {
          const crossKernelPiState = createBridgeState({
            statePath: join(cwd, "pi-cross-kernel-model-state.json"),
          });
          crossKernelPiState.settings = {
            ...providerRouteSettings,
            kernel: "codex",
            modelProviderBindings: [
              {
                modelId: "claude-opus-4-8",
                providerId: "ww",
              },
            ],
          };
          crossKernelPiState.kernel = "codex";
          crossKernelPiState.model = "gpt-5.6-sol";
          const crossKernelPiOption = getBridgeKernelOptions(crossKernelPiState).find((option) => option.id === "pi");
          assert.equal(
            crossKernelPiOption?.available,
            false,
            "A model bound for another Kernel must not make Pi appear available",
          );
          assert.equal(crossKernelPiOption?.installed, true);
          assert.equal(crossKernelPiOption?.bindingKind, "unresolved");
          assert.equal(crossKernelPiOption?.bindingStatus, "selection-required");
          assert.equal(crossKernelPiOption?.providerId, undefined);
          const crossKernelPiControls = buildBridgeRuntimeControlsForKernel(crossKernelPiState, "pi");
          assert.deepEqual(
            (crossKernelPiControls.models as Array<{ id: string }>).map((model) => model.id),
            [],
            "Cross-Kernel controls must not borrow an unrelated Provider model catalog",
          );
          assert.deepEqual(
            (crossKernelPiControls.reasoningEfforts as Array<{ id: string }>).map((option) => option.id),
            ["low", "medium", "high", "xhigh", "max"],
            "Pi must advertise the reasoning levels accepted by its native thinking-level runtime",
          );
          assert.equal(
            crossKernelPiControls.defaultReasoningEffort,
            "medium",
            "Pi must expose the same effective default used by employee runs",
          );
        },
      );
      await withEnv(
        {
          [appEnvName("OPENCLAW_GATEWAY_URL")]: undefined,
          [appEnvName("OPENCLAW_WS_URL")]: undefined,
          [appEnvName("OPENCLAW_CONFIG_PATH")]: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_WS_URL: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
        },
        async () => {
          const openClawState = createBridgeState({
            statePath: join(cwd, "openclaw-missing-gateway-state.json"),
          });
          openClawState.settings = { ...providerRouteSettings, kernel: "openclaw" };
          recreateBridgeApp(openClawState);
          openClawState.settings.modelProviderBindings = [
            {
              modelId: openClawModel,
              providerId: openClawProvider.id,
            },
          ];
          openClawState.model = openClawModel;
          const openClawOption = getBridgeKernelOptions(openClawState).find((option) => option.id === "openclaw");
          assert.equal(openClawOption?.available, false);
          assert.equal(openClawOption?.installed, false);
          assert.equal(openClawOption?.providerAvailable, true);
          assert.equal(openClawOption?.reason, "OpenClaw Gateway is not configured.");
          assert.equal(openClawOption?.unavailableCode, "kernel_runtime_unavailable");

          const authOnlyHome = join(cwd, "openclaw-auth-only");
          const authOnlyProfileDir = join(authOnlyHome, "agents", "main", "agent");
          mkdirSync(authOnlyProfileDir, { recursive: true });
          writeFileSync(
            join(authOnlyProfileDir, "auth-profiles.json"),
            JSON.stringify({
              profiles: { "openai:default": { token: "configured-provider-token" } },
            }),
          );
          const authOnlyState = createBridgeState({
            statePath: join(cwd, "openclaw-auth-only-state.json"),
          });
          authOnlyState.settings = {
            ...providerRouteSettings,
            kernel: "openclaw",
            kernelPathOverrides: {
              ...providerRouteSettings.kernelPathOverrides,
              openclaw: { configHome: authOnlyHome },
            },
          };
          authOnlyState.model = openClawModel;
          recreateBridgeApp(authOnlyState);
          const authOnlyOption = getBridgeKernelOptions(authOnlyState).find((option) => option.id === "openclaw");
          assert.equal(
            authOnlyOption?.available,
            false,
            "Provider credentials alone must not impersonate a running Gateway",
          );
          assert.equal(
            authOnlyOption?.providerAvailable,
            true,
            "The explicit Gateway Provider remains visible independently of Gateway availability",
          );
          assert.equal(authOnlyOption?.bindingStatus, "ready");
          assert.equal(authOnlyOption?.reason, "OpenClaw Gateway is not configured.");
          assert.throws(
            () => resolveBridgeKernel("openclaw", authOnlyState),
            (error: unknown) => {
              assert.ok(error instanceof BridgeKernelUnavailableError);
              assert.match(error.message, /OPENCLAW_GATEWAY_URL/);
              return true;
            },
            "Kernel selection must delegate OpenClaw runtime availability to adapter discovery",
          );
        },
      );
      const openClawProbeMarker = join(cwd, "openclaw-version-probe.marker");
      const probeMarkerEnv = "OPENGROVE_TEST_OPENCLAW_PROBE_MARKER";
      const fakeOpenClaw = writeFakeCli(
        cwd,
        "fake-openclaw",
        ["#!/bin/sh", `printf 'called' > "$${probeMarkerEnv}"`, "echo 'fake-openclaw 1.0'"],
        ["@echo off", `echo called>"%${probeMarkerEnv}%"`, "echo fake-openclaw 1.0"],
      );
      const openClawState = createBridgeState({
        statePath: join(cwd, "openclaw-gateway-state.json"),
      });
      openClawState.settings = { ...providerRouteSettings, kernel: "openclaw" };
      openClawState.model = openClawModel;
      await withEnv(
        {
          OPENAI_API_KEY: undefined,
          [appEnvName("OPENCLAW_GATEWAY_URL")]: "ws://127.0.0.1:18789",
          [appEnvName("OPENCLAW_GATEWAY_TOKEN")]: "gateway-token",
          [appEnvName("OPENCLAW_BIN")]: fakeOpenClaw,
          [probeMarkerEnv]: openClawProbeMarker,
        },
        async () => {
          rmSync(openClawProbeMarker, { force: true });
          assert.equal(resolveBridgeKernel("openclaw", openClawState), "openclaw");
          assert.equal(
            existsSync(openClawProbeMarker),
            false,
            "Kernel selection must check the Gateway without probing the optional OpenClaw CLI",
          );
          recreateBridgeApp(openClawState);
          const openClawOption = getBridgeKernelOptions(openClawState).find((option) => option.id === "openclaw");
          assert.equal(
            existsSync(openClawProbeMarker),
            true,
            "Kernel discovery may probe the optional CLI when collecting display diagnostics",
          );
          assert.equal(
            openClawOption?.available,
            true,
            "An explicitly configured OpenClaw Gateway Provider must remain a valid route",
          );
          assert.equal(
            openClawOption?.installed,
            true,
            "A configured OpenClaw Gateway must not depend on the optional CLI for installed state",
          );
          assert.equal(
            openClawOption?.providerAvailable,
            true,
            "An OpenClaw Gateway must mark its Provider as available",
          );
          assert.equal(
            openClawOption?.bindingStatus,
            "ready",
            "An OpenClaw Gateway must keep Kernel and Provider status aligned",
          );
          assert.notEqual(
            buildBridgeRuntimeControlsForKernel(openClawState, "openclaw").source,
            "provider-unavailable",
            "An OpenClaw Gateway must expose Provider runtime controls",
          );
          const openClawAdapter = createBridgeKernel(openClawState);
          assert.equal(
            openClawAdapter.id,
            "openclaw",
            "OpenClaw creation must receive the complete process environment",
          );
          await openClawAdapter.dispose?.();
        },
      );

      assert.equal(normalizeBridgeKernelPreference("hermes", "claude-code"), "hermes");
      const hermesConfiguredState = {
        kernel: "hermes",
        model: "glm-5.1",
        settings: {
          kernel: "hermes",
          customProviders: [hermesProvider],
          modelProviderBindings: [
            {
              modelId: "glm-5.1",
              providerId: hermesProvider.id,
            },
          ],
          kernelPathOverrides: {
            hermes: { binaryPath: fakeHermes, configHome: hermesHome },
          },
        },
      } as unknown as NonNullable<Parameters<typeof resolveBridgeKernel>[1]>;
      assert.equal(resolveBridgeKernel("hermes", hermesConfiguredState), "hermes");
      const hermesBin = process.env[appEnvName("HERMES_BIN")];
      const hermesHttpOnlyState = {
        settings: {
          customProviders: [],
          modelProviderBindings: [],
          kernelPathOverrides: {
            hermes: { binaryPath: join(cwd, "missing-hermes") },
          },
        },
      } as unknown as NonNullable<Parameters<typeof resolveBridgeKernel>[1]>;
      process.env[appEnvName("HERMES_API_URL")] = "http://127.0.0.1:8000/v1";
      delete process.env[appEnvName("HERMES_BIN")];
      assert.throws(
        () => resolveBridgeKernel("hermes", hermesHttpOnlyState),
        /Hermes is not available/,
        "Hermes HTTP gateway URL must not make the Hermes kernel available",
      );
      if (hermesBin) {
        process.env[appEnvName("HERMES_BIN")] = hermesBin;
      }
      delete process.env[appEnvName("HERMES_API_URL")];

      const state = createBridgeState({ statePath: join(cwd, "state.json") });
      state.settings.kernelPathOverrides = {
        ...state.settings.kernelPathOverrides,
        hermes: { binaryPath: fakeHermes, configHome: hermesHome },
      };
      const overriddenCodex = createCodexKernelAdapterFromOptions({
        cwd,
        configHome: join(cwd, "codex-command-override"),
        command: fakeCodex,
        env: {},
        dataPath: join(cwd, "codex-command-override-data"),
      });
      assert.equal(
        (await overriddenCodex.discover()).binaryPath,
        fakeCodex,
        "adapter factories must honor the exact command resolved from settings",
      );
      await overriddenCodex.dispose?.();
      const codexModelsHome = join(cwd, "codex-models-home");
      mkdirSync(codexModelsHome, { recursive: true });
      writeFileSync(
        join(codexModelsHome, "auth.json"),
        `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token" } })}\n`,
        "utf8",
      );
      writeFileSync(
        join(codexModelsHome, "models_cache.json"),
        `${JSON.stringify({
          models: [
            { slug: "gpt-6-visible", display_name: "GPT-6 Visible", priority: 1 },
            { slug: "codex-auto-review", display_name: "Codex Auto Review", priority: 2, visibility: "hide" },
          ],
        })}\n`,
        "utf8",
      );
      const priorCodexPathOverride = state.settings.kernelPathOverrides.codex;
      const priorCodexModelProviderBindings = [...state.settings.modelProviderBindings];
      const priorSettingsKernel = state.settings.kernel;
      const priorStateKernel = state.kernel;
      const priorStateModel = state.model;
      state.settings.kernelPathOverrides.codex = { configHome: codexModelsHome };
      state.settings.kernel = "codex";
      state.kernel = "codex";
      state.model = "gpt-6-visible";
      state.settings.modelProviderBindings = [
        {
          modelId: "gpt-6-visible",
          providerId: LOGIN_PROVIDER_BINDING_ID,
        },
      ];
      const codexRuntimeControls = buildBridgeRuntimeControlsForKernel(state, "codex");
      assert.deepEqual(
        (codexRuntimeControls.models as Array<{ id: string }>).map((model) => model.id),
        ["gpt-6-visible"],
        "Codex runtime controls should trust visible cache models without exposing visibility=hide entries",
      );
      assert.deepEqual(
        readKernelLocalRouteProfile("codex", { cwd, configHome: codexModelsHome })?.models.map((model) => model.id),
        ["gpt-6-visible"],
        "Codex native profile discovery should also exclude visibility=hide cache entries",
      );
      if (priorCodexPathOverride) state.settings.kernelPathOverrides.codex = priorCodexPathOverride;
      else delete state.settings.kernelPathOverrides.codex;
      state.settings.modelProviderBindings = priorCodexModelProviderBindings;
      state.settings.kernel = priorSettingsKernel;
      state.kernel = priorStateKernel;
      state.model = priorStateModel;
      assert.equal(
        shouldDisableRemovedKernelEmployee(
          normalizeRoomMember({
            id: "legacy-qwen",
            name: "Qwen Code",
            kernel: "qwen-code",
            model: "",
            role: "legacy",
            status: "idle",
            color: "#111827",
            lastActive: "waiting",
            source: "local",
          }),
        ),
        true,
      );
      state.app.rooms.upsertMember(
        normalizeRoomMember({
          id: "legacy-qwen",
          name: "Qwen Code",
          kernel: "qwen-code",
          model: "",
          role: "legacy",
          status: "idle",
          color: "#111827",
          lastActive: "waiting",
          source: "local",
        }),
      );
      state.store.saveFrom(state.app);
      recreateBridgeApp(state);
      assert.equal(state.app.rooms.listMembers().find((member) => member.id === "legacy-qwen")?.disabled, true);
      if (getBridgeKernelOptions(state).some((option) => option.id === "codex" && option.available === true)) {
        const priorKernel = state.kernel;
        const priorModel = state.model;
        const availableCodexModel = (
          buildBridgeRuntimeControlsForKernel(state, "codex").models as Array<{ id: string }>
        )[0]?.id;
        assert.ok(availableCodexModel, "an available Codex runtime must expose at least one selectable model");
        state.kernel = "codex";
        state.model = availableCodexModel;
        assert.deepEqual(
          resolveSystemEmployeeRuntime(state),
          { kernel: "codex", model: availableCodexModel },
          "new App employees must inherit the user's active kernel and selected model",
        );
        state.kernel = priorKernel;
        state.model = priorModel;
      }
      const roomSeed = state.app.rooms.snapshot();
      assert.equal(
        roomSeed.members.some((member) => member.id === "grove-guide"),
        true,
      );
      assert.equal(
        roomSeed.members.some((member) => member.id === "app-creator"),
        false,
      );
      assert.equal(
        roomSeed.rooms.some((room) => room.id === "room-open-group" || room.id === "direct-app-creator"),
        false,
      );
      const modelResolutionClaudeHome = join(cwd, "model-resolution-claude-home");
      mkdirSync(modelResolutionClaudeHome, { recursive: true });
      writeFileSync(
        join(modelResolutionClaudeHome, "settings.json"),
        `${JSON.stringify({
          env: {
            ANTHROPIC_MODEL: "global.anthropic.claude-fable-5",
          },
          model: "us.anthropic.claude-opus-4-8[1m]",
        })}\n`,
        "utf8",
      );
      state.settings.kernelPathOverrides = {
        ...state.settings.kernelPathOverrides,
        "claude-code": { configHome: modelResolutionClaudeHome },
      };
      state.settings.modelProviderBindings = [];
      assert.equal(
        resolveKernelRuntimeModel(state, "claude-code", "us.anthropic.claude-opus-4-8[1m]"),
        "us.anthropic.claude-opus-4-8[1m]",
        "Claude Code room employees should let an explicit concrete model override native ANTHROPIC_MODEL",
      );
      assert.equal(
        resolveKernelRuntimeModel(state, "claude-code", "claude-code-default"),
        "global.anthropic.claude-fable-5",
        "Claude Code default sentinel should continue to follow native Claude Code configuration",
      );
      assert.equal(
        resolveKernelRuntimeModel(state, "claude-code", "Claude Code"),
        "global.anthropic.claude-fable-5",
        "Legacy Claude Code display names should not be treated as concrete runtime models",
      );
      assert.equal(
        normalizeRoomMember({
          id: "concrete-claude",
          name: "Concrete Claude",
          kernel: "claude-code",
          model: "us.anthropic.claude-opus-4-8[1m]",
        }).model,
        "us.anthropic.claude-opus-4-8[1m]",
        "Room member normalization must preserve concrete Claude model ids",
      );
      const concreteClaudeMember = normalizeRoomMember({
        id: "concrete-claude",
        name: "Concrete Claude",
        kernel: "claude-code",
        model: "us.anthropic.claude-opus-4-8[1m]",
      });
      assert.equal(
        resolveRoomTargetModel(state, concreteClaudeMember),
        "us.anthropic.claude-opus-4-8[1m]",
        "Room target model resolution should preserve an explicit Claude employee model",
      );
      assert.equal(
        normalizeRoomMember({
          id: "legacy-claude",
          name: "Legacy Claude",
          kernel: "claude-code",
          model: "AWS Bedrock (API Key)",
        }).model,
        "claude-code-default",
        "Room member normalization should collapse legacy Claude default labels to the native sentinel",
      );
      state.settings.kernelPathOverrides = {
        ...state.settings.kernelPathOverrides,
        "claude-code": { configHome: claudeHome },
      };
      state.settings.modelProviderBindings = [];

      assert.ok(state.app.tools.require("opengrove.app.import"), "App import should keep its host import tool");
      const appCreatorTool = state.app.tools.require("opengrove.app.import");
      const plainProjectRoot = join(cwd, "plain-project");
      mkdirSync(plainProjectRoot, { recursive: true });
      writeFileSync(join(plainProjectRoot, "README.md"), "# Plain Project\n", "utf8");
      const importResult = await appCreatorTool.execute(
        {
          source: plainProjectRoot,
          title: "Plain Project",
          description: "Project imported through App Creator.",
        },
        {} as any,
      );
      assert.equal(importResult.ok, true);
      const importedValue = importResult.value as Record<string, unknown>;
      assert.equal(importedValue.status, "mounted");
      assert.equal(existsSync(join(String(importedValue.appRoot), "opengrove.app.json")), true);
      assert.ok(
        state.settings.mountedApps.some((app) => app.id === "plain-project"),
        "App Creator import should mount into the live bridge state",
      );
      assert.ok(
        state.app.rooms.listMembers().some((member) => member.id === "member-app-plain-project-operator"),
        "App Creator import should refresh mounted app employees without restarting",
      );
      const plainProjectMount = state.settings.mountedApps.find((app) => app.id === "plain-project");
      assert.ok(plainProjectMount);
      plainProjectMount.appBuilderEnabled = true;
      recreateBridgeApp(state);
      const plainProjectBuilderId = "member-app-plain-project-app%2Dbuilder";
      assert.equal(
        state.app.rooms.getRoom("app-room--plain-project--group--default")?.memberIds.includes(plainProjectBuilderId),
        true,
        "the scaffold lifecycle starts with a visible scoped Builder",
      );
      const hotReloadResult = await appCreatorTool.execute(
        {
          source: String(importedValue.appRoot),
        },
        {} as any,
      );
      assert.equal(hotReloadResult.ok, true);
      assert.equal((hotReloadResult.value as Record<string, unknown>).status, "already_mounted");
      assert.equal(
        state.settings.mountedApps.find((app) => app.id === "plain-project")?.appBuilderEnabled,
        true,
        "the host import tool must preserve an existing App Builder marker during hot reload",
      );
      assert.equal(
        state.app.rooms.listMembers().find((member) => member.id === plainProjectBuilderId)?.disabled,
        false,
        "the Builder must remain runnable after reloading its own App",
      );
      assert.equal(
        state.app.rooms.getRoom("app-room--plain-project--group--default")?.memberIds.includes(plainProjectBuilderId),
        true,
        "the Builder must remain in the App group after hot reload",
      );
      const nestedSourceRoot = join(cwd, "nested-source-root");
      const nestedMaeveRoot = join(nestedSourceRoot, "projects", "codes", "agent", "maeve-agent");
      mkdirSync(nestedMaeveRoot, { recursive: true });
      writeFileSync(
        join(nestedMaeveRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "maeve",
          title: "Maeve",
          description: "Short drama ad production workbench.",
          ui: { surface: "file-workbench", workspace: "workspace" },
          workspace: { path: "workspace" },
        }),
        "utf8",
      );
      mkdirSync(join(nestedMaeveRoot, "workspace"), { recursive: true });
      const nestedImportResult = await appCreatorTool.execute(
        {
          source: nestedSourceRoot,
          title: "Maeve",
          description: "导入里面的 Maeve 能力。",
        },
        {} as any,
      );
      assert.equal(nestedImportResult.ok, true);
      const nestedImportedValue = nestedImportResult.value as Record<string, unknown>;
      assert.equal(nestedImportedValue.status, "mounted");
      assert.equal(nestedImportedValue.appRoot, nestedMaeveRoot);
      assert.equal(nestedImportedValue.selectedFromSourceRoot, nestedSourceRoot);
      assert.ok(state.settings.mountedApps.some((app) => app.id === "maeve" && app.path === nestedMaeveRoot));

      const ambiguousSourceRoot = join(cwd, "ambiguous-source-root");
      for (const [id, title] of [
        ["alpha-app", "Alpha App"],
        ["beta-app", "Beta App"],
      ] as const) {
        const candidateRoot = join(ambiguousSourceRoot, id);
        mkdirSync(join(candidateRoot, "workspace"), { recursive: true });
        writeFileSync(
          join(candidateRoot, "opengrove.app.json"),
          JSON.stringify({
            id,
            title,
            ui: { surface: "file-workbench", workspace: "workspace" },
            workspace: { path: "workspace" },
          }),
          "utf8",
        );
      }
      const ambiguousImportResult = await appCreatorTool.execute(
        {
          source: ambiguousSourceRoot,
        },
        {} as any,
      );
      assert.equal(ambiguousImportResult.ok, true);
      const ambiguousValue = ambiguousImportResult.value as { status?: string; candidates?: unknown[] };
      assert.equal(ambiguousValue.status, "needs_app_selection");
      assert.equal(ambiguousValue.candidates?.length, 2);
      assert.equal(
        state.settings.mountedApps.some((app) => app.id === "ambiguous-source-root"),
        false,
      );

      const editorAppRoot = join(cwd, "sample-editor-app");
      mkdirSync(editorAppRoot, { recursive: true });
      mkdirSync(join(editorAppRoot, "assets"), { recursive: true });
      mkdirSync(join(editorAppRoot, "skills", "app-helper"), { recursive: true });
      writeFileSync(
        join(editorAppRoot, "skills", "app-helper", "SKILL.md"),
        "---\nname: app-helper\ndescription: App-level helper skill.\n---\n",
        "utf8",
      );
      writeFileSync(
        join(editorAppRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "sample-editor",
          title: "Sample Editor",
          description: "Portable editing workflow for OpenGrove.",
          employees: [
            {
              id: "asset-editor",
              name: "Asset Editor",
              kernel: "claude-code",
              model: "claude-code-default",
              role: "Prepares workspace assets and previews.",
              defaultSkillIds: ["asset-query", "project-render"],
            },
          ],
          agents: [
            {
              id: "copy-reviewer",
              name: "Copy Reviewer",
              kernel: "codex",
              role: "Reviews copy inside the app asset scope.",
              workspace: "assets",
            },
          ],
        }),
        "utf8",
      );
      const directorAppRoot = join(cwd, "sample-director-app");
      mkdirSync(directorAppRoot, { recursive: true });
      writeFileSync(
        join(directorAppRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "sample-director",
          title: "Sample Director",
          description: "Portable director workflow for OpenGrove.",
          capabilities: {
            employees: [
              {
                id: "director",
                name: "Director",
                kernel: "opencode",
                model: "sample-director-model",
                role: "Coordinates the app workflow.",
              },
            ],
          },
        }),
        "utf8",
      );
      const fallbackAppRoot = join(cwd, "sample-fallback-app");
      mkdirSync(join(fallbackAppRoot, "skills", "fallback-skill"), { recursive: true });
      writeFileSync(
        join(fallbackAppRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "sample-fallback",
          title: "Sample Fallback",
          description: "Portable fallback workflow for OpenGrove.",
          ui: {
            kind: "file-workbench",
            workspace: "workspace",
            agentContext: "Use the fallback workspace contract.",
          },
          agent: {
            instructions: "Follow the app-level operating notes.",
          },
        }),
        "utf8",
      );
      assert.equal(migrateMountedAppManifestV1(fallbackAppRoot).status, "migrated");
      writeFileSync(join(fallbackAppRoot, "AGENTS.md"), "# Sample Fallback\n\nUse AGENTS.md instructions.", "utf8");
      try {
        symlinkSync("AGENTS.md", join(fallbackAppRoot, "agents.md"));
        symlinkSync("AGENTS.md", join(fallbackAppRoot, "Agents.md"));
      } catch {
        // Case-insensitive filesystems already resolve these names to AGENTS.md.
      }
      writeFileSync(
        join(fallbackAppRoot, "skills", "fallback-skill", "SKILL.md"),
        "---\nname: fallback-skill\ndescription: Test fallback skill.\n---\n",
        "utf8",
      );
      state.settings.mountedApps = [
        { id: "sample-editor", path: editorAppRoot, enabled: true },
        { id: "sample-director", path: directorAppRoot, enabled: true },
        { id: "sample-fallback", path: fallbackAppRoot, enabled: true },
      ];
      recreateBridgeApp(state);
      const appMembers = state.app.rooms.listMembers();
      const editorEmployee = appMembers.find((member) => member.id === "member-app-sample-editor-asset%2Deditor");
      const editorAgentAliasEmployee = appMembers.find(
        (member) => member.id === "member-app-sample-editor-copy%2Dreviewer",
      );
      const directorEmployee = appMembers.find((member) => member.id === "member-app-sample-director-director");
      const fallbackOperator = appMembers.find((member) => member.id === "member-app-sample-fallback-operator");
      const fallbackPm = appMembers.find((member) => member.id === "member-app-sample-fallback-pm");
      assert.equal(editorEmployee?.kernel, "claude-code", "manifest employee should preserve its kernel");
      assert.deepEqual(editorEmployee?.defaultSkillIds, ["asset-query", "project-render"]);
      assert.equal(
        editorEmployee?.defaultSkillIds?.includes("app-helper"),
        false,
        "manifest employee skill defaults should not absorb every app skill",
      );
      assert.equal(editorAgentAliasEmployee?.kernel, "codex", "manifest agents should be installed as app employees");
      assert.equal(
        editorAgentAliasEmployee?.workspaceRoot,
        join(editorAppRoot, "assets"),
        "per-employee workspace scope should stay inside the app package",
      );
      assert.equal(directorEmployee?.kernel, "opencode", "manifest employee should preserve opencode kernel");
      assert.equal(directorEmployee?.model, "sample-director-model");
      assert.equal(
        fallbackOperator,
        undefined,
        "mounted apps without manifest employees must not create a fallback Operator",
      );
      assert.equal(fallbackPm?.kernel, "claude-code", "PM-only Apps should keep the host-tools-capable PM runtime");
      assert.deepEqual(fallbackPm?.defaultSkillIds, [PM_AGENT_SKILL_NAME]);
      assert.equal(fallbackPm?.availableSkillIds?.includes("app:sample-fallback/fallback-skill"), true);
      assert.equal(fallbackPm?.role.includes("Use AGENTS.md instructions."), true);
      assert.equal((fallbackPm?.role.match(/Use AGENTS\.md instructions\./g) ?? []).length, 1);
      assert.equal(fallbackPm?.role.includes("Use the fallback workspace contract."), true);
      assert.match(fallbackPm?.role ?? "", /当前没有可委派员工[\s\S]*提示用户新增员工/);
      state.app.rooms.upsertMember(
        {
          id: "member-app-sample-editor-old-worker",
          name: "Old Worker",
          kernel: "codex",
          model: "gpt-5.5",
          role: "Stale employee from an older manifest.",
          status: "idle",
          color: "#64748b",
          lastActive: "old",
          appId: "sample-editor",
          workspaceRoot: editorAppRoot,
          source: "local",
          sourceLabel: "Old Sample Editor App",
        },
        { emitEvent: false },
      );
      state.store.saveFrom(state.app);
      writeFileSync(
        join(editorAppRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "sample-editor",
          title: "Sample Editor",
          description: "Portable editing workflow for OpenGrove.",
          employees: [
            {
              id: "asset-editor",
              name: "Asset Editor Updated",
              kernel: "claude-code",
              model: "claude-code-default",
              role: "Updated manifest role.",
              defaultSkillIds: ["asset-query"],
            },
          ],
        }),
        "utf8",
      );
      recreateBridgeApp(state);
      const refreshedEditorMembers = state.app.rooms.listMembers();
      const refreshedEditorEmployee = refreshedEditorMembers.find(
        (member) => member.id === "member-app-sample-editor-asset%2Deditor",
      );
      const staleEditorWorker = refreshedEditorMembers.find(
        (member) => member.id === "member-app-sample-editor-old-worker",
      );
      const staleCopyReviewer = refreshedEditorMembers.find(
        (member) => member.id === "member-app-sample-editor-copy%2Dreviewer",
      );
      assert.equal(
        refreshedEditorEmployee?.name,
        "Asset Editor Updated",
        "manifest seed members should update when the App manifest changes",
      );
      assert.deepEqual(
        refreshedEditorEmployee?.defaultSkillIds,
        ["asset-query"],
        "manifest seed skills should update instead of preserving stale defaults",
      );
      assert.equal(
        staleEditorWorker?.disabled,
        true,
        "stale generated App employees should be disabled when missing from the current manifest",
      );
      assert.equal(
        staleCopyReviewer?.disabled,
        true,
        "removed manifest agents should be disabled when missing from the current manifest",
      );
      writeFileSync(
        join(editorAppRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "sample-editor",
          title: "Sample Editor",
          description: "Portable editing workflow for OpenGrove.",
          employees: [
            {
              id: "asset-editor",
              name: "Asset Editor Updated",
              kernel: "claude-code",
              model: "claude-code-default",
              role: "Updated manifest role.",
              defaultSkillIds: ["asset-query"],
            },
            {
              id: "copy-reviewer",
              name: "Copy Reviewer Restored",
              kernel: "codex",
              role: "Restored manifest role.",
            },
          ],
        }),
        "utf8",
      );
      recreateBridgeApp(state);
      const restoredCopyReviewer = state.app.rooms
        .listMembers()
        .find((member) => member.id === "member-app-sample-editor-copy%2Dreviewer");
      assert.equal(
        restoredCopyReviewer?.disabled,
        false,
        "removed manifest agents should be restored when they reappear in the manifest",
      );
      assert.equal(restoredCopyReviewer?.name, "Copy Reviewer Restored");
      state.settings.mountedApps = state.settings.mountedApps.map((app) =>
        app.id === "sample-editor" ? { ...app, enabled: false } : app,
      );
      recreateBridgeApp(state);
      assert.equal(
        state.app.rooms
          .listMembers()
          .filter((member) => member.appId === "sample-editor")
          .every((member) => member.disabled),
        true,
        "disabling an App must remove all of its employees from active product surfaces",
      );
      state.settings.kernel = "hermes";
      state.model = "glm-5.1";
      state.settings.customProviders = [
        ...state.settings.customProviders.filter((provider) => provider.id !== hermesProvider.id),
        hermesProvider,
      ];
      state.settings.modelProviderBindings = [
        {
          modelId: "glm-5.1",
          providerId: hermesProvider.id,
        },
      ];
      const options = getBridgeKernelOptions(state);
      for (const option of options) {
        assert.doesNotMatch(
          String(option.label ?? "") + String(option.description ?? "") + String(option.reason ?? ""),
          /\p{Script=Han}/u,
          "kernel options must expose locale-neutral canonical copy, including fallback reasons; the renderer localizes known presentation fields",
        );
        assert.equal(
          typeof option.integrationKind,
          "string",
          "kernel options must expose a stable integration kind instead of asking the UI to render server prose",
        );
        assert.equal(
          typeof option.hostTools,
          "boolean",
          "kernel options must expose the Bridge Host Tools routing gate to presentation clients",
        );
      }
      await withEnv({ [appEnvName("CLAUDE_CODE_RUNTIME")]: "cli" }, async () => {
        const claudeCliOption = getBridgeKernelOptions(state).find((option) => option.id === "claude-code");
        assert.equal(claudeCliOption?.integrationKind, "cli");
        assert.equal(claudeCliOption?.hostTools, false);
        assert.match(String(claudeCliOption?.description ?? ""), /CLI/);
      });
      const hermesOption = options.find((option) => option.id === "hermes");
      assert.ok(hermesOption, "settings should expose Hermes");
      assert.equal(hermesOption?.available, true);
      assert.equal(
        "sources" in hermesOption,
        false,
        "Kernel settings must not expose retired Knowledge source controls",
      );
      const codexOption = options.find((option) => option.id === "codex");
      assert.ok(codexOption, "settings should expose Codex");
      assert.equal(codexOption?.hostTools, true);
      assert.equal("sources" in codexOption, false, "Codex settings must not expose retired Knowledge source controls");
      assert.equal(
        normalizeCodexModelId("gpt-5.5", "gpt-5.4"),
        "gpt-5.5",
        "Codex should let the composer-selected model override the configured default",
      );
      assert.equal(
        normalizeCodexModelId("claude-code-default", "gpt-5.4"),
        "gpt-5.4",
        "Codex should ignore stale non-Codex composer model ids",
      );
      assert.equal(
        normalizeCodexModelId("glm-5.1", "glm-5.1"),
        "glm-5.1",
        "Codex provider bindings should still pass provider-selected model ids through",
      );
      assert.equal(
        normalizeCodexModelId("gpt-5.5", "glm-5.1"),
        "glm-5.1",
        "Codex external provider bindings should not let stale OpenAI UI models leak into the provider request",
      );

      assert.equal(
        providerEnvForKernel("claude-code", undefined, undefined),
        undefined,
        "Claude Code without an explicit provider binding should keep its native configuration",
      );
      const claudeVolc = resolveTestProvider("claude-code", "glm-5.1", "volc-coding-plan");
      const claudeEnv = providerEnvForKernel("claude-code", claudeVolc, "glm-5.1");
      assert.ok(claudeVolc);
      state.settings.customProviders = [
        ...state.settings.customProviders.filter((provider) => provider.id !== claudeVolc.id),
        claudeVolc,
      ];
      state.settings.modelProviderBindings = [
        {
          modelId: "glm-5.1",
          providerId: "volc-coding-plan",
        },
      ];
      assert.equal(
        resolveKernelRuntimeModel(state, "claude-code", "glm-5.1"),
        "opus",
        "Claude Code model routes should translate the selected Provider model to its family alias",
      );
      assert.equal(
        kernelModelForProviderSelection("claude-code", claudeVolc, "glm-5.1"),
        "opus",
        "Claude Code should receive a family alias, not the provider model id",
      );
      assert.deepEqual(kernelModelAliasesForProvider("claude-code", claudeVolc), {
        "glm-5.1": "opus",
        "minimax-m2.7": "opus",
        "ark-code-latest": "opus",
      });
      assert.equal(claudeEnv?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(claudeEnv?.ANTHROPIC_BASE_URL, "https://ark.cn-beijing.volces.com/api/coding");
      assert.equal(claudeEnv?.ANTHROPIC_MODEL, "glm-5.1");
      assert.equal(claudeEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.1");
      assert.equal(claudeEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.1");
      assert.equal(claudeEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.1");

      const deepSeek = getBridgeProviderProfiles().find((provider) => provider.id === "deepseek");
      assert.ok(deepSeek);
      const codexDeepSeekProfile = providerProfileForKernel(
        "codex",
        {
          ...deepSeek,
          custom: true,
          enabled: true,
          apiKey: "deepseek-test-key",
        },
        "deepseek-v4-flash",
      );
      assert.ok(codexDeepSeekProfile);
      assert.deepEqual(codexProviderConfigFromProfile(codexDeepSeekProfile), {
        providerKey: "opengrove_deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        envKey: "OPENGROVE_DEEPSEEK_API_KEY",
        wireApi: "responses",
      });

      const codexVolc: BridgeProviderProfile = {
        ...claudeVolc!,
        apiKey: "raw-test-key",
        apiKeyEnv: undefined,
      };
      const codexEnv = providerEnvForKernel("codex", codexVolc, "glm-5.1");
      assert.equal(codexEnv?.OPENGROVE_VOLC_CODING_PLAN_API_KEY, "raw-test-key");
      const hermesEnv = providerEnvForKernel("hermes", codexVolc, "glm-5.1");
      assert.equal(hermesEnv?.OPENGROVE_VOLC_CODING_PLAN_API_KEY, "raw-test-key");
      const opencodeEnv = providerEnvForKernel("opencode", codexVolc, "glm-5.1");
      assert.ok(opencodeEnv?.OPENCODE_CONFIG_CONTENT, "OpenCode should receive an inline custom provider config");
      const opencodeConfig = JSON.parse(opencodeEnv.OPENCODE_CONFIG_CONTENT) as any;
      assert.equal(opencodeConfig.model, "opengrove-volc-coding-plan/glm-5.1");
      assert.equal(
        opencodeConfig.provider["opengrove-volc-coding-plan"].options.baseURL,
        "https://ark.cn-beijing.volces.com/api/coding/v3",
      );
      assert.equal(opencodeConfig.provider["opengrove-volc-coding-plan"].options.apiKey, "raw-test-key");
      assert.equal(opencodeConfig.provider["opengrove-volc-coding-plan"].name, "Volcengine Coding Plan");
      assert.ok(opencodeConfig.provider["opengrove-volc-coding-plan"].models["glm-5.1"]);
      const codexProfile = providerProfileForKernel("codex", codexVolc, "glm-5.1");
      assert.ok(codexProfile);
      const codexProviderConfig = codexProviderConfigFromProfile(codexProfile);
      assert.deepEqual(
        { ...codexProviderConfig, baseUrl: codexVolc.openaiBaseUrl },
        {
          providerKey: "opengrove_volc_coding_plan",
          name: "Volcengine Coding Plan",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
          envKey: "OPENGROVE_VOLC_CODING_PLAN_API_KEY",
          wireApi: "responses",
        },
      );
      assert.match(codexProviderConfig?.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
      assert.equal(codexResponsesChatProxyStatus().started, true);

      const anthropicOnlyPi: BridgeProviderProfile = {
        id: "anthropic-only-pi",
        name: "Anthropic-only Pi",
        custom: true,
        protocol: "anthropic-compatible",
        credentialKind: "api-key",
        anthropicBaseUrl: "https://anthropic.internal.example/v1",
        apiKey: "anthropic-only-key",
        models: [{ id: "sonnet", label: "Sonnet" }],
      };
      const anthropicOnlyPiEnv = providerEnvForKernel("pi", anthropicOnlyPi, "sonnet");
      assert.equal(anthropicOnlyPiEnv?.ANTHROPIC_BASE_URL, "https://anthropic.internal.example/v1");
      assert.equal(anthropicOnlyPiEnv?.ANTHROPIC_API_KEY, "anthropic-only-key");
      assert.equal(
        anthropicOnlyPiEnv?.OPENAI_API_KEY,
        undefined,
        "Pi must not broadcast one credential to unrelated protocols",
      );
      assert.equal(
        anthropicOnlyPiEnv?.GEMINI_API_KEY,
        undefined,
        "Pi must not broadcast one credential to unrelated protocols",
      );

      const providerIds = getBridgeProviderProfiles().map((profile) => profile.id);
      assert.ok(providerIds.includes("ww"), "WW should be available as a provider profile");
      assert.ok(providerIds.includes("anthropic"), "Adding WW must not remove Anthropic");
      assert.ok(providerIds.includes("volc-coding-plan"), "Adding WW must not remove Volcengine");
      const wwProvider = resolveTestProvider("claude-code", "claude-opus-4-8", "ww");
      assert.ok(wwProvider);
      assert.equal(wwProvider?.anthropicBaseUrl, "https://ww.example.test");
      assert.equal(wwProvider?.apiKeyEnv, appEnvName("WW_API_KEY"));
      assert.deepEqual(wwProvider?.models, [
        {
          id: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          apiModelId: "deepseek-v4-flash",
          canonicalModelId: "deepseek/deepseek-v4-flash-0731",
          family: "deepseek-v4",
        },
        {
          id: "claude-opus-4-8",
          label: "Claude Opus 4.8",
          apiModelId: "claude-opus-4-8",
          canonicalModelId: "anthropic/claude-opus-4-8",
          family: "claude-opus",
        },
        {
          id: "deepseek-v4-pro",
          label: "DeepSeek V4 Pro",
          apiModelId: "deepseek-v4-pro",
          canonicalModelId: "deepseek/deepseek-v4-pro-0813",
          family: "deepseek-v4",
        },
      ]);
      assert.deepEqual(kernelModelAliasesForProvider("claude-code", wwProvider), {
        "claude-opus-4-8": "opus",
        "anthropic/claude-opus-4-8": "opus",
        "deepseek-v4-pro": "opus",
        "deepseek-v4-flash": "opus",
        "deepseek/deepseek-v4-pro-0813": "opus",
        "deepseek/deepseek-v4-flash-0731": "opus",
      });
      assert.equal(kernelModelForProviderSelection("claude-code", wwProvider, "claude-opus-4-8"), "opus");
      const wwClaudeEnv = providerEnvForKernel("claude-code", wwProvider, undefined);
      assert.equal(wwClaudeEnv?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(wwClaudeEnv?.ANTHROPIC_BASE_URL, "https://ww.example.test");
      assert.equal(wwClaudeEnv?.ANTHROPIC_API_KEY, "ww_sk_test");
      assert.equal(wwClaudeEnv?.ANTHROPIC_AUTH_TOKEN, "");
      assert.equal(wwClaudeEnv?.ANTHROPIC_MODEL, "deepseek-v4-flash");
      assert.equal(wwClaudeEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-flash");
      assert.equal(wwClaudeEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-v4-flash");
      assert.equal(wwClaudeEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
      const wwDeepSeekEnv = providerEnvForKernel("claude-code", wwProvider, "deepseek-v4-pro");
      assert.equal(wwDeepSeekEnv?.ANTHROPIC_MODEL, "deepseek-v4-pro");
      assert.equal(wwDeepSeekEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-pro");
      assert.equal(kernelModelForProviderSelection("claude-code", wwProvider, "deepseek-v4-pro"), "opus");
      const legacySavedWw = getAllBridgeProviderProfiles([
        {
          ...wwProvider!,
          custom: true,
          origin: "user",
          models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
        },
      ]).find((profile) => profile.id === "ww");
      assert.deepEqual(
        legacySavedWw?.models,
        wwProvider?.models,
        "an existing provisioned WW profile should inherit newly built-in models",
      );
      const pinnedWw = getAllBridgeProviderProfiles([
        {
          ...wwProvider!,
          custom: true,
          origin: "user",
          modelsPinned: true,
          models: [{ id: "ww-custom-model", label: "WW Custom Model" }],
        },
      ]).find((profile) => profile.id === "ww");
      assert.deepEqual(
        pinnedWw?.models.map((model) => model.id),
        ["ww-custom-model"],
        "an explicitly pinned WW model list should remain user-controlled",
      );
      const quarantinedWw = getAllBridgeProviderProfiles([
        {
          ...wwProvider!,
          custom: true,
          origin: "user",
          apiKey: undefined,
          apiKeyEnv: undefined,
          credentialKind: "api-key",
          provisioningBlocked: true,
        },
      ]).find((profile) => profile.id === "ww");
      assert.equal(
        quarantinedWw?.apiKeyEnv,
        undefined,
        "A keyless custom WW profile must shadow the built-in env credential",
      );
      assert.equal(
        resolveProviderApiKey(quarantinedWw!),
        undefined,
        "A quarantined WW profile must not resolve OPENGROVE_WW_API_KEY",
      );
      const quarantinedWwBinding = describeProviderRoute("claude-code", "ww", [quarantinedWw!]);
      assert.equal(quarantinedWwBinding.kind, "provider");
      if (quarantinedWwBinding.kind === "provider") {
        assert.equal(
          quarantinedWwBinding.status,
          "missing-key",
          "A quarantined WW route must stay compatible while reporting that its key is not ready",
        );
      }
      assert.equal(
        resolveTestProvider("claude-code", "claude-opus-4-8", "ww", [quarantinedWw!]),
        undefined,
        "A quarantined WW credential must remain unavailable instead of falling back to an env key",
      );
      await withEnv(
        {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CONFIG_DIR: undefined,
          [appEnvName("ANTHROPIC_API_KEY")]: undefined,
          [appEnvName("ANTHROPIC_AUTH_TOKEN")]: undefined,
        },
        async () => {
          const emptyClaudeHome = join(cwd, "ww-provider-empty-claude-home");
          mkdirSync(emptyClaudeHome, { recursive: true });
          const wwBoundState = createBridgeState({ statePath: join(cwd, "ww-provider-state.json") });
          wwBoundState.settings.kernel = "claude-code";
          wwBoundState.settings.kernelPathOverrides = {
            ...wwBoundState.settings.kernelPathOverrides,
            "claude-code": { configHome: emptyClaudeHome },
          };
          wwBoundState.model = "claude-opus-4-8";
          wwBoundState.settings.modelProviderBindings = [
            { modelId: "claude-opus-4-8", providerId: "ww" },
            { modelId: "deepseek-v4-pro", providerId: "ww" },
            { modelId: "deepseek-v4-flash", providerId: "ww" },
          ];
          wwBoundState.settings.customProviders = [
            wwProvider,
            {
              id: "native-capable",
              name: "Native-capable Provider",
              custom: true,
              origin: "user",
              protocol: "anthropic-compatible",
              credentialKind: "api-key",
              anthropicBaseUrl: "https://native-capable.example.test",
              apiKey: "native-capable-key",
              models: [{ id: "native", label: "Native" }],
            },
          ];
          const wwBoundClaude = getBridgeKernelOptions(wwBoundState).find((option) => option.id === "claude-code");
          assert.equal(
            wwBoundClaude?.available,
            true,
            "Claude Code should be available when a WW provider binding supplies runtime auth",
          );
          assert.equal(
            resolveBridgeKernel("claude-code", wwBoundState),
            "claude-code",
            "A provider-authenticated Claude Code binding should be runnable without local Claude auth files",
          );
          recreateBridgeApp(wwBoundState);
          assert.equal(wwBoundState.kernelUnavailableReason, undefined);
          assert.equal(wwBoundState.kernel, "claude-code");
          assert.equal(resolveKernelRuntimeModel(wwBoundState, "claude-code"), "opus");
          assert.equal(
            isBridgeKernelAvailable(wwBoundState, "claude-code"),
            true,
            "the active system runtime fast path must retain the same runnable-Kernel contract as normal selection",
          );
          const activeClaudePath = wwBoundState.settings.kernelPathOverrides["claude-code"];
          wwBoundState.settings.kernelPathOverrides["claude-code"] = {
            ...activeClaudePath,
            binaryPath: join(cwd, "missing-active-claude"),
          };
          assert.equal(
            isBridgeKernelAvailable(wwBoundState, "claude-code"),
            false,
            "runtime controls with models must not make a missing active Kernel executable look runnable",
          );
          if (activeClaudePath) wwBoundState.settings.kernelPathOverrides["claude-code"] = activeClaudePath;
          else delete wwBoundState.settings.kernelPathOverrides["claude-code"];
          const unrelatedProbeMarker = join(cwd, "system-runtime-unrelated-probe.txt");
          const unrelatedCli = writeFakeCli(
            cwd,
            "system-runtime-unrelated-cli",
            ["#!/bin/sh", `echo invoked >> "${unrelatedProbeMarker}"`, "echo unrelated-cli 0.0.0"],
            ["@echo off", `echo invoked>>"${unrelatedProbeMarker}"`, "echo unrelated-cli 0.0.0"],
          );
          wwBoundState.settings.kernelPathOverrides.opencode = { binaryPath: unrelatedCli };
          assert.deepEqual(resolveSystemEmployeeRuntime(wwBoundState), {
            kernel: "claude-code",
            model: "claude-opus-4-8",
          });
          wwBoundState.model = "anthropic/claude-opus-4-8";
          assert.equal(
            resolveProviderSelectedModelForKernel(wwBoundState, "claude-code", wwBoundState.model),
            "anthropic/claude-opus-4-8",
            "Provider selection must not replace a canonical model with the first raw route id",
          );
          assert.deepEqual(
            resolveSystemEmployeeRuntime(wwBoundState),
            {
              kernel: "claude-code",
              model: "anthropic/claude-opus-4-8",
            },
            "the system Employee must preserve a canonical UI model selection served by the active Provider",
          );
          wwBoundState.model = "claude-opus-4-8";
          assert.equal(
            existsSync(unrelatedProbeMarker),
            false,
            "resolving the active system runtime must not synchronously probe unrelated Kernel CLIs during cold start",
          );
          wwBoundState.app.rooms.upsertMember(
            normalizeRoomMember({
              id: "member-app-story-seed-writer",
              name: "故事架构师",
              kernel: "claude-code",
              model: "claude-code-default",
              role: "outline",
              status: "idle",
              color: "green",
              lastActive: "configured",
              appId: "story-seed",
              userOverrides: ["kernel", "model", "reasoningEffort"],
            }),
          );
          wwBoundState.app.rooms.upsertMember(
            normalizeRoomMember({
              id: "member-app-story-seed-legacy-pm",
              employeeDefinitionId: "pm",
              name: "Legacy Story Seed PM",
              kernel: "claude-code",
              model: "native",
              role: "planning",
              status: "idle",
              color: "yellow",
              lastActive: "configured",
              appId: "story-seed",
            }),
          );
          wwBoundState.app.rooms.upsertMember(
            normalizeRoomMember({
              id: "explicit-native-employee",
              employeeDefinitionId: "explicit-native-employee",
              name: "Explicit Native Employee",
              kernel: "claude-code",
              model: "native",
              role: "testing",
              status: "idle",
              color: "blue",
              lastActive: "configured",
              appId: "story-seed",
              userOverrides: ["model"],
            }),
          );
          wwBoundState.app.rooms.upsertMember(
            normalizeRoomMember({
              id: "native-capable-employee",
              employeeDefinitionId: "native-capable-employee",
              name: "Native-capable Employee",
              kernel: "claude-code",
              model: "native",
              providerId: "native-capable",
              role: "testing",
              status: "idle",
              color: "purple",
              lastActive: "configured",
              appId: "story-seed",
            }),
          );
          wwBoundState.settings.employeeModelMigrationVersion = 0;
          wwBoundState.store.saveFrom(wwBoundState.app);
          recreateBridgeApp(wwBoundState);
          const repairedMember = wwBoundState.app.rooms
            .listMembers()
            .find((member) => member.id === "member-app-story-seed-writer");
          assert.equal(
            repairedMember?.model,
            "deepseek-v4-flash",
            "a provider-bound employee must not retain the login-only default sentinel written by a stale UI",
          );
          assert.deepEqual(
            repairedMember?.userOverrides,
            ["kernel", "reasoningEffort"],
            "repairing the stale model must remove only the bogus model override",
          );
          const repairedLegacyPm = wwBoundState.app.rooms
            .listMembers()
            .find((member) => member.id === "member-app-story-seed-legacy-pm");
          assert.equal(
            repairedLegacyPm?.model,
            "deepseek-v4-flash",
            "a generated App PM must migrate the legacy native sentinel to its concrete product default",
          );
          assert.equal(
            repairedLegacyPm?.providerId,
            undefined,
            "an existing concrete-model binding to the same Provider should remain the route owner",
          );
          assert.equal(
            wwBoundState.app.rooms.listMembers().find((member) => member.id === "explicit-native-employee")?.model,
            "deepseek-v4-flash",
            "the retired native sentinel must be translated even when an old UI recorded it as an explicit override",
          );
          assert.deepEqual(
            wwBoundState.app.rooms.listMembers().find((member) => member.id === "explicit-native-employee")
              ?.userOverrides,
            undefined,
            "following the migrated product model must not stay pinned as a legacy model override",
          );
          assert.equal(
            wwBoundState.app.rooms.listMembers().find((member) => member.id === "native-capable-employee")?.model,
            "deepseek-v4-flash",
            "a generated App Employee without a user model override must not retain the legacy sentinel",
          );

          // 回归:provider 带 models 时 merge 不得清空 SDK 学到的思考强度档位
          // (claude-code 运行时对任何绑定方式都会把 requestedEffort 传给 SDK)。
          const learnedClaudeHome = join(cwd, "ww-provider-learned-claude-home");
          mkdirSync(learnedClaudeHome, { recursive: true });
          writeFileSync(
            join(learnedClaudeHome, "opengrove-models-cache.json"),
            JSON.stringify({
              updatedAt: "2026-07-09T00:00:00.000Z",
              models: [
                {
                  id: "claude-opus-4-8",
                  label: "Claude Opus 4.8",
                  supportsEffort: true,
                  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
                },
              ],
            }),
          );
          wwBoundState.settings.kernelPathOverrides = {
            ...wwBoundState.settings.kernelPathOverrides,
            "claude-code": { configHome: learnedClaudeHome },
          };
          const wwBoundControls = buildBridgeRuntimeControlsForKernel(wwBoundState, "claude-code");
          assert.deepEqual(
            (wwBoundControls.reasoningEfforts as Array<{ id: string }>).map((option) => option.id),
            ["low", "medium", "high", "xhigh", "max"],
            "WW-bound Claude Code should keep SDK-learned reasoning effort options",
          );
        },
      );
      await withEnv(
        {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CONFIG_DIR: undefined,
          [appEnvName("ANTHROPIC_API_KEY")]: undefined,
          [appEnvName("ANTHROPIC_AUTH_TOKEN")]: undefined,
          [appEnvName("BRIDGE_SETTINGS_PATH")]: join(cwd, "native-seed-migration-settings.json"),
        },
        async () => {
          const appRoot = join(cwd, "native-seed-migration-app");
          const configHome = join(cwd, "native-seed-migration-claude-home");
          const settingsPath = join(cwd, "native-seed-migration-settings.json");
          const statePath = join(cwd, "native-seed-migration-state.json");
          mkdirSync(appRoot, { recursive: true });
          mkdirSync(configHome, { recursive: true });
          writeFileSync(
            join(appRoot, "opengrove.app.json"),
            JSON.stringify({
              id: "story-seed",
              title: "Story Seed",
              employees: [
                {
                  id: "writer",
                  name: "Writer",
                  kernel: "claude-code",
                  model: "deepseek-v4-flash",
                  role: "Writes the story.",
                },
              ],
            }),
            "utf8",
          );
          writeFileSync(
            settingsPath,
            JSON.stringify(
              {
                ...defaultBridgeSettings(),
                kernel: "claude-code",
                kernelPathOverrides: {
                  "claude-code": { binaryPath: fakeClaude, configHome },
                },
                mountedApps: [
                  {
                    id: "story-seed",
                    path: appRoot,
                    enabled: true,
                  },
                ],
                modelProviderBindings: [
                  { modelId: "claude-opus-4-8", providerId: "ww" },
                  { modelId: "deepseek-v4-pro", providerId: "ww" },
                  { modelId: "deepseek-v4-flash", providerId: "ww" },
                ],
                customProviders: [
                  {
                    id: "ww",
                    name: "WW",
                    custom: true,
                    origin: "user",
                    protocol: "anthropic-compatible",
                    credentialKind: "api-key",
                    anthropicBaseUrl: "https://ww.example.test",
                    apiKey: "ww-key",
                    models: [
                      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
                      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
                      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
                    ],
                  },
                ],
              },
              null,
              2,
            ),
            "utf8",
          );

          const seededState = createBridgeState({ statePath });

          const memberId = pmAgentMemberId("story-seed");
          seededState.app.rooms.upsertMember(
            normalizeRoomMember({
              id: memberId,
              employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
              name: "PM",
              kernel: "claude-code",
              model: "native",
              role: "legacy persisted App PM",
              status: "idle",
              color: "green",
              lastActive: "configured",
              appId: "story-seed",
            }),
          );
          seededState.store.saveFrom(seededState.app);

          recreateBridgeApp(seededState);
          const migratedMember = seededState.app.rooms.listMembers().find((member) => member.id === memberId);
          assert.equal(migratedMember?.model, "deepseek-v4-flash");
          assert.equal(
            migratedMember?.providerId,
            undefined,
            "an App-scoped PM should inherit the concrete model's saved Provider default",
          );
          assert.deepEqual(
            migratedMember?.userOverrides,
            undefined,
            "product migration must not turn generated defaults into user overrides",
          );
          const migratedRoute = resolveRoomTargetProviderRoute(seededState, migratedMember!);
          assert.equal(migratedRoute.providerId, "ww");
          assert.equal(migratedRoute.binding.kind, "provider");
          if (migratedRoute.binding.kind === "provider") assert.equal(migratedRoute.binding.status, "ready");
          assert.doesNotThrow(
            () => resolveRoomExecutionTarget(seededState, migratedMember!),
            "the migrated mounted App employee must build a runnable Room execution target",
          );

          await seededState.store.close?.();
          const restartedState = createBridgeState({ statePath });
          const restartedMember = restartedState.app.rooms.listMembers().find((member) => member.id === memberId);
          assert.equal(restartedMember?.model, "deepseek-v4-flash");
          assert.equal(restartedMember?.providerId, undefined);
          const restartedRoute = resolveRoomTargetProviderRoute(restartedState, restartedMember!);
          assert.equal(restartedRoute.providerId, "ww");
          assert.equal(restartedRoute.binding.kind, "provider");
          if (restartedRoute.binding.kind === "provider") assert.equal(restartedRoute.binding.status, "ready");
          await restartedState.store.close?.();
        },
      );

      await withEnv(
        {
          ANTHROPIC_API_KEY: "local-claude-key-that-must-not-be-used",
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CONFIG_DIR: undefined,
          [appEnvName("ANTHROPIC_API_KEY")]: undefined,
          [appEnvName("ANTHROPIC_AUTH_TOKEN")]: undefined,
          [appEnvName("WW_API_KEY")]: undefined,
          OPENGROVE_TEST_MISSING_KEY: undefined,
          [appEnvName("BRIDGE_SETTINGS_PATH")]: join(cwd, "ww-provider-missing-key-settings.json"),
        },
        async () => {
          const missingKeyState = createBridgeState({ statePath: join(cwd, "ww-provider-missing-key-state.json") });
          missingKeyState.settings.kernel = "claude-code";
          missingKeyState.model = "claude-opus-4-8";
          missingKeyState.settings.modelProviderBindings = [
            { modelId: missingKeyState.model, providerId: "ww" },
            { modelId: "codex-default", providerId: "ready-shared" },
            { modelId: "hermes-default", providerId: "ready-shared" },
          ];
          missingKeyState.settings.customProviders = [
            {
              id: "ww",
              name: "WW",
              custom: true,
              enabled: true,
              origin: "user",
              protocol: "anthropic-compatible",
              anthropicBaseUrl: "https://ww.example.test",
              credentialKind: "api-key",
              models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
            },
            {
              id: "missing-openai",
              name: "Missing OpenAI",
              custom: true,
              enabled: true,
              origin: "user",
              protocol: "openai-compatible",
              openaiBaseUrl: "https://openai.example.test/v1",
              credentialKind: "api-key",
              apiKeyEnv: "OPENGROVE_TEST_MISSING_KEY",
              models: [{ id: "gpt-test", label: "GPT Test" }],
            },
            {
              id: "ready-shared",
              name: "Ready shared Provider",
              custom: true,
              enabled: true,
              origin: "user",
              protocol: "openai-compatible",
              openaiBaseUrl: "https://ready-shared.example.test/v1",
              apiKey: "ready-shared-test-key",
              credentialKind: "api-key",
              models: [
                { id: "codex-default", label: "Codex Default" },
                { id: "hermes-default", label: "Hermes Default" },
              ],
            },
          ];

          recreateBridgeApp(missingKeyState);
          const missingKeyClaude = getBridgeKernelOptions(missingKeyState).find(
            (option) => option.id === "claude-code",
          );
          assert.equal(missingKeyClaude?.bindingKind, "provider");
          assert.equal(
            missingKeyClaude?.bindingStatus,
            "missing-key",
            "A compatible WW route without a key must be reported as not ready, not unsupported",
          );
          assert.deepEqual(
            (buildBridgeRuntimeControlsForKernel(missingKeyState, "claude-code").models as Array<{ id: string }>).map(
              (model) => model.id,
            ),
            [],
            "A provider without a usable key must not advertise available models",
          );
          assert.equal(
            missingKeyClaude?.available,
            false,
            "An explicitly selected WW provider without a key must not fall back to local Claude credentials",
          );
          assert.equal(missingKeyState.kernel, "claude-code");
          assert.match(
            missingKeyState.kernelUnavailableReason ?? "",
            /WW.*(?:key|credential|凭据)/i,
            "The selected WW route should stay selected and surface an actionable unavailable reason",
          );
          assert.equal(missingKeyState.kernelUnavailableCode, "ww_provider_key_missing");
          const missingKeyOptions = getBridgeKernelOptions(missingKeyState);
          for (const kernelId of ["codex", "hermes"] as const) {
            const option = missingKeyOptions.find((item) => item.id === kernelId);
            assert.equal(option?.bindingStatus, "ready");
            assert.notEqual(option?.providerId, "ww");
            assert.equal(
              option?.available,
              true,
              `A Claude Provider failure must not disable ${kernelId}'s own ready route`,
            );
            assert.equal(resolveBridgeKernel(kernelId, missingKeyState), kernelId);
          }
          await withEnv({ [appEnvName("VOLC_CODING_API_KEY")]: undefined }, async () => {
            const webSettings = getBridgeSettingsSnapshot(missingKeyState);
            const webKernels = webSettings.kernels as Array<Record<string, unknown>>;
            const webCodex = webKernels.find((item) => item.id === "codex");
            assert.equal(webCodex?.bindingStatus, "ready");
            assert.notEqual(webCodex?.providerId, "ww");
            const webProviders = webSettings.providers as Array<Record<string, unknown>>;
            assert.ok(
              webProviders.every((provider) => Array.isArray(provider.models) && provider.models.length === 0),
              "the production /settings read model must not inline complete Provider model catalogs",
            );
            assert.ok(
              Buffer.byteLength(JSON.stringify(webProviders)) < 20_000,
              "the production /settings Provider summary must stay bounded",
            );
            const openAiSummary = webProviders.find((provider) => provider.id === "openai");
            assert.equal(openAiSummary?.modelCount, 30, "Provider summaries must retain the catalog model count");
            const providerModelCatalog = getBridgeProviderModelCatalog(missingKeyState.settings.customProviders);
            assert.equal(
              providerModelCatalog.find((provider) => provider.id === "openai")?.models.length,
              30,
              "the independent Provider model catalog must retain the complete model list",
            );
            const volcRuntime = webProviders.find((provider) => provider.id === "volc-coding-plan")?.runtime as Record<
              string,
              unknown
            >;
            const volcCredential = volcRuntime.credential as Record<string, unknown>;
            assert.equal(
              volcCredential.configured,
              false,
              "the production /settings read model must describe missing credentials",
            );
            assert.equal(volcRuntime.active, false, "missing credentials and activation must remain separate states");
          });
        },
      );
      const wwHermesProvider = resolveTestProvider("hermes", "claude-opus-4-8", "ww");
      const wwHermesEnv = providerEnvForKernel("hermes", wwHermesProvider, undefined);
      assert.equal(wwHermesEnv?.[appEnvName("WW_API_KEY")], "ww_sk_test");
      const wwPiProvider = resolveTestProvider("pi", "deepseek-v4-pro", "ww");
      const wwPiEnv = providerEnvForKernel("pi", wwPiProvider, undefined);
      assert.equal(wwPiEnv?.ANTHROPIC_BASE_URL, "https://ww.example.test");
      assert.equal(wwPiEnv?.ANTHROPIC_AUTH_TOKEN, "ww_sk_test");
      const wwKimiProvider = resolveTestProvider("kimi", "deepseek-v4-pro", "ww");
      assert.ok(wwKimiProvider, "Kimi Code should accept WW through its native Anthropic provider channel");
      assert.equal(
        createKimiKernelAdapter({ command: "/bin/false" }).bindingMode,
        getBridgeKernelDescriptor("kimi").bindingMode,
        "the Kimi adapter and Provider planner must agree on env-based binding",
      );
      const wwKimiEnv = providerEnvForKernel("kimi", wwKimiProvider, "deepseek-v4-pro");
      assert.deepEqual(wwKimiEnv, {
        KIMI_MODEL_NAME: "deepseek-v4-pro",
        KIMI_MODEL_API_KEY: "ww_sk_test",
        KIMI_MODEL_BASE_URL: "https://ww.example.test",
        KIMI_MODEL_PROVIDER_TYPE: "anthropic",
      });

      const volcRouting: Record<BridgeKernelId, string | undefined> = {
        codex: "glm-5.1",
        "claude-code": "opus",
        hermes: "glm-5.1",
        pi: "glm-5.1",
        openclaw: undefined,
        opencode: "opengrove-volc-coding-plan/glm-5.1",
        kimi: "glm-5.1",
      };
      for (const kernelId of BRIDGE_KERNEL_IDS) {
        const boundProvider = resolveTestProvider(kernelId, "glm-5.1", "volc-coding-plan");
        const expectedModel = volcRouting[kernelId];
        if (!expectedModel) {
          assert.equal(boundProvider, undefined, `${kernelId} should reject incompatible Volc provider binding`);
          continue;
        }
        assert.ok(boundProvider, `${kernelId} should resolve Volc provider binding`);
        assert.equal(
          kernelModelForProviderSelection(kernelId, boundProvider, "glm-5.1"),
          expectedModel,
          `${kernelId} should route provider model through the kernel-specific model contract`,
        );
      }

      const profiles = getBridgeProviderProfiles();
      const openai = profiles.find((profile) => profile.id === "openai");
      const anthropic = profiles.find((profile) => profile.id === "anthropic");
      const openrouter = profiles.find((profile) => profile.id === "openrouter");
      assert.ok(openai && anthropic && openrouter);
      const expectedBuiltinModels: Record<string, string[]> = {
        ww: ["deepseek-v4-flash", "claude-opus-4-8", "deepseek-v4-pro"],
        anthropic: ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"],
        gemini: ["gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
        deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
        "zhipu-glm": ["glm-5"],
        kimi: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
        minimax: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
      };
      for (const [providerId, modelIds] of Object.entries(expectedBuiltinModels)) {
        assert.deepEqual(
          profiles.find((profile) => profile.id === providerId)?.models.map((model) => model.id),
          modelIds,
          `${providerId} should expose its current built-in model list in default-first order`,
        );
      }
      const deepseek = profiles.find((profile) => profile.id === "deepseek");
      assert.ok(deepseek);
      const resolvedDeepseekModels = getAllBridgeProviderProfiles(undefined).find(
        (profile) => profile.id === "deepseek",
      )?.models;
      assert.deepEqual(
        getAllBridgeProviderProfiles([{ ...deepseek, custom: true, models: [] }]).find(
          (profile) => profile.id === "deepseek",
        )?.models,
        resolvedDeepseekModels,
        "an existing built-in provider with an empty saved model list should inherit the bundled catalog",
      );
      assert.deepEqual(
        normalizeOpenAiModelsResponse({
          data: [
            { id: "gpt-6-test", created: 30 },
            { id: "ft:gpt-5-test:org:project:suffix", created: 25 },
            { id: "whisper-large-v4", created: 99 },
            { id: "gpt-5.5", created: 10 },
            { id: "o5-mini", created: 20 },
            { id: "text-embedding-4-large", created: 98 },
            { id: "gpt-5.5-audio", created: 97 },
          ],
        }).map((model) => model.id),
        ["gpt-6-test", "ft:gpt-5-test:org:project:suffix", "o5-mini", "gpt-5.5"],
        "OpenAI model discovery keeps chat-capable gpt-*/o*/ft:gpt-* ids newest-first and drops non-chat endpoints",
      );
      assert.deepEqual(
        normalizeAnthropicModelsResponse({
          data: [
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-01-05T00:00:00Z" },
            { id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-01T00:00:00Z" },
            { id: "", display_name: "broken row", created_at: "2026-06-02T00:00:00Z" },
          ],
        }),
        [
          { id: "claude-fable-5", label: "Claude Fable 5" },
          { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
        ],
        "Anthropic model discovery keeps API-declared ids and labels newest-first",
      );
      const discoveryRequests: string[] = [];
      const discoveryNow = new Date();
      let inactiveDiscoveryRequests = 0;
      await refreshProviderModelDiscovery({
        profiles: getAllBridgeProviderProfiles(undefined),
        force: true,
        now: discoveryNow,
        fetchImpl: async () => {
          inactiveDiscoveryRequests += 1;
          return new Response("inactive Provider must not be queried", { status: 500 });
        },
      });
      assert.equal(
        inactiveDiscoveryRequests,
        0,
        "environment credentials alone must not register built-in Providers for model discovery",
      );
      const activeDiscoveryProfiles = getAllBridgeProviderProfiles([
        { ...openai, custom: true, enabled: true },
        { ...anthropic, custom: true, enabled: true },
      ]);
      await refreshProviderModelDiscovery({
        profiles: activeDiscoveryProfiles,
        force: true,
        now: discoveryNow,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          discoveryRequests.push(url.toString());
          if (url.hostname === "api.openai.com") {
            return Response.json({ data: [{ id: "gpt-6-test", created: 30 }] });
          }
          if (url.hostname === "api.anthropic.com" && !url.searchParams.has("after_id")) {
            return Response.json({
              data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-01-05T00:00:00Z" }],
              has_more: true,
              last_id: "claude-opus-4-8",
            });
          }
          if (url.hostname === "api.anthropic.com" && url.searchParams.get("after_id") === "claude-opus-4-8") {
            return Response.json({
              data: [{ id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-01T00:00:00Z" }],
              has_more: false,
              last_id: "claude-fable-5",
            });
          }
          return new Response("unexpected model discovery request", { status: 500 });
        },
      });
      const anthropicDiscoveryRequests = discoveryRequests
        .map((url) => new URL(url))
        .filter((url) => url.hostname === "api.anthropic.com");
      assert.equal(anthropicDiscoveryRequests.length, 2, "Anthropic discovery should follow has_more pagination");
      assert.equal(anthropicDiscoveryRequests[0]?.searchParams.get("limit"), "1000");
      assert.equal(anthropicDiscoveryRequests[0]?.searchParams.has("after_id"), false);
      assert.equal(anthropicDiscoveryRequests[1]?.searchParams.get("after_id"), "claude-opus-4-8");
      assert.deepEqual(
        getAllBridgeProviderProfiles(undefined)
          .find((profile) => profile.id === "openai")
          ?.models.map((model) => model.id),
        ["gpt-6-test"],
        "fresh discovered provider models must replace the static declaration",
      );
      assert.deepEqual(
        getAllBridgeProviderProfiles([
          {
            ...openai,
            custom: true,
            modelsPinned: true,
            models: [{ id: "gpt-user-pinned", label: "User Pinned" }],
          },
        ])
          .find((profile) => profile.id === "openai")
          ?.models.map((model) => model.id),
        ["gpt-user-pinned"],
        "an explicit user model list must take precedence over discovered models",
      );
      assert.deepEqual(
        getAllBridgeProviderProfiles([
          {
            ...openai,
            custom: true,
            modelsPinned: false,
            models: [{ id: "gpt-derived-ui-copy", label: "Derived UI Copy" }],
          },
        ])
          .find((profile) => profile.id === "openai")
          ?.models.map((model) => model.id),
        ["gpt-6-test"],
        "a displayed model list saved by the UI must not disable runtime discovery",
      );
      assert.equal(
        normalizeCustomProviderProfiles([
          {
            ...openai,
            custom: true,
            modelsPinned: false,
            models: [{ id: "gpt-derived-ui-copy", label: "Derived UI Copy" }],
          },
        ])[0]?.modelsPinned,
        false,
        "the unpinned signal must survive settings normalization",
      );
      assert.deepEqual(
        getAllBridgeProviderProfiles(undefined)
          .find((profile) => profile.id === "anthropic")
          ?.models.map((model) => model.id),
        ["claude-fable-5", "claude-opus-4-8"],
        "Anthropic discovery should merge every page before caching the model list",
      );
      assert.equal(
        readDiscoveredProviderModels(openai, new Date(discoveryNow.getTime() + 13 * 60 * 60 * 1000)),
        undefined,
        "provider discovery cache must expire after its 12-hour TTL",
      );
      process.env.OPENAI_API_KEY = "different-openai-test-key";
      assert.ok(
        getAllBridgeProviderProfiles(undefined)
          .find((profile) => profile.id === "openai")
          ?.models.some((model) => model.id === "gpt-5.5"),
        "a cache from another API key must fall back to the static model list",
      );
      process.env.OPENAI_API_KEY = "openai-test-key";
      const otherEndpointOpenAi: BridgeProviderProfile = {
        ...openai,
        custom: true,
        openaiBaseUrl: "https://other-openai.example.test/v1",
        models: [],
      };
      assert.ok(
        getAllBridgeProviderProfiles([otherEndpointOpenAi])
          .find((profile) => profile.id === "openai")
          ?.models.some((model) => model.id === "gpt-5.5"),
        "a cache from another endpoint must fall back to the static model list",
      );
      delete process.env.OPENAI_API_KEY;
      let refreshWithoutKeyCalls = 0;
      await refreshProviderModelDiscovery({
        profiles: [{ ...openai, custom: true, enabled: true }],
        force: true,
        fetchImpl: async () => {
          refreshWithoutKeyCalls += 1;
          return new Response("unexpected", { status: 500 });
        },
      });
      assert.equal(refreshWithoutKeyCalls, 0, "provider discovery should not call the API without a key");
      assert.ok(
        getAllBridgeProviderProfiles(undefined)
          .find((profile) => profile.id === "openai")
          ?.models.some((model) => model.id === "gpt-5.5"),
        "removing the API key must invalidate discovered models and restore the static fallback",
      );
      process.env.OPENAI_API_KEY = "openai-test-key";
      assert.equal(providerSupportsKernel("codex", openai), true, "Codex can use the OpenAI API Provider");
      assert.equal(
        providerSupportsKernel("claude-code", openai),
        false,
        "Claude Code cannot use an OpenAI-compatible Provider through its Anthropic route",
      );
      assert.equal(providerSupportsKernel("pi", openai), true, "Pi can use the OpenAI API Provider");
      assert.equal(
        providerSupportsKernel("claude-code", anthropic),
        true,
        "Claude Code can use Anthropic-compatible providers",
      );
      assert.equal(
        providerSupportsKernel("hermes", openai),
        true,
        "Hermes can use the OpenAI API Provider through isolated config",
      );
      assert.equal(
        providerSupportsKernel("hermes", anthropic),
        true,
        "Hermes can use Anthropic-compatible providers through isolated config",
      );
      assert.equal(
        providerSupportsKernel("hermes", openrouter),
        true,
        "Hermes can use OpenAI-compatible providers through isolated config",
      );
      assert.equal(
        providerSupportsKernel("kimi", anthropic),
        true,
        "Kimi Code can use Anthropic-compatible providers through KIMI_MODEL_* overrides",
      );
      assert.equal(
        providerSupportsKernel("kimi", openrouter),
        true,
        "Kimi Code can use OpenAI-compatible providers through KIMI_MODEL_* overrides",
      );
      assert.equal(
        providerSupportsKernel("openclaw", openrouter),
        false,
        "OpenClaw should use Gateway-native configuration, not provider bindings",
      );
      const discoveredCodexLogin: BridgeProviderProfile = {
        ...openai,
        id: "codex-login",
        name: "ChatGPT",
        custom: true,
        origin: "discovered",
        sourceKernel: "codex",
        authConfigured: true,
        routeKind: "login",
        protocol: "native-oauth",
        credentialKind: "native-login",
      };
      assert.equal(
        providerSupportsKernel("codex", discoveredCodexLogin),
        true,
        "Codex should keep its own discovered account login",
      );
      assert.equal(
        providerSupportsKernel("hermes", discoveredCodexLogin),
        false,
        "Discovered Codex login is not a transferable provider",
      );
      const discoveredClaudeBedrock: BridgeProviderProfile = {
        id: "aws-bedrock",
        name: "AWS Bedrock",
        custom: true,
        origin: "discovered",
        sourceKernel: "claude-code",
        authConfigured: true,
        routeKind: "provider",
        protocol: "anthropic-compatible",
        credentialKind: "aws",
        anthropicBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [{ id: "opus", label: "Opus" }],
      };
      assert.equal(
        providerSupportsKernel("claude-code", discoveredClaudeBedrock),
        true,
        "Claude Code Bedrock is a provider config for Claude Code",
      );
      assert.equal(
        providerEnvForKernel("claude-code", discoveredClaudeBedrock, "opus"),
        undefined,
        "Claude Code-managed Provider config should remain unmanaged by the host",
      );
      assert.equal(
        providerSupportsKernel("hermes", discoveredClaudeBedrock),
        false,
        "Bedrock credentials should not be offered to kernels without Bedrock support",
      );
      const discoveredClaudeBedrockApiKey: BridgeProviderProfile = {
        ...discoveredClaudeBedrock,
        id: "aws-bedrock-api-key",
        name: "AWS Bedrock (API Key)",
        sourceKernel: undefined,
        authConfigured: undefined,
        apiKey: "ABSKinline-bedrock-test-key",
        models: [
          {
            id: "sonnet",
            label: "Sonnet · us.anthropic.claude-sonnet-4-6",
            description: "provider model: us.anthropic.claude-sonnet-4-6",
          },
        ],
      };
      assert.equal(
        providerSupportsKernel("claude-code", discoveredClaudeBedrockApiKey),
        true,
        "Claude Code can use a Bedrock bearer token provider",
      );
      const claudeBedrockEnv = providerEnvForKernel("claude-code", discoveredClaudeBedrockApiKey, "sonnet");
      assert.equal(claudeBedrockEnv?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(claudeBedrockEnv?.CLAUDE_CODE_USE_BEDROCK, "1");
      assert.equal(claudeBedrockEnv?.AWS_REGION, "us-east-1");
      assert.equal(claudeBedrockEnv?.ANTHROPIC_BEDROCK_BASE_URL, "https://bedrock-runtime.us-east-1.amazonaws.com");
      assert.equal(claudeBedrockEnv?.AWS_BEARER_TOKEN_BEDROCK, "ABSKinline-bedrock-test-key");
      const claudeVertex: BridgeProviderProfile = {
        id: "google-vertex-external",
        name: "Google Vertex AI (External)",
        custom: true,
        protocol: "anthropic-compatible",
        credentialKind: "google-adc",
        anthropicBaseUrl: "https://vertex.internal.example/v1",
        models: [{ id: "sonnet", label: "Sonnet" }],
      };
      const claudeVertexEnv = providerEnvForKernel("claude-code", claudeVertex, "sonnet");
      assert.equal(claudeVertexEnv?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(claudeVertexEnv?.CLAUDE_CODE_USE_VERTEX, "1");
      assert.equal(claudeVertexEnv?.ANTHROPIC_VERTEX_BASE_URL, "https://vertex.internal.example/v1");
      const claudeApiKeyProxy: BridgeProviderProfile = {
        id: "claude-api-key-proxy",
        name: "Claude API-key proxy",
        custom: true,
        protocol: "anthropic-compatible",
        credentialKind: "api-key",
        anthropicBaseUrl: "https://proxy.internal.example/bedrock/v1",
        apiKey: "claude-proxy-key",
        models: [{ id: "sonnet", label: "Sonnet" }],
      };
      const claudeApiKeyProxyEnv = providerEnvForKernel("claude-code", claudeApiKeyProxy, "sonnet");
      assert.equal(claudeApiKeyProxyEnv?.ANTHROPIC_BASE_URL, "https://proxy.internal.example/bedrock/v1");
      assert.equal(
        claudeApiKeyProxyEnv?.CLAUDE_CODE_USE_BEDROCK,
        undefined,
        "Claude dispatch must use credentialKind, not URL text",
      );
      assert.equal(
        claudeApiKeyProxyEnv?.CLAUDE_CODE_USE_VERTEX,
        undefined,
        "Claude dispatch must use credentialKind, not URL text",
      );
      assert.equal(
        providerSupportsKernel("opencode", discoveredClaudeBedrockApiKey),
        true,
        "OpenCode can use the Amazon Bedrock Provider",
      );
      assert.equal(
        providerSupportsKernel("opencode", anthropic),
        false,
        "OpenCode should not offer Anthropic-compatible providers unless a config generator exists",
      );
      assert.equal(
        kernelModelForProviderSelection("opencode", discoveredClaudeBedrockApiKey, "sonnet"),
        "amazon-bedrock/sonnet",
        "OpenCode Bedrock model ids should be qualified with the built-in Amazon Bedrock provider",
      );
      const opencodeBedrockEnv = providerEnvForKernel("opencode", discoveredClaudeBedrockApiKey, "sonnet");
      assert.equal(opencodeBedrockEnv?.AWS_BEARER_TOKEN_BEDROCK, "ABSKinline-bedrock-test-key");
      const opencodeBedrockConfig = JSON.parse(opencodeBedrockEnv?.OPENCODE_CONFIG_CONTENT ?? "{}") as any;
      assert.equal(opencodeBedrockConfig.model, "amazon-bedrock/sonnet");
      assert.equal(opencodeBedrockConfig.provider["amazon-bedrock"].options.region, "us-east-1");
      assert.equal(opencodeBedrockConfig.provider["amazon-bedrock"].models.sonnet.id, "us.anthropic.claude-sonnet-4-6");
      const discoveredHermesVolc: BridgeProviderProfile = {
        id: "hermes-volc",
        name: "Hermes Volc",
        custom: true,
        origin: "discovered",
        sourceKernel: "hermes",
        authConfigured: true,
        protocol: "openai-compatible",
        openaiBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        models: [{ id: "glm-5.1", label: "GLM-5.1" }],
      };
      assert.equal(
        providerSupportsKernel("hermes", discoveredHermesVolc),
        true,
        "Hermes can keep its Kernel-managed Provider",
      );
      assert.equal(
        providerSupportsKernel("codex", discoveredHermesVolc),
        false,
        "A Kernel-managed Provider without a transferable key should not be cross-bound",
      );
      assert.equal(
        providerSupportsKernel("codex", { ...discoveredHermesVolc, apiKeyEnv: appEnvName("VOLC_CODING_API_KEY") }),
        true,
        "Providers with a reusable key env can be offered to compatible kernels",
      );
      assert.equal(
        providerBindingFingerprint({
          kernelId: "codex",
          provider: codexVolc,
          providerModel: "glm-5.1",
          kernelModel: "glm-5.1",
        }),
        providerBindingFingerprint({
          kernelId: "codex",
          provider: codexVolc,
          providerModel: "minimax-m2.7",
          kernelModel: "minimax-m2.7",
        }),
        "Codex should keep the same native thread when only the model changes inside one provider binding",
      );

      state.app.knowledge.upsert({
        id: "test.project-claude-skill",
        type: "skill",
        title: "Project-only Claude skill",
        body: "project skill",
        tags: ["skill"],
        sourceRefs: [{ title: "project", locator: join(cwd, ".claude", "skills", "demo", "SKILL.md") }],
        scope: "project",
        metadata: {
          source: "project",
          skillRoot: join(cwd, ".claude", "skills", "demo"),
          entry: join(cwd, ".claude", "skills", "demo", "SKILL.md"),
        },
      });
      state.app.knowledge.upsert({
        id: "test.global-claude-md",
        type: "project_doc",
        title: "CLAUDE.md",
        body: "global rule",
        tags: ["claude", "instructions"],
        sourceRefs: [],
        scope: "user",
        metadata: {
          nativeGlobalKnowledge: true,
          kernelId: "claude-code",
          sourceId: "claude.user-claude-md",
          vaultPath: "Claude/CLAUDE.md",
        },
      });
      const libraryDocuments = filterPrimaryKnowledgeDocuments(state.app.knowledge.list({ limit: 100 }));
      assert.ok(
        libraryDocuments.some((document) => document.id === "test.global-claude-md"),
        "library should show global kernel files",
      );
      assert.ok(
        !libraryDocuments.some((document) => document.id === "test.project-claude-skill"),
        "library should hide project-bound Claude files until OpenGrove has explicit workspace binding",
      );

      state.model = "glm-5.1";
      state.settings.modelProviderBindings = [
        {
          modelId: "glm-5.1",
          providerId: hermesProvider.id,
        },
      ];
      const adapter = createBridgeKernel(state);
      assert.equal(adapter.id, "hermes");
      const health = await adapter.healthCheck();
      assert.equal(health.status, "ok");
    },
  );
}

function resolveTestProvider(
  kernelId: BridgeKernelId,
  modelId: string,
  providerId: string,
  customProviders?: BridgeProviderProfile[],
) {
  const effectiveCustomProviders =
    customProviders ??
    (() => {
      const preset = getBridgeProviderProfiles().find((provider) => provider.id === providerId);
      return preset ? [{ ...preset, custom: true, enabled: true }] : [];
    })();
  return resolveProviderForRoute(kernelId, modelId, undefined, [{ modelId, providerId }], effectiveCustomProviders);
}

function writeFakeCli(cwd: string, name: string, posixLines: string[], windowsLines: string[]): string {
  const windows = process.platform === "win32";
  const path = join(cwd, `${name}${windows ? ".cmd" : ".sh"}`);
  writeFileSync(path, `${(windows ? windowsLines : posixLines).join("\n")}\n`, "utf8");
  if (!windows) chmodSync(path, 0o755);
  return path;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
