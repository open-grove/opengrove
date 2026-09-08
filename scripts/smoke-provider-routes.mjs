// Opt-in, paid API smoke. Build the server first. Keys come from the environment
// or an explicitly supplied local settings file; credentials are never printed.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent } from "undici";
import { streamSimple as googleStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { buildPiProviderEnv, resolvePiRuntimeModel } from "../dist/kernel/adapters/pi.js";
import { buildOpenCodeProviderEnv } from "../dist/kernel/adapters/opencode.js";
import { getAllBridgeProviderProfiles, providerProfileForKernel } from "../dist/server/provider-profiles.js";
import { migrateBridgeSettingsSourceToV1 } from "../dist/server/migrations/bridge-settings-v1.js";

const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (!["--settings", "--provider", "--kernel"].includes(flag) || !process.argv[index + 1]) {
    throw new Error(
      "Usage: node scripts/smoke-provider-routes.mjs [--settings path] [--provider gemini|deepseek] [--kernel pi|opencode]",
    );
  }
  flags.set(flag, process.argv[index + 1]);
}
const selectedProvider = flags.get("--provider");
const selectedKernel = flags.get("--kernel");
if (selectedProvider && !["gemini", "deepseek"].includes(selectedProvider)) throw new Error("Unknown Provider");
if (selectedKernel && !["pi", "opencode"].includes(selectedKernel)) throw new Error("Unknown Kernel");
const settings = flags.has("--settings")
  ? migrateBridgeSettingsSourceToV1(JSON.parse(readFileSync(flags.get("--settings"), "utf8"))).source
  : {};
const profiles = getAllBridgeProviderProfiles(settings.customProviders);
const proxyUrl = settings.kernelProxy?.enabled ? settings.kernelProxy.proxyUrl : process.env.HTTPS_PROXY;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const originalFetch = globalThis.fetch;
if (dispatcher) globalThis.fetch = (input, init) => originalFetch(input, { ...init, dispatcher });
const secrets = profiles
  .filter((p) => ["gemini", "deepseek"].includes(p.id))
  .map((p) => p.apiKey || process.env[p.apiKeyEnv])
  .filter(Boolean);
const redact = (value) => secrets.reduce((text, key) => text.replaceAll(key, "[REDACTED]"), JSON.stringify(value));
const results = [];

try {
  for (const providerId of selectedProvider ? [selectedProvider] : ["gemini", "deepseek"]) {
    const profile = profiles.find((p) => p.id === providerId);
    const model = providerId === "gemini" ? "gemini-3.8-flash" : "deepseek-v4-flash";
    for (const kernel of selectedKernel ? [selectedKernel] : ["pi", "opencode"]) {
      const started = Date.now();
      try {
        const binding = providerProfileForKernel(kernel, { ...profile, enabled: true }, model);
        if (!binding?.apiKey) throw new Error(`${providerId}: missing credential or unsupported binding`);
        const detail = kernel === "pi" ? await checkPi(binding) : await checkOpenCode(binding);
        const result = { provider: providerId, kernel, ok: true, elapsedMs: Date.now() - started, ...detail };
        results.push(result);
        console.log(redact(result));
      } catch (error) {
        const result = { provider: providerId, kernel, ok: false, error: error.message };
        results.push(result);
        console.log(redact(result));
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  await dispatcher?.close();
}
if (results.some((result) => !result.ok)) process.exitCode = 1;

async function checkPi(profile) {
  const model = resolvePiRuntimeModel(buildPiProviderEnv(profile), profile.model, profile.models);
  const stream = model.api === "google-generative-ai" ? googleStream : openaiStream;
  const context = {
    messages: [
      {
        role: "user",
        content: "Call audit_echo with value OK exactly once. After its result reply exactly OK.",
        timestamp: Date.now(),
      },
    ],
    tools: [
      {
        name: "audit_echo",
        description: "Echo the value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    ],
  };
  const options = {
    apiKey: profile.apiKey,
    reasoning: "low",
    maxTokens: 1024,
    maxRetries: 0,
    signal: AbortSignal.timeout(45000),
  };
  const first = await stream(model, context, options).result();
  const call = first.content.find((item) => item.type === "toolCall");
  if (first.stopReason === "error" || call?.name !== "audit_echo" || call.arguments.value !== "OK") {
    throw new Error(first.errorMessage || "Expected audit_echo tool call");
  }
  context.messages.push(first, {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "OK" }],
    isError: false,
    timestamp: Date.now(),
  });
  const final = await stream(model, context, options).result();
  const answer = final.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  if (final.stopReason === "error" || !/^OK\.?$/.test(answer.trim()))
    throw new Error(final.errorMessage || "Unexpected final answer");
  return { api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, toolRoundTrip: true, answer };
}

async function checkOpenCode(profile) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "opengrove-provider-smoke-")));
  const marker = join(directory, "audit-marker.txt");
  writeFileSync(marker, "OG_PROVIDER_SMOKE_OK\n");
  const env = buildOpenCodeProviderEnv(profile);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  for (const provider of Object.values(config.provider)) provider.options.apiKey = "{env:OPENGROVE_SMOKE_KEY}";
  config.permission = {
    "*": "deny",
    read: { "*": "deny", "audit-marker.txt": "allow", [marker]: "allow", [marker.replace(/^\//, "")]: "allow" },
  };
  config.agent = { build: { steps: 3 } };
  const childEnv = {
    ...process.env,
    ...env,
    OPENGROVE_SMOKE_KEY: profile.apiKey,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_TEST_HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    ...(proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1,localhost" } : {}),
  };
  delete childEnv.PWD;
  const child = spawn(
    process.env.OPENGROVE_OPENCODE_BIN || "opencode",
    [
      "run",
      "--dir",
      directory,
      "--pure",
      "--format",
      "json",
      "--log-level",
      "ERROR",
      "--title",
      "Provider smoke",
      `Read ${marker} using the read tool. Reply only with its exact content. Do not use other tools.`,
    ],
    { cwd: directory, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "",
    timedOut = false;
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 45000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const read = events.some(
    (event) => event.type === "tool_use" && event.part?.tool === "read" && event.part.state?.status === "completed",
  );
  const answer = (events.filter((event) => event.type === "text").at(-1)?.part?.text || "").trim();
  if (timedOut || code !== 0 || !read || answer !== "OG_PROVIDER_SMOKE_OK")
    throw new Error(
      JSON.stringify({
        timedOut,
        code,
        read,
        answer,
        error: events.find((event) => event.type === "error")?.error,
        stderr: stderr.slice(-1000),
      }),
    );
  return { model: config.model, toolRoundTrip: true, answer, directory };
}
