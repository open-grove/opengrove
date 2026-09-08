// Opt-in, paid API smoke. Build the server first. Keys come from the environment
// or an explicitly supplied local settings file; credentials are never printed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent } from "undici";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildPiProviderEnv, createPiKernelAdapter, resolvePiRuntimeModel } from "../dist/kernel/adapters/pi.js";
import { buildOpenCodeProviderEnv } from "../dist/kernel/adapters/opencode.js";
import { buildKimiProviderEnv } from "../dist/kernel/adapters/kimi.js";
import { buildClaudeCodeProviderEnv } from "../dist/kernel/adapters/claude-code.js";
import { applyClaudeHostManagedProviderEnv } from "../dist/runtime/claude-bedrock-env.js";
import { buildHermesProviderEnv, hermesProviderConfigFromProfile } from "../dist/kernel/adapters/hermes.js";
import { buildHermesConfigYaml } from "../dist/runtime/hermes/config.js";
import { AcpCliRuntime } from "../dist/runtime/acp-cli-runtime.js";
import { SessionStore, ApprovalInbox, QuestionInbox } from "../dist/core.js";
import { getAllBridgeProviderProfiles, providerProfileForKernel } from "../dist/server/provider-profiles.js";
import { migrateBridgeSettingsSourceToV1 } from "../dist/server/migrations/bridge-settings-v1.js";

import { createCodexKernelAdapterFromOptions, buildCodexProviderEnv } from "../dist/kernel/adapters/codex.js";
import { createKernelRuntime } from "../dist/kernel/adapter.js";
import { createOpenGrove } from "../dist/app/create-opengrove.js";

const flags = new Map();
const kernels = ["pi", "opencode", "kimi", "hermes", "claude-code", "codex"];
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (!["--settings", "--provider", "--kernel", "--resume-directory"].includes(flag) || !process.argv[index + 1]) {
    throw new Error(
      "Usage: node scripts/smoke-provider-routes.mjs [--settings path] [--provider gemini|deepseek] [--kernel pi|opencode|kimi|hermes|claude-code|codex] [--resume-directory path]",
    );
  }
  flags.set(flag, process.argv[index + 1]);
}
const selectedProvider = flags.get("--provider");
const selectedKernel = flags.get("--kernel");
if (selectedProvider && !["gemini", "deepseek"].includes(selectedProvider)) throw new Error("Unknown Provider");
if (selectedKernel && !kernels.includes(selectedKernel)) throw new Error("Unknown Kernel");
if (flags.has("--resume-directory") && (selectedKernel !== "pi" || !selectedProvider))
  throw new Error("Resume requires --kernel pi and one --provider");
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
    for (const kernel of selectedKernel ? [selectedKernel] : kernels) {
      if (["claude-code", "codex"].includes(kernel) && providerId === "gemini") {
        console.log(
          JSON.stringify({
            provider: providerId,
            kernel,
            skipped: "No native Google API-key route in this Kernel; compatibility proxies are outside this smoke",
          }),
        );
        continue;
      }
      const started = Date.now();
      try {
        const binding = providerProfileForKernel(kernel, { ...profile, enabled: true }, model);
        if (!binding?.apiKey) throw new Error(`${providerId}: missing credential or unsupported binding`);
        const check = {
          pi: checkPi,
          codex: checkCodex,
          opencode: checkOpenCode,
          kimi: checkKimi,
          hermes: checkHermes,
          "claude-code": checkClaude,
        }[kernel];
        const detail = await check(binding);
        const result = { provider: providerId, kernel, ok: true, elapsedMs: Date.now() - started, ...detail };
        results.push(result);
        console.log(redact(result));
      } catch (error) {
        const result = {
          provider: providerId,
          kernel,
          ok: false,
          elapsedMs: Date.now() - started,
          error: error.message,
        };
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
  const resume = flags.has("--resume-directory");
  const { directory, prompt } = resume
    ? {
        directory: realpathSync(flags.get("--resume-directory")),
        prompt:
          "Recall the marker from the original file read tool result in this conversation. Return that marker exactly, without adding end, punctuation, code fences or commentary. Do not call any tools.",
      }
    : isolatedFileProbe("pi");
  const env = { ...buildPiProviderEnv(profile), OPENGROVE_DATA_DIR: join(directory, "data") };
  const model = resolvePiRuntimeModel(env, profile.model, profile.models);
  const adapter = createPiKernelAdapter({ cwd: directory, configuredModel: profile.model, provider: profile, env });
  return {
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    ...(await runAdapterFileProbe(adapter, directory, prompt, profile.model, resume)),
  };
}

async function checkCodex(profile) {
  if (profile.wireApi !== "responses") throw new Error("The native Codex smoke requires Responses");
  const { directory, prompt } = isolatedFileProbe("codex");
  mkdirSync(join(directory, "codex-home"));
  const adapter = createCodexKernelAdapterFromOptions({
    cwd: directory,
    model: profile.model,
    provider: profile,
    env: { ...buildCodexProviderEnv(profile), CODEX_HOME: join(directory, "codex-home") },
  });
  return {
    api: "responses",
    baseUrl: profile.baseUrl,
    ...(await runAdapterFileProbe(adapter, directory, prompt, profile.model)),
  };
}

async function runAdapterFileProbe(adapter, directory, prompt, model, resume = false) {
  const runtime = createKernelRuntime(adapter);
  const app = createOpenGrove({ cwd: directory, readPage: async () => ({}), runtime });
  const events = [];
  try {
    for await (const event of runtime.runTurn({
      input: prompt,
      tools: [],
      requestedModelId: model,
      requestedEffort: "low",
      accessMode: "full-access",
      signal: AbortSignal.timeout(60000),
      context: {
        sessionId: "provider-smoke",
        activity: "chat",
        memory: app.memory,
        artifacts: app.artifacts,
        skills: app.skills,
        packs: app.packs,
        sessions: app.sessions,
        executions: app.executions,
        workingState: app.workingState,
        approvals: app.approvals,
        questions: app.questions,
      },
    }))
      events.push(event);
  } finally {
    await adapter.dispose?.();
  }
  const answer = (
    events.filter((e) => e.type === "model.response").at(-1)?.response.text ??
    events
      .filter((e) => e.type === "assistant.delta")
      .map((e) => e.text)
      .join("")
  ).trim();
  const errors = events.filter((e) => e.type === "error");
  const read = events.some((e) => e.type === "tool.finished" && e.result?.ok);
  const prior = events.find((e) => e.type === "model.requested")?.request;
  const resumedHistory =
    (prior?.session?.priorMessageCount ?? 0) >= 4 && JSON.stringify(prior?.messages).includes("OG_PROVIDER_SMOKE_OK");
  if (
    errors.length ||
    (resume ? !resumedHistory || events.some((e) => e.type === "tool.started") : !read) ||
    answer !== "OG_PROVIDER_SMOKE_OK"
  )
    throw new Error(JSON.stringify({ errors, read, answer, directory }));
  return { ...(resume ? { resumedHistory: true } : { toolRoundTrip: true }), answer, directory };
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

function isolatedFileProbe(kernel) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `opengrove-${kernel}-provider-smoke-`)));
  const marker = join(directory, "audit-marker.txt");
  writeFileSync(marker, "OG_PROVIDER_SMOKE_OK\n");
  return {
    directory,
    prompt: `Read exactly ${marker} using the file read tool. Reply only with its exact content. Do not read or modify other files or use other tools.`,
  };
}

async function checkKimi(profile) {
  const { directory, prompt } = isolatedFileProbe("kimi");
  const skillDir = join(directory, "skills");
  mkdirSync(skillDir);
  const env = {
    ...buildKimiProviderEnv(profile),
    KIMI_CODE_HOME: join(directory, "home"),
    KIMI_DISABLE_TELEMETRY: "1",
    KIMI_LOOP_MAX_STEPS_PER_TURN: "3",
  };
  const runtime = new AcpCliRuntime({
    kernelId: "kimi",
    title: "Kimi Code",
    command: process.env.OPENGROVE_KIMI_BIN || "kimi",
    acpArgs: ["--skills-dir", skillDir, "acp"],
    setModelFailure: "error",
    cwd: directory,
    configuredModel: profile.model,
    env,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const events = [];
  try {
    for await (const event of runtime.runTurn({
      input: prompt,
      context: {
        sessionId: "provider-smoke",
        sessions: new SessionStore(),
        approvals: new ApprovalInbox(),
        questions: new QuestionInbox(),
      },
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      accessMode: "full-access",
      signal: controller.signal,
    }))
      events.push(event);
  } finally {
    clearTimeout(timer);
    runtime.close();
  }
  const answer = events
    .filter((e) => e.type === "assistant.delta")
    .map((e) => e.text)
    .join("")
    .trim();
  const errors = events.filter((e) => e.type === "error");
  const read = events.some((e) => e.type === "tool.finished" && e.result?.ok);
  if (errors.length || !read || answer !== "OG_PROVIDER_SMOKE_OK")
    throw new Error(JSON.stringify({ errors, read, answer, directory, timedOut: controller.signal.aborted }));
  return { api: env.KIMI_MODEL_PROVIDER_TYPE, toolRoundTrip: true, answer, directory };
}

async function checkHermes(profile) {
  const { directory, prompt } = isolatedFileProbe("hermes");
  const homeDir = join(directory, "home");
  mkdirSync(homeDir);
  const config = hermesProviderConfigFromProfile(profile, profile.model);
  writeFileSync(join(homeDir, "config.yaml"), buildHermesConfigYaml(undefined, config));
  const usageFile = join(directory, "usage.json");
  const child = spawn(
    process.env.OPENGROVE_HERMES_BIN || "hermes",
    ["-z", prompt, "--ignore-rules", "-t", "file", "--reasoning", "low", "--usage-file", usageFile],
    {
      cwd: directory,
      env: { ...process.env, ...buildHermesProviderEnv(profile), HERMES_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
  if (!existsSync(usageFile)) throw new Error(JSON.stringify({ code, stdout, stderr: stderr.slice(-4000), directory }));
  const usage = JSON.parse(readFileSync(usageFile, "utf8"));
  const answer = stdout.trim();
  if (code !== 0 || !usage.completed || usage.failed || usage.api_calls < 2 || answer !== "OG_PROVIDER_SMOKE_OK")
    throw new Error(JSON.stringify({ code, answer, stderr: stderr.slice(-1000), usage }));
  return {
    api: config.apiMode,
    toolRoundTrip: true,
    answer,
    contextWindow: config.modelContextWindows?.[profile.model],
    directory,
  };
}

async function checkClaude(profile) {
  const { directory, prompt } = isolatedFileProbe("claude");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let result,
    read = false;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: directory,
        env: applyClaudeHostManagedProviderEnv(process.env, buildClaudeCodeProviderEnv(profile)),
        model: profile.model,
        settingSources: [],
        tools: ["Read"],
        allowedTools: ["Read"],
        maxTurns: 3,
        persistSession: false,
        effort: "low",
        abortController: controller,
      },
    })) {
      if (
        message.type === "assistant" &&
        message.message.content.some((part) => part.type === "tool_use" && part.name === "Read")
      )
        read = true;
      if (message.type === "result") result = message;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!read || result?.subtype !== "success" || result.result.trim() !== "OG_PROVIDER_SMOKE_OK")
    throw new Error(JSON.stringify({ read, subtype: result?.subtype, answer: result?.result, errors: result?.errors }));
  const contextWindow = result.modelUsage[profile.model]?.contextWindow;
  const expected = profile.models?.find((m) => (m.apiModelId || m.id) === profile.model)?.metadata?.contextWindow;
  if (expected && contextWindow !== expected) throw new Error(`Native context window ${contextWindow} != ${expected}`);
  return { api: "anthropic", toolRoundTrip: true, answer: result.result.trim(), contextWindow, directory };
}
