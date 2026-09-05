import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-login-provider-choice-"));
const entryPath = join(tempDir, "login-provider-choice-entry.tsx");
const bundlePath = join(tempDir, "login-provider-choice-entry.cjs");
const require = createRequire(import.meta.url);

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [cssStubPlugin()],
  });
  require(bundlePath).runLoginProviderChoiceHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.module\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-module-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-module-stub" }, () => ({
        contents: [
          "const styles = new Proxy({}, { get: (_target, key) => String(key) });",
          "export default styles;",
        ].join("\n"),
        loader: "js",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty-stub" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

function entrySource() {
  const settingsModelPath = resolve(projectRoot, "web/src/components/sidebar/settings-model.ts");
  const settingsKernelPanelPath = resolve(projectRoot, "web/src/components/sidebar/settings-kernel-panel.tsx");
  const settingsProviderSectionPath = resolve(projectRoot, "web/src/components/sidebar/settings-provider-section.tsx");
  const employeeDialogPath = resolve(projectRoot, "web/src/components/rooms/employee-dialog.tsx");
  const roomsModelPath = resolve(projectRoot, "web/src/components/rooms/rooms-model.ts");
  const bridgeSettingsTypesPath = resolve(projectRoot, "web/src/bridge-settings-types.ts");
  const kernelModelsPath = resolve(projectRoot, "web/src/runtime/kernel-models.ts");
  const providerModelCatalogPath = resolve(projectRoot, "web/src/runtime/provider-model-catalog.ts");
  return `
    import assert from "node:assert/strict";
    import React from "react";
    import { LOGIN_PROVIDER_BINDING_ID } from ${JSON.stringify(bridgeSettingsTypesPath)};
    import {
      formatKernelLabel,
      customProvidersAfterEnabledChange,
      isProviderEnabled,
      isProviderUsable,
      isGoogleVertexProviderId,
      modelIdsEquivalent,
      nextModelProviderBindings,
      providerFormFromProfile,
      providerProfileFromForm,
      providerSettingsSections,
      providerServesModel,
      providerSettingsAreSourceManaged,
      providerUsesAmbientCredentials,
      updateProviderForm,
    } from ${JSON.stringify(settingsModelPath)};
    import { SettingsKernelPanel } from ${JSON.stringify(settingsKernelPanelPath)};
    import { SettingsModelProviderBlock, SettingsProviderSection, buildModelProviderRouteRows } from ${JSON.stringify(settingsProviderSectionPath)};
    import { employeeModelOptions, employeeProviderSelection, includeUnavailableEmployeeModelOption, switchEmployeeKernelRuntimeDraft } from ${JSON.stringify(employeeDialogPath)};
    import { isEmployeeKernelSelectable } from ${JSON.stringify(roomsModelPath)};
    import { collapseModelOptions, isKernelDefaultModelOption, kernelBindingLabel, kernelExecutableProbeDescription, modelOptionMatchesId, modelOptionsForKernel } from ${JSON.stringify(kernelModelsPath)};
    import { providerModelCatalogKey, settingsWithProviderModels } from ${JSON.stringify(providerModelCatalogPath)};

    const loginProvider = {
      id: "claude-code-login",
      name: "Claude Agent",
      protocol: "native-oauth",
      routeKind: "login",
      sourceKernel: "claude-code",
      origin: "discovered",
      custom: true,
      enabled: true,
      authConfigured: true,
      credentialKind: "native-login",
      models: [],
    };
    assert.equal(isGoogleVertexProviderId("google-vertex"), true);
    assert.equal(isGoogleVertexProviderId("vertex-ai"), false);
    assert.equal(isGoogleVertexProviderId("google-vertex-ai"), false);
    assert.equal(providerUsesAmbientCredentials("google-vertex"), true);
    assert.equal(providerUsesAmbientCredentials("aws-bedrock"), true);
    assert.equal(providerUsesAmbientCredentials("vertex-ai"), false);
    assert.equal(providerUsesAmbientCredentials("google-vertex-ai"), false);
    function findElementsByType(node, type, output = []) {
      if (Array.isArray(node)) {
        for (const child of node) findElementsByType(child, type, output);
        return output;
      }
      if (!node || typeof node !== "object") return output;
      if (node.type === type) output.push(node);
      const children = node.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        findElementsByType(child, type, output);
      }
      return output;
    }

    function textContent(node) {
      if (Array.isArray(node)) return node.map(textContent).join(" ");
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (!node || typeof node !== "object") return "";
      const children = node.props?.children;
      return (Array.isArray(children) ? children : [children]).map(textContent).join(" ");
    }

    function kernelPanel(providers, providerBindings, onBindProvider = () => {}, available = true) {
      return SettingsKernelPanel({
        t: (key) => key,
        kernels: [{ id: "claude-code", label: "Claude", available, reason: available ? "" : "WW key unavailable" }],
        activeKernel: "claude-code",
        selectedKernel: "claude-code",
        providers,
        providerBindings,
        expandedKernelId: "claude-code",
        kernelPathOverrides: {},
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onBindProvider,
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: () => {},
      });
    }

    function providerSection(provider, onSetProviderEnabled = () => {}, options = {}) {
      return SettingsProviderSection({
        t: (key) => key,
        providers: [provider],
        kernels: [{ id: "claude-code", label: "Claude Agent", available: true }],
        kernelLogins: options.kernelLogins ?? [],
        kernelLoginsLoading: false,
        kernelLoginActionPending: false,
        modelProviderBindings: [],
        selectedProviderId: options.detailOpen ? provider.id : "",
        providerDetailOpen: Boolean(options.detailOpen),
        providerAddOpen: false,
        providerDraftName: "",
        detailForm: providerFormFromProfile(provider),
        editableProviderModels: (provider.models ?? []).map((model) => model.id),
        providerFormError: "",
        providerSaveState: "idle",
        providerApiKeyVisible: false,
        loading: false,
        saving: false,
        onSelectProvider: () => {},
        onOpenProviderAdd: () => {},
        onCloseProviderAdd: () => {},
        onStartAddProvider: () => {},
        onStartAddProviderFrom: options.onStartAddProviderFrom ?? (() => {}),
        onCloseProviderDetail: () => {},
        onSetProviderDeleteTargetId: () => {},
        onSetProviderEnabled,
        onKernelLoginAction: options.onKernelLoginAction ?? (() => {}),
        onBindModelProvider: () => {},
        onSaveProviderProfile: () => {},
        onUpdateProviderField: () => {},
        onUpdatePrimaryBaseUrl: () => {},
        onSetProviderModels: () => {},
        onUpdateProviderModel: () => {},
        onRemoveProviderModelAt: () => {},
        onAddProviderModel: () => {},
        onToggleProviderApiKeyVisible: () => {},
      });
    }

    export function runLoginProviderChoiceHarness() {
      const providerSummarySettings = {
        kernel: "codex",
        activeKernel: "codex",
        activeModel: "gpt-5.6",
        kernelProxy: { enabled: false, proxyUrl: "", noProxy: "", nodeUseEnvProxy: false },
        providers: [{
          id: "openai",
          name: "OpenAI",
          protocol: "openai-compatible",
          models: [],
          modelCount: 2,
          modelCatalogRevision: "catalog-revision-1",
        }],
      };
      assert.equal(providerModelCatalogKey(providerSummarySettings), "openai:catalog-revision-1");
      assert.equal(
        settingsWithProviderModels(providerSummarySettings, undefined),
        undefined,
        "Provider settings must remain loading until the independent model catalog arrives",
      );
      const hydratedProviderSettings = settingsWithProviderModels(providerSummarySettings, {
        ok: true,
        providers: [{
          id: "openai",
          models: [
            { id: "gpt-5.6", label: "GPT-5.6" },
            { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
          ],
        }],
      });
      assert.deepEqual(
        hydratedProviderSettings?.providers?.[0]?.models?.map((model) => model.id),
        ["gpt-5.6", "gpt-5.6-sol"],
        "the independent model catalog must hydrate the bounded /settings Provider summaries",
      );
      const configuredButInactivePreset = {
        id: "openai",
        name: "OpenAI API",
        protocol: "openai-compatible",
        apiKeyEnv: "OPENAI_API_KEY",
        authConfigured: true,
        models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        runtime: {
          active: false,
          usable: false,
          credential: {
            status: "configured",
            configured: true,
            source: "environment",
            writable: true,
          },
        },
      };
      assert.equal(
        isProviderEnabled(configuredButInactivePreset),
        false,
        "a configured credential must not activate a built-in Provider",
      );
      assert.equal(
        isProviderUsable(configuredButInactivePreset),
        false,
        "inactive Provider models must stay out of chat and Employee catalogs",
      );
      const freshUnavailablePreset = {
        id: "xiaomi-mimo",
        name: "Xiaomi MiMo",
        protocol: "openai-compatible",
        models: [{ id: "glm-5.1", label: "GLM-5.1" }],
        runtime: {
          active: false,
          usable: false,
          credential: {
            status: "missing",
            configured: false,
            source: "environment",
            writable: true,
          },
        },
      };
      const settingsSections = providerSettingsSections([
        configuredButInactivePreset,
        freshUnavailablePreset,
        { ...freshUnavailablePreset, id: "my-provider", origin: "user" },
        loginProvider,
      ]);
      assert.deepEqual(
        settingsSections.main.map((provider) => provider.id),
        ["openai", "my-provider"],
        "the main list must contain connected or user-added Providers only",
      );
      assert.deepEqual(
        settingsSections.addable.map((provider) => provider.id),
        ["xiaomi-mimo"],
        "an untouched unavailable preset belongs under Add Provider",
      );
      assert.deepEqual(
        settingsSections.logins.map((provider) => provider.id),
        ["claude-code-login"],
        "runtime Login routes must stay out of both Provider lists",
      );
      let kernelLoginAction;
      const loginSection = providerSection(freshUnavailablePreset, () => {}, {
        kernelLogins: [{
          kernelId: "codex",
          label: "Codex",
          status: "authenticated",
          loginAvailable: true,
          logoutAvailable: true,
        }],
        onKernelLoginAction: (kernelId, action) => { kernelLoginAction = { kernelId, action }; },
      });
      const loginButtons = findElementsByType(loginSection, "button")
        .filter((button) => textContent(button).includes("settings.log"));
      assert.deepEqual(
        loginButtons.map(textContent),
        ["settings.logOut"],
        "an authenticated Kernel Login must expose only its native Log out action",
      );
      loginButtons[0].props.onClick();
      assert.deepEqual(kernelLoginAction, { kernelId: "codex", action: "logout" });
      let configuredNativeProvider;
      const bedrockPreset = { ...freshUnavailablePreset, id: "aws-bedrock-api-key", name: "AWS Bedrock" };
      const bedrockSection = providerSection(bedrockPreset, () => {}, {
        kernelLogins: [{ kernelId: "claude-code", label: "Claude Agent", status: "provider", providerId: "aws-bedrock-api-key", providerLabel: "AWS Bedrock", loginAvailable: false, logoutAvailable: false }],
        onStartAddProviderFrom: (provider) => { configuredNativeProvider = provider.id; },
      });
      const configureButton = findElementsByType(bedrockSection, "button").find((button) => textContent(button) === "settings.configureProvider");
      assert.ok(configureButton, "third-party authentication must provide explicit Provider setup");
      configureButton.props.onClick();
      assert.equal(configuredNativeProvider, "aws-bedrock-api-key");
      assert.equal(findElementsByType(bedrockSection, "button").some((button) => textContent(button) === "settings.logOut"), false);
      assert.equal(providerServesModel(configuredButInactivePreset, "codex", "gpt-5.5"), true);
      assert.equal(
        providerServesModel(configuredButInactivePreset, "codex", "claude-opus-4-8"),
        false,
        "model-first Provider menus must exclude Providers that do not serve the selected model",
      );
      const activatedPresetSettings = customProvidersAfterEnabledChange(
        [],
        configuredButInactivePreset,
        true,
      );
      assert.equal(activatedPresetSettings[0]?.enabled, true);
      assert.equal(
        Object.prototype.hasOwnProperty.call(activatedPresetSettings[0], "runtime"),
        false,
        "Provider activation must not persist the read-only runtime state",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(activatedPresetSettings[0], "authConfigured"),
        false,
        "Provider activation must not persist legacy credential observations",
      );
      assert.deepEqual(
        nextModelProviderBindings([], "deepseek-v4", "deepseek"),
        [{ modelId: "deepseek-v4", providerId: "deepseek" }],
        "A model Provider choice should persist once without a Kernel dimension",
      );
      const modelRouteRows = buildModelProviderRouteRows(
        [{
          ...loginProvider,
          routeKind: "login",
          sourceKernel: "codex",
          protocol: "native-oauth",
          credentialKind: "native-login",
          models: [{ id: "gpt-official", label: "GPT Official" }],
        }, {
          id: "deepseek",
          name: "DeepSeek",
          protocol: "openai-compatible",
          openaiBaseUrl: "https://api.deepseek.test/v1",
          apiKeyEnv: "OPENGROVE_DEEPSEEK_API_KEY",
          enabled: true,
          models: [{ id: "deepseek-v4", label: "DeepSeek V4" }],
        }],
        [{ id: "codex", label: "Codex", available: true }],
      );
      assert.deepEqual(
        modelRouteRows.map((row) => [row.modelId, row.candidates[0]?.providerId]),
        [["deepseek-v4", "deepseek"], ["gpt-official", LOGIN_PROVIDER_BINDING_ID]],
        "Provider settings should expose both Provider and product Login model defaults for one Codex Kernel",
      );
      const sharedModelRows = buildModelProviderRouteRows(
        [{
          id: "shared-gateway",
          name: "Shared Gateway",
          protocol: "openai-compatible",
          openaiBaseUrl: "https://shared.test/v1",
          anthropicBaseUrl: "https://shared.test/anthropic",
          apiKeyEnv: "OPENGROVE_SHARED_GATEWAY_API_KEY",
          enabled: true,
          models: [{ id: "shared-model", label: "Shared Model" }],
        }],
        [
          { id: "claude-code", label: "Claude Agent", available: true },
          { id: "codex", label: "Codex", available: true },
        ],
      );
      assert.equal(
        sharedModelRows.filter((row) => row.modelId === "shared-model").length,
        1,
        "A model exposed through several Kernels must appear once in the Provider settings catalog",
      );
      assert.equal(
        sharedModelRows[0]?.candidates[0]?.providerId,
        "shared-gateway",
        "The single compatible Provider must remain visible on the deduplicated model row",
      );
      assert.deepEqual(
        nextModelProviderBindings([], "shared-model", "shared-gateway"),
        [{ modelId: "shared-model", providerId: "shared-gateway" }],
        "One model-level Provider choice should persist exactly once",
      );
      assert.equal(
        buildModelProviderRouteRows(
          [{
            id: "closed-provider",
            name: "Closed Provider",
            protocol: "openai-compatible",
            openaiBaseUrl: "https://closed.test/v1",
            apiKeyEnv: "OPENGROVE_CLOSED_PROVIDER_API_KEY",
            enabled: false,
            models: [{ id: "closed-model", label: "Closed Model" }],
          }],
          [{ id: "codex", label: "Codex", available: true }],
        ).length,
        0,
        "Models from a disabled Provider must not enter the available model catalog",
      );
      const employeeModels = employeeModelOptions(
        "claude-code",
        {
          kernel: "claude-code",
          source: "claude-code-defaults",
          models: [{ id: "claude-code-default", label: "Follow Claude config" }],
          reasoningEfforts: [],
          speedTiers: [],
        },
        [{
          id: "anthropic",
          name: "Claude Official",
          protocol: "anthropic-compatible",
          sourceKernel: "claude-code",
          origin: "discovered",
          custom: true,
          authConfigured: true,
          credentialKind: "kernel-native",
          models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
        }, {
          id: "ww",
          name: "WW",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://ww.test",
          apiKeyEnv: "OPENGROVE_WW_API_KEY",
          enabled: true,
          models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
        }, {
          id: "unconfigured",
          name: "Unconfigured",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://unconfigured.test",
          models: [{ id: "must-not-leak", label: "Must Not Leak" }],
        }],
      );
      assert.deepEqual(
        employeeModels.map((model) => model.id),
        ["claude-code-default", "claude-opus-4-8", "deepseek-v4-flash"],
        "Employee models must merge the Kernel runtime controls with usable compatible Provider catalogs",
      );
      const sharedCanonicalModel = "anthropic/claude-opus-4-8";
      const equivalentProviderRoutes = [
        {
          id: "anthropic",
          name: "Anthropic",
          protocol: "anthropic-compatible",
          enabled: true,
          anthropicBaseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          credentialKind: "env-key",
          models: [{
            id: "claude-opus-4-8",
            apiModelId: "claude-opus-4-8",
            canonicalModelId: sharedCanonicalModel,
            label: "Claude Opus 4.8",
          }],
        },
        {
          id: "aws-bedrock-api-key",
          name: "AWS Bedrock",
          protocol: "anthropic-compatible",
          enabled: true,
          credentialKind: "aws",
          anthropicBaseUrl: "https://bedrock-runtime.test",
          models: [{
            id: "anthropic.claude-opus-4-8",
            apiModelId: "anthropic.claude-opus-4-8",
            canonicalModelId: sharedCanonicalModel,
            label: "Claude Opus 4.8",
          }],
        },
        {
          id: "google-vertex",
          name: "Google Vertex",
          protocol: "anthropic-compatible",
          enabled: true,
          credentialKind: "google-adc",
          anthropicBaseUrl: "https://vertex.test",
          models: [{
            id: "claude-opus-4-8@default",
            apiModelId: "claude-opus-4-8@default",
            canonicalModelId: sharedCanonicalModel,
            label: "Claude Opus 4.8",
          }],
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          protocol: "anthropic-compatible",
          enabled: true,
          anthropicBaseUrl: "https://openrouter.test",
          apiKeyEnv: "OPENROUTER_API_KEY",
          credentialKind: "env-key",
          models: [{
            id: "anthropic/claude-opus-4.8",
            apiModelId: "anthropic/claude-opus-4.8",
            canonicalModelId: sharedCanonicalModel,
            label: "Claude Opus 4.8",
          }, {
            id: "anthropic/claude-opus-4.8-fast",
            apiModelId: "anthropic/claude-opus-4.8-fast",
            canonicalModelId: sharedCanonicalModel,
            label: "Claude Opus 4.8 (Fast)",
          }],
        },
      ];
      const canonicalModels = employeeModelOptions("claude-code", undefined, equivalentProviderRoutes);
      assert.deepEqual(
        canonicalModels.map((model) => [model.id, model.label]),
        [
          [sharedCanonicalModel, "Claude Opus 4.8"],
          ["anthropic/claude-opus-4.8-fast", "Claude Opus 4.8 (Fast)"],
        ],
        "equivalent public Provider routes must merge without swallowing a differently named offering",
      );
      const nameGroupedRoutes = [{
        id: "private-route",
        name: "Private Route",
        protocol: "anthropic-compatible",
        enabled: true,
        anthropicBaseUrl: "https://private.test",
        apiKey: "private-key",
        models: [{ id: "private-opus", label: "Claude Opus 4.8", canonicalModelId: "private/opus" }],
      }, {
        id: "public-route",
        name: "Public Route",
        protocol: "anthropic-compatible",
        enabled: true,
        anthropicBaseUrl: "https://public.test",
        apiKey: "public-key",
        models: [{ id: "public-opus", label: "Claude Opus 4.8", canonicalModelId: "anthropic/opus" }],
      }];
      const nameGroupedModels = employeeModelOptions("claude-code", undefined, nameGroupedRoutes);
      assert.equal(nameGroupedModels.length, 1, "the same catalog name must render as one model");
      assert.deepEqual(
        employeeProviderSelection(
          "claude-code",
          nameGroupedModels[0].id,
          nameGroupedRoutes,
          [],
          { id: "claude-code", label: "Claude Agent", available: true },
          "",
          (key) => key,
        ).options.map((option) => option.id).sort(),
        ["", "private-route", "public-route"],
        "name grouping must keep every Provider route even when canonical ids differ",
      );
      assert.deepEqual(
        buildModelProviderRouteRows(
          nameGroupedRoutes,
          [{ id: "claude-code", label: "Claude Agent", available: true }],
        ).map((row) => [row.label, row.candidates.map((candidate) => candidate.providerId).sort()]),
        [["Claude Opus 4.8", ["private-route", "public-route"]]],
        "Provider defaults must also show one name-grouped model with both routes",
      );
      assert.equal(
        modelOptionMatchesId(canonicalModels[1], sharedCanonicalModel),
        false,
        "a differently named offering must not claim the canonical standard selection as one of its route ids",
      );
      for (const provider of equivalentProviderRoutes) {
        assert.equal(
          providerServesModel(provider, "claude-code", sharedCanonicalModel),
          true,
          provider.id + " must still serve the canonical selection through its exact route id",
        );
      }
      assert.deepEqual(
        employeeProviderSelection(
          "claude-code",
          sharedCanonicalModel,
          equivalentProviderRoutes,
          [{ modelId: "claude-opus-4-8", providerId: "anthropic" }],
          { id: "claude-code", label: "Claude Code", available: true },
          "",
          (key) => key,
        ).options.map((option) => option.id).sort(),
        ["anthropic", "aws-bedrock-api-key", "google-vertex", "openrouter"],
        "the canonical model must retain every compatible Provider route and legacy raw-id binding",
      );
      assert.deepEqual(
        employeeProviderSelection(
          "claude-code",
          "anthropic/claude-opus-4.8-fast",
          equivalentProviderRoutes,
          [],
          { id: "claude-code", label: "Claude Code", available: true },
          "",
          (key) => key,
        ).options.map((option) => option.id),
        ["", "openrouter"],
        "a distinct offering must only list Providers that expose its exact model id",
      );
      assert.equal(
        modelIdsEquivalent(
          sharedCanonicalModel,
          "anthropic/claude-opus-4.8-fast",
          equivalentProviderRoutes,
          "openrouter",
        ),
        false,
        "a standard model binding must not be treated as equivalent to a differently named offering",
      );
      const differentiatedOfferings = collapseModelOptions([
        { id: "openai/gpt-oss-20b", label: "GPT OSS 20B", canonicalModelId: "openai/gpt-oss-20b" },
        { id: "openai/gpt-oss-20b:free", label: "gpt-oss-20b (free)", canonicalModelId: "openai/gpt-oss-20b" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", canonicalModelId: "moonshotai/kimi-k2.7-code" },
        { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code HighSpeed", canonicalModelId: "moonshotai/kimi-k2.7-code" },
        { id: "anthropic.claude-opus-4-8", label: "Claude Opus 4.8", canonicalModelId: sharedCanonicalModel },
        { id: "global.anthropic.claude-opus-4-8", label: "Claude Opus 4.8 (Global)", canonicalModelId: sharedCanonicalModel },
      ]);
      assert.deepEqual(
        differentiatedOfferings.map((model) => [model.id, model.label]),
        [
          ["openai/gpt-oss-20b", "GPT OSS 20B"],
          ["openai/gpt-oss-20b:free", "gpt-oss-20b (free)"],
          ["moonshotai/kimi-k2.7-code", "Kimi K2.7 Code"],
          ["kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed"],
          [sharedCanonicalModel, "Claude Opus 4.8"],
          ["global.anthropic.claude-opus-4-8", "Claude Opus 4.8 (Global)"],
        ],
        "Free, HighSpeed, and regional offerings must remain separate model choices",
      );
      assert.deepEqual(
        nextModelProviderBindings(
          [{ modelId: "claude-opus-4-8", providerId: "anthropic" }],
          sharedCanonicalModel,
          "",
          equivalentProviderRoutes,
        ),
        [],
        "clearing a canonical binding must also remove its legacy raw-id form",
      );
      assert.deepEqual(
        includeUnavailableEmployeeModelOption(employeeModels, "native", "Unavailable"),
        [
          { id: "native", label: "native (Unavailable)" },
          ...employeeModels,
        ],
        "a stale persisted model must remain visibly selected as unavailable instead of masquerading as the first model",
      );
      assert.equal(
        includeUnavailableEmployeeModelOption(employeeModels, "claude-opus-4-8", "Unavailable"),
        employeeModels,
        "a valid persisted model must reuse the available model list without rewriting it",
      );
      const emptyLoginModels = employeeModelOptions(
        "claude-code",
        {
          kernel: "claude-code",
          source: "claude-code-defaults",
          models: [{ id: "claude-code-default", label: "Follow Claude config" }],
          reasoningEfforts: [],
          speedTiers: [],
        },
        [loginProvider],
      );
      assert.deepEqual(
        emptyLoginModels.map((model) => model.id),
        ["claude-code-default"],
        "A usable Login with no model catalog must still expose the explicit Kernel-default model option",
      );
      assert.deepEqual(
        buildModelProviderRouteRows(
          [loginProvider],
          [{ id: "claude-code", label: "Claude Agent", available: true }],
        ).map((row) => [row.modelId, row.candidates[0]?.providerId]),
        [["claude-code-default", LOGIN_PROVIDER_BINDING_ID]],
        "Provider settings must allow a user to bind an empty-catalog Login explicitly",
      );
      const missingLinkedProviderSection = SettingsModelProviderBlock({
        t: (key) => key,
        providers: [],
        kernels: [{ id: "opencode", label: "OpenCode", available: true }],
        modelProviderBindings: [{ modelId: "gemini-2.5-pro", providerId: "opencode-google" }],
        loading: false,
        saving: false,
        onBindModelProvider: () => {},
      });
      assert.equal(
        missingLinkedProviderSection,
        null,
        "a model default whose Provider disappeared must not create a phantom model row",
      );
      const missingEmployeeProvider = employeeProviderSelection(
        "opencode",
        "gemini-2.5-pro",
        [],
        [{ modelId: "gemini-2.5-pro", providerId: "opencode-google" }],
        { id: "opencode", label: "OpenCode", available: true },
        "",
        (key, replacements) => key === "common.unavailable"
          ? "不可用"
          : key === "employee.providerDefaultBadge"
            ? String(replacements?.provider) + "（默认）"
            : key,
      );
      assert.ok(
        missingEmployeeProvider.options.some((option) => option.label.includes("opencode-google (不可用)")),
        "an employee binding whose linked Provider disappeared must ask for reselection instead of silently rerouting",
      );
      const gatewayManagedProvider = {
        id: "openclaw-gateway-openai",
        name: "Gateway OpenAI",
        origin: "discovered",
        sourceKernel: "openclaw",
        source: "OpenClaw Gateway",
        custom: true,
        authConfigured: true,
        routeKind: "provider",
        protocol: "custom-gateway",
        credentialKind: "gateway-managed",
        models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      };
      assert.equal(
        providerSettingsAreSourceManaged(gatewayManagedProvider),
        true,
        "Gateway-managed Provider details must remain source-owned",
      );
      assert.ok(
        findElementsByType(providerSection(gatewayManagedProvider, () => {}, { detailOpen: true }), "input")
          .every((input) => input.props.readOnly === true),
        "Gateway-managed Provider fields must remain read-only while sharing the normal Provider switch",
      );
      const employeeProviders = employeeProviderSelection(
        "claude-code",
        "claude-opus-4-8",
        [{
          id: "anthropic",
          name: "Claude Official",
          protocol: "anthropic-compatible",
          origin: "user",
          custom: true,
          enabled: true,
          routeKind: "provider",
          credentialKind: "api-key",
          anthropicBaseUrl: "https://api.anthropic.com",
          apiKey: "test-key",
          models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
        }],
        [],
        { id: "claude-code", label: "Claude Agent", available: true },
        "",
        (key, replacements) => key === "employee.providerDefaultBadge"
            ? String(replacements?.provider) + "（默认）"
            : key === "employee.providerRequired"
              ? "请选择 Provider"
            : key,
      ).options;
      assert.deepEqual(
        employeeProviders,
        [
          { id: "", label: "请选择 Provider" },
          { id: "anthropic", label: "Claude Official" },
        ],
        "an explicitly configured Host Provider must remain selectable without becoming an implicit default",
      );
      assert.equal(
        isEmployeeKernelSelectable({
          id: "claude-code",
          label: "Claude Agent",
          available: false,
          installed: true,
          bindingKind: "unresolved",
          bindingStatus: "selection-required",
          unavailableCode: "provider_selection_required",
        }),
        true,
        "an installed Kernel with only a missing Provider selection must remain selectable in Employee settings",
      );
      const firstSwitch = switchEmployeeKernelRuntimeDraft(
        {},
        "claude-code",
        { model: "deepseek-v4-flash", providerId: "ww", reasoningEffort: "high" },
        "codex",
        { model: "gpt-5.5", providerId: "", reasoningEffort: "medium" },
      );
      const switchedBack = switchEmployeeKernelRuntimeDraft(
        firstSwitch.draftsByKernel,
        "codex",
        firstSwitch.selection,
        "claude-code",
        { model: "claude-opus-4-8", providerId: "", reasoningEffort: "" },
      );
      assert.deepEqual(
        switchedBack.selection,
        { model: "deepseek-v4-flash", providerId: "ww", reasoningEffort: "high" },
        "Switching back to a Kernel must restore its model, Provider, and reasoning draft",
      );
      assert.equal(
        isKernelDefaultModelOption("claude-code", { id: "claude-code-default", label: "Follow Claude config" }, { source: "claude-code-defaults" }),
        true,
        "The Claude default sentinel should render as provider-config-managed",
      );
      assert.equal(
        isKernelDefaultModelOption("opencode", { id: "opencode/new-default", label: "New Default" }, { source: "provider:custom" }),
        false,
        "A real provider model ending in -default must not be mistaken for a Kernel sentinel",
      );
      assert.equal(
        isKernelDefaultModelOption("opencode", { id: "opencode-default", label: "Provider Default" }, { source: "provider:custom" }),
        false,
        "A provider model that exactly matches the Kernel sentinel must remain a provider model",
      );
      assert.equal(
        kernelBindingLabel(
          { bindingKind: "login", bindingStatus: "missing-provider" },
          (key) => key === "settings.noAvailableLogin" ? "No available login" : key,
        ),
        "No available login",
        "A Kernel without account credentials must not be labeled as logged in",
      );
      assert.equal(
        kernelBindingLabel(
          { bindingKind: "login", bindingStatus: "ready", providerLabel: "Claude Agent" },
          (key) => key,
        ),
        "Claude Agent",
        "A configured Login route should show the product account name",
      );
      assert.equal(
        kernelExecutableProbeDescription({
          label: "Pi",
          executableProbe: {
            role: "optional-diagnostic",
            status: "failed",
            path: "/custom/pi",
            requestedCommand: "/custom/pi",
            source: "environment",
            sourceName: "OPENGROVE_PI_BIN",
            exitCode: 2,
          },
        }, (key, replacements) => key + ":" + (replacements?.source || "") + ":" + (replacements?.path || "")),
        "settings.kernelOptionalExecutableOverrideExitFailed:OPENGROVE_PI_BIN:/custom/pi",
        "a failed optional Pi CLI must retain its environment-variable ownership without becoming a Pi runtime failure",
      );
      assert.equal(
        kernelExecutableProbeDescription({
          label: "Codex",
          executableProbe: {
            role: "runtime-required",
            status: "missing",
            requestedCommand: "/missing/codex",
            source: "configured",
          },
        }, (key, replacements) => key === "settings.configuredKernelCommand"
          ? "configured Codex command"
          : key + ":" + (replacements?.source || "") + ":" + (replacements?.command || "")),
        "settings.kernelExecutableOverrideMissing:configured Codex command:/missing/codex",
        "a missing runtime override must render its configured path and ownership",
      );
      assert.equal(
        kernelExecutableProbeDescription({
          label: "Pi",
          executableProbe: {
            role: "optional-diagnostic",
            status: "missing",
            requestedCommand: "/missing/pi",
            source: "environment",
            sourceName: "OPENGROVE_PI_BIN",
          },
        }, (key, replacements) => key + ":" + (replacements?.source || "") + ":" + (replacements?.command || "")),
        "settings.kernelOptionalExecutableOverrideMissing:OPENGROVE_PI_BIN:/missing/pi",
        "a missing optional override must remain visible without blocking the Pi runtime",
      );
      assert.deepEqual(
        modelOptionsForKernel("opencode", {
          kernel: "opencode",
          source: "provider-unavailable",
          models: [],
          reasoningEfforts: [],
          speedTiers: [],
        }),
        [],
        "An unavailable provider must not fall back to a hard-coded model list",
      );
      assert.equal(
        formatKernelLabel("codex", (key, replacements) => (
          key === "workspace.namedKernel"
            ? String(replacements?.name) + " 内核"
            : key
        )),
        "Codex 内核",
        "Kernel labels must use the active UI catalog instead of hard-coding English",
      );
      const localizedPresetForm = providerFormFromProfile(
        {
          id: "openai",
          name: "OpenAI",
          protocol: "openai-compatible",
          description: "English fallback",
          descriptionCode: "openai",
          models: [],
        },
        (key) => key === "settings.providerDescriptionOpenAI" ? "本地化 OpenAI 说明" : key,
      );
      assert.equal(localizedPresetForm.description, "本地化 OpenAI 说明");
      assert.deepEqual(
        providerProfileFromForm(localizedPresetForm),
        {
          id: "openai",
          name: "OpenAI",
          custom: true,
          enabled: true,
          origin: "user",
          routeKind: "provider",
          protocol: "openai-compatible",
          descriptionCode: "openai",
          description: undefined,
          openaiBaseUrl: undefined,
          anthropicBaseUrl: undefined,
          geminiBaseUrl: undefined,
          apiKey: undefined,
          apiKeyEnv: undefined,
          credentialKind: "none",
          modelsPinned: false,
          models: [],
        },
        "Saving an unedited localized preset description must retain its stable code instead of persisting translated text",
      );
      const editedPresetForm = updateProviderForm(localizedPresetForm, "description", "My custom description");
      const editedPresetProfile = providerProfileFromForm(editedPresetForm);
      assert.equal(editedPresetProfile?.descriptionCode, undefined);
      assert.equal(editedPresetProfile?.description, "My custom description");

      const compactKernelPanel = SettingsKernelPanel({
        t: (key) => key,
        kernels: [
          {
            id: "codex",
            label: "Codex",
            available: true,
            integrationKind: "sdk",
            providerLabel: "ChatGPT",
          },
          {
            id: "claude-code",
            label: "Claude Agent",
            available: false,
            unavailableCode: "provider_selection_required",
          },
        ],
        activeKernel: "codex",
        selectedKernel: "codex",
        expandedKernelId: "",
        kernelPathOverrides: {},
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: () => {},
      });
      const compactKernelText = textContent(compactKernelPanel);
      assert.ok(
        !compactKernelText.includes("settings.integrationSdk") && !compactKernelText.includes("ChatGPT"),
        "Default Kernel choices must not expose transport or Provider implementation details",
      );
      assert.ok(
        !compactKernelText.includes("settings.bindingSelectionRequired"),
        "A Kernel choice must not ask users to select a Provider that cannot be selected there",
      );

      let savedPathOverride;
      const recoveryPanel = SettingsKernelPanel({
        t: (key, replacements) => key === "settings.kernelExecutableOverrideExitFailed"
          ? "已找到 " + replacements.path + "，退出码 " + replacements.exitCode
          : key,
        kernels: [{
          id: "codex",
          label: "Codex",
          available: false,
          installed: true,
          reason: "Provider key is missing.",
          unavailableCode: "provider_key_missing",
          binaryPath: "/detected/codex",
          configHome: "/detected/config",
          executableProbe: {
            role: "runtime-required",
            status: "failed",
            path: "/detected/codex",
            requestedCommand: "/configured/codex",
            source: "configured",
            exitCode: 2,
          },
        }],
        activeKernel: "claude-code",
        selectedKernel: "claude-code",
        expandedKernelId: "codex",
        kernelPathOverrides: { codex: { binaryPath: "/custom/codex" } },
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: (kernelId, patch) => { savedPathOverride = { kernelId, patch }; },
      });
      const recoveryInputs = findElementsByType(recoveryPanel, "input");
      assert.ok(
        !textContent(recoveryPanel).includes("Provider key is missing."),
        "Kernel path management must not mix Provider or availability diagnostics into the settings list",
      );
      const executableInput = recoveryInputs.find((input) => input.props.value === "/custom/codex");
      assert.ok(executableInput, "Expanded kernel settings should expose the executable path override");
      const configDirectoryInput = recoveryInputs.find((input) => input.props.value === "/detected/config");
      assert.ok(configDirectoryInput, "Expanded kernel settings should retain the independent Kernel config directory");
      assert.ok(
        textContent(recoveryPanel).includes("settings.kernelConfigDirectory"),
        "The config directory must use its precise product label instead of the retired Knowledge/root-path wording",
      );
      executableInput.props.onBlur({ currentTarget: { value: "/Applications/ChatGPT.app/Contents/Resources/codex" } });
      assert.deepEqual(savedPathOverride, {
        kernelId: "codex",
        patch: { binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex" },
      }, "Executable path recovery must persist through the product settings flow");

      const installedPiPanel = SettingsKernelPanel({
        t: (key) => key,
        kernels: [{
          id: "pi",
          label: "Pi",
          available: false,
          installed: true,
          reason: "Provider key is missing.",
          unavailableCode: "provider_key_missing",
          installActions: [{ id: "pi.install", title: "Install Pi", command: ["npm", "install", "-g", "pi"] }],
        }],
        activeKernel: "codex",
        selectedKernel: "codex",
        expandedKernelId: "",
        kernelPathOverrides: {},
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onInstallKernel: () => {},
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: () => {},
      });
      assert.ok(
        !textContent(installedPiPanel).includes("common.install"),
        "An installed Kernel with a Provider problem must not offer a misleading reinstall action",
      );

      const missingPiPanel = SettingsKernelPanel({
        t: (key) => key,
        kernels: [{
          id: "pi",
          label: "Pi",
          available: false,
          installed: false,
          reason: "Pi was not found.",
          unavailableCode: "kernel_executable_missing",
          installActions: [{ id: "pi.install", title: "Install Pi", command: ["npm", "install", "-g", "pi"] }],
        }],
        activeKernel: "codex",
        selectedKernel: "codex",
        expandedKernelId: "",
        kernelPathOverrides: {},
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onInstallKernel: () => {},
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: () => {},
      });
      assert.ok(
        textContent(missingPiPanel).includes("common.install"),
        "A genuinely missing Kernel with an install action must still offer installation",
      );

      const openClawPanel = SettingsKernelPanel({
        t: (key, replacements) => key === "settings.kernelUnavailableRuntime"
          ? String(replacements?.kernel) + " 运行环境未配置"
          : key,
        kernels: [{
          id: "openclaw",
          label: "OpenClaw",
          available: false,
          installed: false,
          reason: "OpenClaw Gateway is not configured.",
          unavailableCode: "kernel_runtime_unavailable",
          executableProbe: {
            role: "optional-diagnostic",
            status: "failed",
            path: "/custom/openclaw",
            requestedCommand: "/custom/openclaw",
            source: "environment",
            sourceName: "OPENGROVE_OPENCLAW_BIN",
            exitCode: 2,
          },
        }],
        activeKernel: "codex",
        selectedKernel: "codex",
        providers: [],
        providerBindings: {},
        expandedKernelId: "openclaw",
        kernelPathOverrides: {},
        loading: false,
        saving: false,
        onSelectKernel: () => {},
        onToggleKernelExpanded: () => {},
        onBindProvider: () => {},
        onSetKernelPathDraft: () => {},
        onSaveKernelPathOverride: () => {},
      });
      assert.ok(!textContent(openClawPanel).includes("OpenClaw 运行环境未配置"));
      assert.ok(!textContent(openClawPanel).includes("OpenClaw Gateway is not configured."));

      console.log("✓ provider selector and kernel executable recovery persist through product settings");
    }
  `;
}
