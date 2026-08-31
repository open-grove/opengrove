import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAllBridgeProviderProfiles,
  getBridgeProviderProfiles,
  resolveProviderRoute,
} from "../server/provider-profiles.js";
import { modelOfferingKey, modelsDevCatalogSource, providerModelForSelection } from "../server/models-dev-catalog.js";
import { kernelModelForProviderSelection } from "../server/kernel-registry.js";
import { withEnv } from "./env.js";

test("the built-in Provider roster is the deliberate flat product list", () => {
  assert.deepEqual(
    getBridgeProviderProfiles()
      .map((provider) => provider.id)
      .sort(),
    [
      "aihubmix",
      "anthropic",
      "aws-bedrock-api-key",
      "azure",
      "bailian",
      "deepseek",
      "gemini",
      "google-vertex",
      "kimi",
      "minimax",
      "openai",
      "openrouter",
      "volc-coding-plan",
      "ww",
      "xai",
      "xiaomi-mimo",
      "zhipu-glm",
    ],
  );
});

test("Azure OpenAI and xAI keep route-specific facts around Models.dev models", async () => {
  await withEnv(
    {
      AZURE_RESOURCE_NAME: "opengrove-test",
      OPENGROVE_AZURE_OPENAI_BASE_URL: undefined,
    },
    () => {
      const profiles = getAllBridgeProviderProfiles(undefined);
      const azure = profiles.find((provider) => provider.id === "azure");
      const xai = profiles.find((provider) => provider.id === "xai");
      assert.ok(azure && xai);
      assert.equal(azure.openaiBaseUrl, "https://opengrove-test.openai.azure.com/openai/v1");
      assert.equal(azure.apiKeyEnv, "AZURE_API_KEY");
      assert.equal(azure.catalogProviderId, "azure");
      assert.ok(azure.models.length > 0);
      assert.ok(azure.models.every((model) => model.canonicalModelId?.startsWith("openai/")));
      assert.equal(xai.openaiBaseUrl, "https://api.x.ai/v1");
      assert.equal(xai.apiKeyEnv, "XAI_API_KEY");
      assert.equal(xai.catalogProviderId, "xai");
      assert.ok(xai.models.some((model) => model.canonicalModelId?.startsWith("xai/")));
    },
  );
});

test("bundled Models.dev routes share one canonical model without losing wire ids", () => {
  const profiles = getAllBridgeProviderProfiles(undefined);
  const canonicalModelId = "anthropic/claude-opus-4-8";
  const expectedRoutes = new Map([
    ["anthropic", "claude-opus-4-8"],
    ["aws-bedrock-api-key", "anthropic.claude-opus-4-8"],
    ["google-vertex", "claude-opus-4-8@default"],
    ["openrouter", "anthropic/claude-opus-4.8"],
  ]);

  for (const [providerId, apiModelId] of expectedRoutes) {
    const profile = profiles.find((provider) => provider.id === providerId);
    assert.ok(profile, `${providerId} must remain in the OpenGrove Provider directory`);
    const route = providerModelForSelection(profile, canonicalModelId);
    assert.equal(route?.label, "Claude Opus 4.8");
    assert.equal(route?.canonicalModelId, canonicalModelId);
    assert.equal(route?.apiModelId, apiModelId);
    const expectedKernelModel =
      providerId === "aws-bedrock-api-key"
        ? `amazon-bedrock/${apiModelId}`
        : providerId === "openrouter"
          ? `opengrove-openrouter/${apiModelId}`
          : apiModelId;
    assert.equal(
      kernelModelForProviderSelection("opencode", { ...profile, custom: true, enabled: true }, canonicalModelId),
      expectedKernelModel,
      `${providerId} must translate the canonical selection back to its exact Provider model id`,
    );
  }
});

test("catalog names are the display identity even when Provider canonical ids differ", () => {
  assert.equal(
    modelOfferingKey({
      id: "vendor-opus-4-8",
      label: "Claude Opus 4.8",
      canonicalModelId: "vendor/private-opus",
    }),
    modelOfferingKey({
      id: "anthropic.claude-opus-4-8",
      label: "  CLAUDE   OPUS 4.8 ",
      canonicalModelId: "anthropic/claude-opus-4-8",
    }),
    "Models.dev names, rather than Provider wire ids, define one user-visible model",
  );
});

test("a name-grouped selection routes through a Provider with a different canonical id", () => {
  const customProviders = [
    {
      id: "alpha",
      name: "Alpha",
      protocol: "openai-compatible" as const,
      custom: true,
      enabled: true,
      openaiBaseUrl: "https://alpha.example.test/v1",
      apiKey: "alpha-key",
      credentialKind: "api-key" as const,
      models: [{ id: "alpha-opus", label: "Claude Opus 4.8", canonicalModelId: "alpha/opus" }],
    },
    {
      id: "beta",
      name: "Beta",
      protocol: "openai-compatible" as const,
      custom: true,
      enabled: true,
      openaiBaseUrl: "https://beta.example.test/v1",
      apiKey: "beta-key",
      credentialKind: "api-key" as const,
      models: [{ id: "beta-opus", label: "Claude Opus 4.8", canonicalModelId: "beta/opus" }],
    },
  ];
  const route = resolveProviderRoute(
    "codex",
    "alpha/opus",
    undefined,
    [{ modelId: "alpha/opus", providerId: "beta" }],
    customProviders,
  );
  assert.equal(route.providerId, "beta");
  assert.equal(route.binding.kind, "provider");
  assert.equal(route.binding.kind === "provider" ? route.binding.status : undefined, "ready");
});

test("catalog facts do not overwrite OpenGrove route and credential overlays", () => {
  const profiles = getAllBridgeProviderProfiles(undefined);
  const bedrock = profiles.find((provider) => provider.id === "aws-bedrock-api-key");
  const zhipu = profiles.find((provider) => provider.id === "zhipu-glm");
  assert.ok(bedrock && zhipu);
  assert.equal(bedrock.apiKeyEnv, undefined, "ambient AWS credentials must not become one catalog env key");
  assert.equal(
    zhipu.openaiBaseUrl,
    "https://open.bigmodel.cn/api/paas/v4",
    "the China endpoint is an OpenGrove overlay",
  );
  assert.deepEqual(
    zhipu.models.map((model) => model.id),
    ["glm-5"],
    "a regional route must not inherit an unverified global inventory",
  );
  assert.equal(zhipu.catalogProviderId, "zai");
  assert.match(zhipu.docsUrl ?? "", /^https:\/\//);
  const customDeepseek = getAllBridgeProviderProfiles([
    {
      id: "deepseek",
      name: "DeepSeek through my proxy",
      protocol: "openai-compatible",
      custom: true,
      enabled: true,
      openaiBaseUrl: "https://deepseek-proxy.example.test/v1",
      apiKey: "test-key",
      credentialKind: "api-key",
      models: [],
    },
  ]).find((provider) => provider.id === "deepseek");
  assert.equal(
    customDeepseek?.openaiBaseUrl,
    "https://deepseek-proxy.example.test/v1",
    "a user route override must remain authoritative over catalog defaults",
  );
});

test("legacy raw model bindings resolve a canonical model selection", () => {
  const anthropic = getAllBridgeProviderProfiles(undefined).find((provider) => provider.id === "anthropic");
  assert.ok(anthropic);
  const customProviders = [
    {
      ...anthropic,
      custom: true,
      enabled: true,
      apiKey: "test-key",
      credentialKind: "api-key" as const,
    },
  ];
  const route = resolveProviderRoute(
    "claude-code",
    "anthropic/claude-opus-4-8",
    undefined,
    [{ modelId: "claude-opus-4-8", providerId: "anthropic" }],
    customProviders,
  );
  assert.equal(route.providerId, "anthropic");
  assert.equal(route.binding.kind, "provider");
  assert.equal(route.binding.kind === "provider" ? route.binding.status : undefined, "ready");
});

test("a canonical standard binding does not capture a differently named offering", () => {
  const profiles = getAllBridgeProviderProfiles(undefined);
  const anthropic = profiles.find((provider) => provider.id === "anthropic");
  const openrouter = profiles.find((provider) => provider.id === "openrouter");
  assert.ok(anthropic && openrouter);
  const customProviders = [anthropic, openrouter].map((provider) => ({
    ...provider,
    custom: true,
    enabled: true,
    apiKey: "test-key",
    credentialKind: "api-key" as const,
  }));
  const route = resolveProviderRoute(
    "opencode",
    "anthropic/claude-opus-4.8-fast",
    undefined,
    [{ modelId: "anthropic/claude-opus-4-8", providerId: "anthropic" }],
    customProviders,
  );
  assert.equal(route.providerId, "$unconfigured");
  assert.equal(route.binding.kind, "unresolved");
});

test("Models.dev keeps exact Fast, Free, HighSpeed, and regional route ids", () => {
  const profiles = getAllBridgeProviderProfiles(undefined);
  const cases = [
    ["openrouter", "anthropic/claude-opus-4.8-fast", "Claude Opus 4.8 (Fast)"],
    ["openrouter", "openai/gpt-oss-20b:free", "gpt-oss-20b (free)"],
    ["kimi", "kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed"],
    ["aws-bedrock-api-key", "global.anthropic.claude-opus-4-8", "Claude Opus 4.8 (Global)"],
  ] as const;
  for (const [providerId, modelId, label] of cases) {
    const profile = profiles.find((provider) => provider.id === providerId);
    assert.ok(profile);
    const model = providerModelForSelection(profile, modelId);
    assert.equal(model?.apiModelId, modelId);
    assert.equal(model?.label, label);
  }
});

test("the bundled catalog records an immutable upstream revision", () => {
  assert.equal(modelsDevCatalogSource.repository, "https://github.com/anomalyco/models.dev.git");
  assert.match(modelsDevCatalogSource.commit, /^[0-9a-f]{40}$/);
});
