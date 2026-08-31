import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type HermesProviderApiMode = "chat_completions" | "anthropic_messages";

export interface HermesProviderRuntimeConfig {
  providerKey: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiMode: HermesProviderApiMode;
  model?: string;
  models?: string[];
}

export function writeHermesHomeConfig(
  homeDir: string,
  nativeSkillDir: string | undefined,
  providerConfig: HermesProviderRuntimeConfig | undefined,
): void {
  mkdirSync(homeDir, { recursive: true });
  const sourceEnv = resolve(homedir(), ".hermes", ".env");
  if (existsSync(sourceEnv)) {
    try {
      copyFileSync(sourceEnv, resolve(homeDir, ".env"));
    } catch {
      // Ignore copy failures; Hermes can still use process env credentials.
    }
  }
  writeFileSync(resolve(homeDir, "config.yaml"), buildHermesConfigYaml(nativeSkillDir, providerConfig), "utf8");
}

export function buildHermesConfigYaml(
  nativeSkillDir: string | undefined,
  providerConfig: HermesProviderRuntimeConfig | undefined,
): string {
  const lines: string[] = [];
  // The isolated home does not inherit ~/.hermes/config.yaml. Pin manual mode
  // so OpenGrove's accessMode + approval broker remains the policy authority;
  // Hermes' default smart mode may otherwise approve a dangerous command
  // without ever surfacing approval.request to the host.
  lines.push("approvals:");
  lines.push("  mode: manual");
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
        lines.push(`      ${yamlScalar(model)}: {}`);
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
  const apiMode = input?.apiMode === "anthropic_messages" ? "anthropic_messages" : "chat_completions";
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
