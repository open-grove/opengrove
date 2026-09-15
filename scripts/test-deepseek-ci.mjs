import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDeepSeekRuntime } from "./deepseek-ci.mjs";

const root = mkdtempSync(join(tmpdir(), "opengrove-deepseek-ci-"));
try {
  const options = {
    root,
    apiKey: "test-only-provider-key",
    model: "deepseek-flash",
  };
  const claude = prepareDeepSeekRuntime("claude-code", options);
  assert.equal(claude.OPENGROVE_REAL_RUNTIME_ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(claude.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash");
  assert.equal(claude.OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY, undefined);
  for (const kernel of ["codex", "opencode", "pi", "hermes", "kimi"]) {
    const env = prepareDeepSeekRuntime(kernel, options);
    assert.equal(env.OPENGROVE_REAL_RUNTIME_OPENAI_BASE_URL, "https://api.deepseek.com/v1");
    assert.equal(env.OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY, options.apiKey);
    assert.equal(env.OPENGROVE_REAL_RUNTIME_MODEL, "deepseek-flash");
    assert.equal(env.OPENGROVE_REAL_RUNTIME_ANTHROPIC_API_KEY, undefined);
  }
  const claw = prepareDeepSeekRuntime("openclaw", options);
  const configText = readFileSync(claw.OPENCLAW_CONFIG_PATH, "utf8");
  const config = JSON.parse(configText);
  assert.equal(config.models.providers.deepseek.apiKey, "${DEEPSEEK_API_KEY}");
  assert.equal(config.agents.defaults.model.primary, "deepseek/deepseek-flash");
  assert.equal(config.gateway.bind, "loopback");
  assert.deepEqual(config.plugins.allow, ["deepseek"]);
  assert.deepEqual(config.plugins.load.paths, ["/opt/opengrove/deepseek-provider"]);
  assert.ok(claw.HOME.startsWith(root));
  assert.equal(configText.includes(options.apiKey), false);
  assert.throws(() => prepareDeepSeekRuntime("unknown", options), /Unsupported kernel/);
  assert.throws(() => prepareDeepSeekRuntime("pi", { ...options, apiKey: "" }), /API key/);
  assert.throws(() => prepareDeepSeekRuntime("pi", { ...options, model: "bad\nmodel" }), /model/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("DeepSeek CI runtime configuration ok");
