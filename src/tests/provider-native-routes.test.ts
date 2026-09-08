import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/google-generative-ai";
import { buildPiProviderEnv, resolvePiRuntimeModel } from "../kernel/adapters/pi.js";
import {
  getAllBridgeProviderProfiles,
  getBridgeProviderProfiles,
  providerProfileForKernel,
} from "../server/provider-profiles.js";
import { migrateBridgeSettingsSourceToV1 } from "../server/migrations/bridge-settings-v1.js";
import { buildOpenCodeProviderEnv } from "../kernel/adapters/opencode.js";
import { kernelModelForProviderSelection } from "../server/kernel-registry.js";
import { providerView } from "../server/provider-state.js";

test("Provider views expose the Host's per-kernel protocol decisions", () => {
  const google = getBridgeProviderProfiles().find((profile) => profile.id === "gemini");
  assert.ok(google);
  const view = providerView({ ...google, enabled: true, apiKey: "test-key" }, {});
  assert.equal(view.bindings?.pi, "gemini-compatible");
  assert.equal(view.bindings?.opencode, "gemini-compatible");
  assert.equal(view.bindings?.codex, "openai-compatible");
  assert.equal(view.bindings?.["claude-code"], undefined);
});

test("catalog capabilities preserve Pi's native reasoning value mapping", () => {
  const id = "openai/gpt-oss-120b";
  const env = buildPiProviderEnv({
    id: "baseten",
    protocol: "openai-compatible",
    baseUrl: "https://inference.baseten.co/v1",
    apiKey: "test-key",
  });
  const model = resolvePiRuntimeModel(env ?? {}, id, [
    { id, label: id, metadata: { reasoningEfforts: ["low", "medium", "high"] } },
  ]);
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(model.thinkingLevelMap?.high, "high");
  assert.equal(clampThinkingLevel(model, "max"), "high");
});

test("the built-in Google route reaches the versioned Gemini endpoint through Pi", async (t) => {
  const google = getBridgeProviderProfiles().find((profile) => profile.id === "gemini");
  assert.ok(google);
  const profile = providerProfileForKernel("pi", { ...google, enabled: true, apiKey: "test-key" }, "gemini-2.5-pro");
  assert.ok(profile);
  const model = resolvePiRuntimeModel(buildPiProviderEnv(profile) ?? {}, profile.model);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"OK"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  });
  assert.equal(model.api, "google-generative-ai");
  const reply = await streamSimple(
    model as Model<"google-generative-ai">,
    { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
    { apiKey: "test-key" },
  ).result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.deepEqual(requests, [
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
  ]);
});

test("Pi preserves the selected protocol when a model is in another native catalog", () => {
  for (const entry of [
    {
      id: "gemini",
      protocol: "openai-compatible" as const,
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      api: "openai-completions",
    },
    {
      id: "deepseek",
      protocol: "anthropic-compatible" as const,
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com/anthropic",
      api: "anthropic-messages",
    },
  ]) {
    const model = resolvePiRuntimeModel(buildPiProviderEnv({ ...entry, apiKey: "test-key" }) ?? {}, entry.model);
    assert.equal(model.api, entry.api);
    assert.equal(model.baseUrl, entry.baseUrl);
    assert.ok(model.contextWindow > 128000, "transport selection must retain known model limits");
  }
});

test("Pi's explicit Google selection wins over unrelated ambient OpenAI credentials", () => {
  const env = buildPiProviderEnv({
    id: "gemini",
    protocol: "gemini-compatible",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "selected-key",
  });
  const model = resolvePiRuntimeModel(
    { OPENAI_API_KEY: "unrelated-key", OPENAI_BASE_URL: "https://unrelated.example/v1", ...env },
    "gemini-2.5-pro",
  );
  assert.equal(model.api, "google-generative-ai");
  assert.equal(model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
});

test("settings upgrade repairs only the previous official Google default and preserves credentials", () => {
  const old = {
    id: "gemini",
    protocol: "openai-compatible",
    geminiBaseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "saved-key",
    models: [{ id: "gemini-3.8-flash" }],
  };
  const custom = {
    ...old,
    geminiBaseUrl: "https://proxy.example/custom/v2",
    openaiBaseUrl: "https://proxy.example/chat",
  };
  const migration = migrateBridgeSettingsSourceToV1({ settingsSchemaVersion: 1, customProviders: [old, custom] });
  assert.equal(migration.changed, true);
  assert.deepEqual(migration.source.customProviders, [
    { ...old, geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "gemini-compatible" },
    custom,
  ]);
  assert.equal(migrateBridgeSettingsSourceToV1(migration.source).changed, false);
});

test("OpenCode uses native Google and Anthropic packages and matching qualified model IDs", () => {
  for (const entry of [
    {
      id: "gemini",
      model: "gemini-2.5-pro",
      key: "google",
      npm: "@ai-sdk/google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    },
    {
      id: "anthropic",
      model: "claude-opus-4-8",
      key: "anthropic",
      npm: "@ai-sdk/anthropic",
      baseURL: "https://api.anthropic.com/v1",
    },
  ]) {
    const preset = getBridgeProviderProfiles().find((p) => p.id === entry.id);
    assert.ok(preset);
    const profile = { ...preset, enabled: true, apiKey: "test-key" };
    const binding = providerProfileForKernel("opencode", profile, entry.model);
    assert.ok(binding, `${entry.id} must be selectable`);
    const env = buildOpenCodeProviderEnv(binding);
    assert.ok(env?.OPENCODE_CONFIG_CONTENT);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, `${entry.key}/${entry.model}`);
    assert.equal(kernelModelForProviderSelection("opencode", profile, entry.model), config.model);
    assert.equal(config.provider[entry.key].npm, entry.npm);
    assert.equal(config.provider[entry.key].options.baseURL, entry.baseURL);
    assert.equal(config.provider[entry.key].options.apiKey, "test-key");
  }
});

test("the Google catalog carries Gemini 3.8 capabilities through the Host binding", () => {
  const google = getAllBridgeProviderProfiles(undefined).find((p) => p.id === "gemini");
  assert.ok(google);
  const profile = providerProfileForKernel("pi", { ...google, enabled: true, apiKey: "test-key" }, "gemini-3.8-flash");
  const metadata = profile?.models?.find((m) => m.id === "gemini-3.8-flash")?.metadata;
  assert.equal(metadata?.reasoning, true);
  assert.equal(metadata?.contextWindow, 1048576);
  assert.equal(metadata?.maxOutputTokens, 65536);
  assert.ok(metadata?.inputModalities?.includes("image"));
  assert.deepEqual(metadata?.reasoningEfforts, ["low", "medium", "high"]);
  assert.ok(profile);
  const pi = resolvePiRuntimeModel(buildPiProviderEnv(profile) ?? {}, profile.model, profile.models);
  assert.equal(pi.reasoning, true);
  assert.equal(pi.contextWindow, 1048576);
  assert.equal(pi.maxTokens, 65536);
  assert.deepEqual(pi.input, ["text", "image"]);
  assert.equal(clampThinkingLevel(pi, "max"), "high");
  const opencodeProfile = providerProfileForKernel(
    "opencode",
    { ...google, enabled: true, apiKey: "test-key" },
    "gemini-3.8-flash",
  );
  assert.ok(opencodeProfile);
  const config = JSON.parse(buildOpenCodeProviderEnv(opencodeProfile)?.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.equal(config.provider.google.models["gemini-3.8-flash"].reasoning, true);
  assert.deepEqual(config.provider.google.models["gemini-3.8-flash"].limit, { context: 1048576, output: 65536 });
});
