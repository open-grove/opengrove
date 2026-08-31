import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ALLOWED_EXACT_ENV = new Set(["PATH", "HOME", "SHELL", "USER", "USERNAME", "LANG", "TMPDIR", "TEMP", "TMP"]);

const ALLOWED_PREFIXES = ["LC_", "OPENAI_", "ANTHROPIC_", "GEMINI_", "QWEN_", "AWS_", "GOOGLE_", "OPENGROVE_"];

export async function resolveDesktopEnvironment(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") {
    return { ...baseEnv };
  }

  const shell = baseEnv.SHELL || "/bin/zsh";
  try {
    const result = await execFileAsync(shell, ["-lc", "env"], {
      env: baseEnv,
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return mergeDesktopEnvironment(baseEnv, filterAllowedEnv(parseEnvOutput(result.stdout)));
  } catch {
    return { ...baseEnv };
  }
}

export function mergeDesktopEnvironment(baseEnv: NodeJS.ProcessEnv, shellEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = {
    ...baseEnv,
    ...shellEnv,
  };
  if (!baseEnv.OPENGROVE_DESKTOP_DEV_PROFILE?.trim()) {
    return merged;
  }
  for (const key of Object.keys(merged)) {
    if (!isDesktopDevProfileOwnedEnvKey(key)) continue;
    if (Object.prototype.hasOwnProperty.call(baseEnv, key)) {
      merged[key] = baseEnv[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

function parseEnvOutput(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    env[key] = line.slice(separator + 1);
  }
  return env;
}

function filterAllowedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !isAllowedEnvKey(key)) continue;
    output[key] = value;
  }
  return output;
}

function isAllowedEnvKey(key: string): boolean {
  return ALLOWED_EXACT_ENV.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isDesktopDevProfileOwnedEnvKey(key: string): boolean {
  return (
    key === "OPENGROVE_DESKTOP_DEV_PROFILE" ||
    key === "OPENGROVE_DESKTOP_DEV_USER_DATA_DIR" ||
    key.startsWith("OPENGROVE_WW_") ||
    key.startsWith("OPENGROVE_RELEASE_CONTROL_") ||
    key.startsWith("OPENGROVE_APP_STORE_") ||
    key.startsWith("APP_STORE_")
  );
}
