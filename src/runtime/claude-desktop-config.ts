import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeDesktopBedrockConfig {
  source: string;
  region?: string;
  credentialHelper?: string;
  models: Array<{ id: string; label?: string }>;
}

export function readClaudeDesktopBedrockConfig(): ClaudeDesktopBedrockConfig | undefined {
  const configRoot = join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  const metaPath = join(configRoot, "_meta.json");
  const meta = readJsonObject(metaPath);
  const appliedId = stringValue(meta?.appliedId);
  if (!appliedId) return undefined;

  const configPath = join(configRoot, `${appliedId}.json`);
  const config = readJsonObject(configPath);
  if (stringValue(config?.inferenceProvider) !== "bedrock") return undefined;

  const models = Array.isArray(config?.inferenceModels)
    ? config.inferenceModels
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
          const record = entry as Record<string, unknown>;
          const id = stringValue(record.name);
          if (!id) return undefined;
          const label = stringValue(record.labelOverride);
          return { id, ...(label ? { label } : {}) };
        })
        .filter((entry): entry is { id: string; label?: string } => Boolean(entry))
    : [];

  return {
    source: configPath,
    region: stringValue(config?.inferenceBedrockRegion),
    credentialHelper: stringValue(config?.inferenceCredentialHelper),
    models,
  };
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
