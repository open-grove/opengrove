import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAppEnv } from "../../identity.js";
import {
  hermesCustomProviderKey,
  normalizeHermesProviderConfig,
  writeHermesHomeConfig,
  type HermesProviderRuntimeConfig,
} from "./config.js";
import { normalizeOptionalString } from "./prompt.js";

export function prepareHermesRuntimeEnv(input: {
  runtimeEnv: NodeJS.ProcessEnv | undefined;
  providerConfig: HermesProviderRuntimeConfig | undefined;
  nativeSkillDir: string | undefined;
  isolatedHome: string | undefined;
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
  const explicitHome = normalizeOptionalString(env.HERMES_HOME) ?? normalizeOptionalString(readAppEnv("HERMES_HOME"));
  if (explicitHome && !providerConfig) {
    env.HERMES_HOME = resolve(explicitHome);
    return { env, isolatedHome: input.isolatedHome };
  }

  const useIsolatedHome = Boolean(providerConfig) || readAppEnv("HERMES_ISOLATED_HOME") !== "0";
  if (!useIsolatedHome) {
    return { env, isolatedHome: input.isolatedHome };
  }

  const nativeSkillDir = normalizeOptionalString(input.nativeSkillDir);
  const usableNativeSkillDir = nativeSkillDir && existsSync(nativeSkillDir) ? nativeSkillDir : undefined;
  if (!usableNativeSkillDir && !providerConfig) {
    return { env, isolatedHome: input.isolatedHome };
  }

  const isolatedHome = input.isolatedHome ?? mkdtempSync(join(tmpdir(), "opengrove-hermes-"));
  if (!input.isolatedHome) {
    writeHermesHomeConfig(isolatedHome, usableNativeSkillDir, providerConfig);
  }
  env.HERMES_HOME = isolatedHome;
  return { env, isolatedHome };
}
