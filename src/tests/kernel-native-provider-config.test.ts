import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKimiProviderEnv } from "../kernel/adapters/kimi.js";
import { buildPiProviderEnv, resolvePiRuntimeModel } from "../kernel/adapters/pi.js";
import { buildOpenCodeProviderEnv } from "../kernel/adapters/opencode.js";
import { buildClaudeCodeProviderEnv } from "../kernel/adapters/claude-code.js";
import { applyClaudeHostManagedProviderEnv } from "../runtime/claude-bedrock-env.js";
import { buildHermesConfigYaml, normalizeHermesProviderConfig } from "../runtime/hermes/config.js";
import { codexProviderConfigFromProfile } from "../kernel/adapters/codex.js";
import { codexThreadConfig } from "../runtime/codex-runtime.js";
import { providerBindingFingerprint } from "../server/provider-binding.js";
import {
  getAllBridgeProviderProfiles,
  providerProfileForKernel,
  hermesProviderConfigForKernel,
} from "../server/provider-profiles.js";

test("Kimi binds Google through its native SDK without unrelated protocol overrides", () => {
  const google = getAllBridgeProviderProfiles(undefined).find((p) => p.id === "gemini");
  assert.ok(google);
  const binding = providerProfileForKernel(
    "kimi",
    { ...google, enabled: true, apiKey: "test-key" },
    "gemini-3.8-flash",
  );
  assert.ok(binding);
  assert.equal(binding.protocol, "gemini-compatible");
  const env = buildKimiProviderEnv(binding);
  assert.equal(env?.KIMI_MODEL_PROVIDER_TYPE, "google-genai");
  assert.equal(env?.KIMI_MODEL_BASE_URL, "https://generativelanguage.googleapis.com");
  assert.equal(env?.KIMI_MODEL_MAX_CONTEXT_SIZE, "1048576");
  assert.equal(env?.KIMI_MODEL_MAX_OUTPUT_SIZE, "65536");
  assert.equal(env?.KIMI_MODEL_REASONING_KEY, undefined);
});

test("Kimi Responses receives DeepSeek's output cap instead of a context-sized fallback", () => {
  const deepseek = getAllBridgeProviderProfiles(undefined).find((p) => p.id === "deepseek");
  assert.ok(deepseek);
  const binding = providerProfileForKernel(
    "kimi",
    { ...deepseek, enabled: true, apiKey: "test-key" },
    "deepseek-v4-flash",
  );
  assert.ok(binding);
  const env = buildKimiProviderEnv(binding);
  assert.equal(env?.KIMI_MODEL_PROVIDER_TYPE, "openai_responses");
  assert.equal(env?.KIMI_MODEL_MAX_CONTEXT_SIZE, "1000000");
  assert.equal(env?.KIMI_MODEL_MAX_OUTPUT_SIZE, "384000");
  assert.equal(env?.KIMI_MODEL_REASONING_KEY, undefined);
});

test("a native Responses Codex route preserves the selected model context without entering the Chat proxy", () => {
  const profile = {
    id: "external",
    protocol: "openai-compatible" as const,
    wireApi: "responses" as const,
    baseUrl: "https://models.example/v1",
    apiKey: "test-key",
    model: "large-model",
    models: [
      { id: "large-model", label: "Large", metadata: { contextWindow: 1000000 } },
      { id: "small-model", label: "Small", metadata: { contextWindow: 64000 } },
    ],
  };
  const config = codexProviderConfigFromProfile(profile);
  assert.equal(config?.baseUrl, "https://models.example/v1");
  assert.equal(codexThreadConfig(config, { model: "large-model" }).model_context_window, 1000000);
  assert.equal(codexThreadConfig(config, { model: "small-model" }).model_context_window, 64000);
  assert.equal(codexThreadConfig(config, { model: "uncatalogued" }).model_context_window, undefined);
});

test("provider catalog refreshes preserve native session identity across Kernels", () => {
  const provider = {
    id: "external",
    name: "External",
    protocol: "openai-compatible" as const,
    openaiBaseUrl: "https://models.example/v1",
    apiKey: "test-key",
    wireApi: "chat" as const,
    models: [{ id: "custom-model", label: "Custom", metadata: { contextWindow: 1000000 } }],
  };
  const current = providerBindingFingerprint({ kernelId: "codex", provider });
  assert.notEqual(
    providerBindingFingerprint({ kernelId: "codex", provider: { ...provider, wireApi: "responses" } }),
    current,
  );
  for (const kernelId of ["codex", "claude-code", "hermes", "kimi", "opencode", "pi"] as const) {
    const input = { kernelId, providerModel: "custom-model", kernelModel: "custom-model" };
    const original = providerBindingFingerprint({ ...input, provider });
    const expanded = [...provider.models, { id: "unrelated", label: "New", metadata: { contextWindow: 64000 } }];
    for (const models of [
      expanded,
      [...expanded].reverse(),
      [{ ...provider.models[0]!, metadata: { contextWindow: 64000 } }],
    ]) {
      assert.equal(providerBindingFingerprint({ ...input, provider: { ...provider, models } }), original);
    }
  }
});

test("Claude receives the selected context window without inheriting another model's limit", () => {
  const env = buildClaudeCodeProviderEnv({
    id: "external",
    protocol: "anthropic-compatible",
    baseUrl: "https://models.example/anthropic",
    apiKey: "test-key",
    model: "large-model",
    models: [{ id: "large-model", label: "Large", metadata: { contextWindow: 1000000 } }],
  });
  assert.equal(env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(
    applyClaudeHostManagedProviderEnv({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" }, env).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    "1000000",
  );
  assert.equal(
    applyClaudeHostManagedProviderEnv(
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" },
      { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" },
    ).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    undefined,
  );
});

test("Hermes emits per-model native context limits and retains the Responses transport after normalization", () => {
  const config = hermesProviderConfigForKernel(
    {
      id: "custom",
      name: "Custom",
      enabled: true,
      protocol: "openai-compatible",
      wireApi: "responses",
      openaiBaseUrl: "https://models.example/v1",
      apiKey: "test-key",
      models: [{ id: "large-model", label: "Large", metadata: { contextWindow: 1000000 } }],
    },
    "large-model",
  );
  assert.ok(config);
  const normalized = normalizeHermesProviderConfig(config);
  assert.equal(normalized?.apiMode, "codex_responses");
  assert.match(buildHermesConfigYaml(undefined, normalized), /"large-model":\n\s+context_length: 1000000/);
});

test("an explicit Responses route reaches each Kernel's native Responses transport", () => {
  const profile = {
    id: "native-responses",
    name: "Responses endpoint",
    enabled: true,
    protocol: "openai-compatible" as const,
    wireApi: "responses" as const,
    openaiBaseUrl: "https://models.example/v1",
    apiKey: "test-key",
    models: [{ id: "custom-model", label: "Custom model" }],
  };
  const binding = providerProfileForKernel("pi", profile, "custom-model");
  assert.ok(binding);
  const pi = resolvePiRuntimeModel(buildPiProviderEnv(binding) ?? {}, binding.model);
  assert.equal(pi.api, "openai-responses");
  assert.equal(buildKimiProviderEnv(binding)?.KIMI_MODEL_PROVIDER_TYPE, "openai_responses");
  const config = JSON.parse(buildOpenCodeProviderEnv(binding)?.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.equal(config.provider["opengrove-native-responses"].npm, "@ai-sdk/openai");
  assert.equal(hermesProviderConfigForKernel(profile, "custom-model")?.apiMode, "codex_responses");
});

test("explicit Chat wins over Pi's built-in Responses model, while unspecified routes preserve native defaults", () => {
  const profile = {
    id: "openai",
    protocol: "openai-compatible" as const,
    baseUrl: "https://models.example/v1",
    apiKey: "test-key",
    model: "gpt-5.4",
  };
  const chat = resolvePiRuntimeModel(buildPiProviderEnv({ ...profile, wireApi: "chat" }) ?? {}, profile.model);
  assert.equal(chat.api, "openai-completions");
  const native = resolvePiRuntimeModel(buildPiProviderEnv(profile) ?? {}, profile.model);
  assert.equal(native.api, "openai-responses");
});

test("Kimi Google base conversion preserves custom proxy prefixes and unversioned roots", () => {
  for (const [baseUrl, expected] of [
    ["https://proxy.example/google/v1beta/", "https://proxy.example/google"],
    ["https://proxy.example/google", "https://proxy.example/google"],
    ["https://proxy.example/custom/v2", "https://proxy.example/custom/v2"],
  ]) {
    assert.equal(
      buildKimiProviderEnv({
        id: "proxy",
        protocol: "gemini-compatible",
        baseUrl,
        model: "gemini-3.8-flash",
        apiKey: "test-key",
      })?.KIMI_MODEL_BASE_URL,
      expected,
    );
  }
});
