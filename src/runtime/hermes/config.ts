import { createRequire } from "node:module";
import type { RuntimeAccessMode } from "../../core.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const yaml = createRequire(import.meta.url)("js-yaml") as {
  load(text: string): unknown;
  dump(value: unknown): string;
};

export function hermesApprovalMode(accessMode: RuntimeAccessMode | undefined): "manual" | "smart" | "off" {
  return accessMode === "auto-review" ? "smart" : accessMode === "full-access" ? "off" : "manual";
}

export type HermesProviderApiMode = "chat_completions" | "codex_responses" | "anthropic_messages";

export interface HermesProviderRuntimeConfig {
  providerKey: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiMode: HermesProviderApiMode;
  model?: string;
  models?: string[];
  modelContextWindows?: Record<string, number>;
}

export function writeHermesHomeConfig(
  homeDir: string,
  nativeSkillDir: string | undefined,
  providerConfig: HermesProviderRuntimeConfig | undefined,
  accessMode?: RuntimeAccessMode,
  sourceHome = resolve(homedir(), ".hermes"),
): void {
  mkdirSync(homeDir, { recursive: true });
  for (const name of [".env", "auth.json"]) {
    const source = resolve(sourceHome, name);
    if (existsSync(source)) copyFileSync(source, resolve(homeDir, name));
  }
  const sourceConfig = resolve(sourceHome, "config.yaml");
  const base = existsSync(sourceConfig) ? yaml.load(readFileSync(sourceConfig, "utf8")) : {};
  const generated = yaml.load(buildHermesConfigYaml(nativeSkillDir, providerConfig, accessMode));
  const merged = { ...configObject(base), ...configObject(generated) };
  merged.approvals = { ...configObject(configObject(base).approvals), mode: hermesApprovalMode(accessMode) };
  writeFileSync(resolve(homeDir, "config.yaml"), yaml.dump(merged), { encoding: "utf8", mode: 0o600 });
}

function configObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("hermes_config_must_be_mapping");
  return value as Record<string, unknown>;
}

export function buildHermesConfigYaml(
  nativeSkillDir: string | undefined,
  providerConfig: HermesProviderRuntimeConfig | undefined,
  accessMode?: RuntimeAccessMode,
): string {
  const lines: string[] = [];
  lines.push("approvals:");
  lines.push(`  mode: ${hermesApprovalMode(accessMode)}`);
  lines.push("");
  if (providerConfig) {
    const modelProvider = hermesCustomProviderKey(providerConfig.providerKey);
    lines.push("model:");
    lines.push(`  provider: ${yamlScalar(modelProvider)}`);
    if (providerConfig.model) {
      lines.push(`  default: ${yamlScalar(providerConfig.model)}`);
    }
    lines.push(`  base_url: ${yamlScalar(providerConfig.baseUrl)}`);
    lines.push(`  api_mode: ${yamlScalar(providerConfig.apiMode)}`);
    if (providerConfig.apiKeyEnv) {
      lines.push(`  key_env: ${yamlScalar(providerConfig.apiKeyEnv)}`);
    }
    lines.push("");
    lines.push("providers:");
    lines.push(`  ${yamlScalar(providerConfig.providerKey)}:`);
    lines.push(`    name: ${yamlScalar(providerConfig.name)}`);
    lines.push(`    base_url: ${yamlScalar(providerConfig.baseUrl)}`);
    if (providerConfig.apiKeyEnv) {
      lines.push(`    key_env: ${yamlScalar(providerConfig.apiKeyEnv)}`);
    }
    lines.push(`    transport: ${yamlScalar(providerConfig.apiMode)}`);
    if (providerConfig.model) {
      lines.push(`    default_model: ${yamlScalar(providerConfig.model)}`);
    }
    if (providerConfig.models?.length) {
      lines.push("    models:");
      for (const model of providerConfig.models) {
        const contextWindow = providerConfig.modelContextWindows?.[model];
        if (contextWindow) {
          lines.push(`      ${yamlScalar(model)}:`);
          lines.push(`        context_length: ${contextWindow}`);
        } else {
          lines.push(`      ${yamlScalar(model)}: {}`);
        }
      }
    }
    lines.push("");
  }

  if (nativeSkillDir) {
    const normalizedSkillDir = resolve(nativeSkillDir);
    lines.push("skills:");
    lines.push("  external_dirs:");
    lines.push(`    - ${yamlScalar(normalizedSkillDir)}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function normalizeHermesProviderConfig(
  input: HermesProviderRuntimeConfig | undefined,
): HermesProviderRuntimeConfig | undefined {
  const providerKey = normalizeOptionalString(input?.providerKey);
  const name = normalizeOptionalString(input?.name);
  const baseUrl = normalizeOptionalString(input?.baseUrl);
  const apiMode =
    input?.apiMode === "anthropic_messages" || input?.apiMode === "codex_responses"
      ? input.apiMode
      : "chat_completions";
  if (!providerKey || !name || !baseUrl) return undefined;
  const model = normalizeOptionalString(input?.model);
  const models = Array.from(
    new Set([...(model ? [model] : []), ...(input?.models ?? []).map((entry) => entry.trim()).filter(Boolean)]),
  );
  return {
    providerKey,
    name,
    baseUrl,
    apiMode,
    apiKeyEnv: normalizeOptionalString(input?.apiKeyEnv),
    model,
    models,
    modelContextWindows: input?.modelContextWindows,
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function hermesCustomProviderKey(providerKey: string): string {
  return providerKey.startsWith("custom:") ? providerKey : `custom:${providerKey}`;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
