import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function prepareCodexAccountRuntime({ root, authJson, model, env = process.env }) {
  let auth;
  try {
    auth = JSON.parse(authJson);
  } catch {
    throw new Error("CODEX_AUTH_JSON must contain a dedicated Codex account credential");
  }
  if (!auth?.tokens?.access_token || typeof auth.tokens.access_token !== "string" || !/^gpt-[a-z0-9.-]+$/.test(model))
    throw new Error("Invalid Codex account profile");
  const home = resolve(root, "codex-native");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: auth.tokens, last_refresh: auth.last_refresh }),
    { mode: 0o600 },
  );
  writeFileSync(join(home, "config.toml"), `model = ${JSON.stringify(model)}\n`, { mode: 0o600 });
  const runtimeEnv = { ...env };
  for (const key of Object.keys(runtimeEnv))
    if (/^(?:OPENGROVE_REAL_RUNTIME_|OPENAI_|ANTHROPIC_|DEEPSEEK_|CODEX_|CI_RUNTIME_ENVIRONMENTS)/.test(key))
      delete runtimeEnv[key];
  return {
    ...runtimeEnv,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    OPENGROVE_REAL_RUNTIME_MODEL: model,
  };
}
