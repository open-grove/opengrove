import type { RuntimeAccessMode } from "../../core.js";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const explicitHome = normalizeOptionalString(env.HERMES_HOME) ?? normalizeOptionalString(readAppEnv("HERMES_HOME"));
  // Each process gets its own immutable approval policy, including for custom HERMES_HOME.
  env.HERMES_YOLO_MODE = "0";
  env.OPENGROVE_HERMES_APPROVAL_MODE =
    input.accessMode === "auto-review" ? "smart" : input.accessMode === "full-access" ? "off" : "manual";
  const nativeSkillDir = normalizeOptionalString(input.nativeSkillDir);
  const usableNativeSkillDir = nativeSkillDir && existsSync(nativeSkillDir) ? nativeSkillDir : undefined;
  const isolatedHome = input.isolatedHome ?? mkdtempSync(join(tmpdir(), "opengrove-hermes-"));
  if (!input.isolatedHome) {
    writeHermesHomeConfig(isolatedHome, usableNativeSkillDir, providerConfig, input.accessMode, explicitHome);
  }
  env.HERMES_HOME = isolatedHome;
  return { env, isolatedHome };
}
