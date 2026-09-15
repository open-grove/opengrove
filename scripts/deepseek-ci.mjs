import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const kernels = ["claude-code", "codex", "opencode", "pi", "hermes", "kimi", "openclaw"];

export function prepareDeepSeekRuntime(
  kernel,
  {
    root,
    apiKey,
    model = "deepseek-flash",
    openclawPluginPath = process.env.OPENGROVE_CI_OPENCLAW_DEEPSEEK_PLUGIN || "/opt/opengrove/deepseek-provider",
  },
) {
  if (!kernels.includes(kernel)) throw new Error(`Unsupported kernel: ${kernel}`);
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey))
    throw new Error("DeepSeek API key is required");
  if (!/^deepseek-[a-z0-9.-]+$/.test(model)) throw new Error("A DeepSeek model ID is required");
  const home = resolve(root, "deepseek", kernel);
  mkdirSync(home, { recursive: true });
  const env = {
    OPENGROVE_REAL_RUNTIME_MODEL: model,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
  };
  if (kernel === "claude-code") {
    return {
      ...env,
      CLAUDE_CONFIG_DIR: home,
      OPENGROVE_REAL_RUNTIME_ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      OPENGROVE_REAL_RUNTIME_ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    };
  }
  if (kernel !== "openclaw") {
    return {
      ...env,
      OPENGROVE_REAL_RUNTIME_OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY: apiKey,
      ...(kernel === "codex" ? { CODEX_HOME: home } : {}),
      ...(kernel === "kimi" ? { KIMI_CODE_HOME: home } : {}),
      ...(kernel === "hermes" ? { HERMES_HOME: home } : {}),
      ...(kernel === "opencode" ? { XDG_CONFIG_HOME: home, XDG_DATA_HOME: join(home, "data") } : {}),
    };
  }
  const token = randomBytes(24).toString("hex");
  const configPath = join(home, "openclaw.json");
  const config = {
    plugins: { allow: ["deepseek"], load: { paths: [openclawPluginPath] } },
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token },
    },
    agents: {
      defaults: {
        model: { primary: `deepseek/${model}` },
        workspace: join(home, "workspace"),
      },
    },
    models: {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "${DEEPSEEK_API_KEY}",
          api: "openai-completions",
          models: [
            {
              id: model,
              name: model,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1000000,
              maxTokens: 32768,
            },
          ],
        },
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    ...env,
    OPENGROVE_REAL_RUNTIME_MODEL: `deepseek/${model}`,
    DEEPSEEK_API_KEY: apiKey,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENGROVE_OPENCLAW_GATEWAY_TOKEN: token,
    OPENGROVE_CI_OPENCLAW_DEEPSEEK_PLUGIN: openclawPluginPath,
  };
}

// A disposable Gateway belongs to this case, never the developer's running Gateway.
// The runtime probe separately verifies the real handshake, version and capabilities.
export async function startDeepSeekGateway(env) {
  if (!existsSync(join(env.OPENGROVE_CI_OPENCLAW_DEEPSEEK_PLUGIN, "package.json"))) {
    throw new Error("The pinned OpenClaw DeepSeek provider is missing from the runtime image");
  }
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
  const child = spawn("openclaw", ["gateway", "--port", String(port), "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12000);
    });
  const stop = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
      child.kill("SIGTERM");
    });
  };
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`OpenClaw Gateway exited with ${child.signalCode || child.exitCode}`);
      const listening = await new Promise((resolveListening) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const finish = (ready) => {
          socket.destroy();
          resolveListening(ready);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(1000, () => finish(false));
      });
      if (listening)
        return {
          env: { OPENGROVE_OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${port}` },
          stop,
        };
      await delay(250);
    }
    throw new Error("OpenClaw Gateway startup exceeded 60 seconds");
  } catch (error) {
    await stop();
    for (const secret of [env.DEEPSEEK_API_KEY, env.OPENGROVE_OPENCLAW_GATEWAY_TOKEN]) {
      if (secret) output = output.replaceAll(secret, "[REDACTED]");
    }
    throw new Error(`${error.message}\n${output}`, { cause: error });
  }
}
