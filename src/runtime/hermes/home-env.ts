import type { RuntimeAccessMode } from "../../core.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appEnvName } from "../../identity.js";
import {
  hermesCustomProviderKey,
  normalizeHermesProviderConfig,
  readHermesHomeConfig,
  writeHermesHomeConfig,
  type HermesProviderRuntimeConfig,
} from "./config.js";
import { normalizeOptionalString } from "./prompt.js";

export function prepareHermesRuntimeEnv(input: {
  runtimeEnv: NodeJS.ProcessEnv | undefined;
  providerConfig: HermesProviderRuntimeConfig | undefined;
  nativeSkillDir: string | undefined;
  isolatedHome: string | undefined;
  accessMode?: RuntimeAccessMode;
}): { env: NodeJS.ProcessEnv; isolatedHome?: string } {
  const env = { ...process.env, ...input.runtimeEnv };
  const providerConfig = normalizeHermesProviderConfig(input.providerConfig);
  if (providerConfig?.model) {
    env.HERMES_MODEL = providerConfig.model;
    env.HERMES_INFERENCE_MODEL = providerConfig.model;
  }
  if (providerConfig?.providerKey) {
    env.HERMES_TUI_PROVIDER = hermesCustomProviderKey(providerConfig.providerKey);
  }
  const explicitHome =
    normalizeOptionalString(env.HERMES_HOME) ?? normalizeOptionalString(env[appEnvName("HERMES_HOME")]);
  // The native full-access switch also covers gates that do not consult approvals.mode.
  env.HERMES_YOLO_MODE = input.accessMode === "full-access" ? "1" : "0";
  const isolation = env[appEnvName("HERMES_ISOLATED_HOME")];
  if (!providerConfig && (isolation === "0" || (explicitHome && isolation !== "1"))) {
    const nativeHome = resolve(explicitHome ?? join(homedir(), ".hermes"));
    readHermesHomeConfig(nativeHome);
    env.HERMES_HOME = nativeHome;
    return { env };
  }
  const nativeSkillDir = normalizeOptionalString(input.nativeSkillDir);
  const usableNativeSkillDir = nativeSkillDir && existsSync(nativeSkillDir) ? nativeSkillDir : undefined;
  const isolatedHome = input.isolatedHome ?? mkdtempSync(join(tmpdir(), "opengrove-hermes-"));
  if (!input.isolatedHome) {
    try {
      writeHermesHomeConfig(isolatedHome, usableNativeSkillDir, providerConfig, input.accessMode, explicitHome);
    } catch (error) {
      rmSync(isolatedHome, { recursive: true, force: true });
      throw error;
    }
  }
  env.HERMES_HOME = isolatedHome;
  return { env, isolatedHome };
}

export function removeHermesRuntimeHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (error) {
    console.warn("hermes_runtime_home_cleanup_failed", home, (error as NodeJS.ErrnoException).code);
  }
}
