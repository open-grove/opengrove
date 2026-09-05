import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BridgeProviderProfile, BridgeRuntimeControlOption } from "../../server/bridge-types.js";
import { readAppEnv } from "../../identity.js";

// ===== Type definitions shared across profile readers =====

export type { BridgeRuntimeControlOption };

export type BridgeKernelId = "claude-code" | "codex" | "hermes" | "pi" | "openclaw" | "opencode" | "kimi";

export interface KernelLocalRouteProfile {
  kernel: BridgeKernelId;
  source: string;
  sourcePaths: string[];
  env: Record<string, string>;
  settingsModel?: string;
  providerId: string;
  providerLabel: string;
  protocol?: BridgeProviderProfile["protocol"];
  baseUrl?: string;
  apiKeyEnv?: string;
  authConfigured: boolean;
  accountLogin?: { status: "authenticated" | "missing" | "unknown" | "provider" };
  routeKind: "login" | "provider";
  models: BridgeRuntimeControlOption[];
  defaultModel?: string;
  reasoningEfforts?: BridgeRuntimeControlOption[];
  defaultReasoningEffort?: string;
  speedTiers?: BridgeRuntimeControlOption[];
  defaultSpeedTier?: string;
}

export interface KernelLocalRouteReadOptions {
  refreshAuth?: boolean;
  cwd?: string;
  configHome?: string;
  binaryPath?: string;
}

// ===== File I/O utilities =====

export function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function readDotEnvFile(path: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of readFileText(path).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;
    const value = dotEnvValue(rawValue);
    if (value) output[key] = value;
  }
  return output;
}

function dotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

// ===== TOML utilities =====

export function readTomlString(text: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*"(.*?)"\\s*$`, "m"));
  return match?.[1];
}

export function readTomlTable(text: string, tableName: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const tableHeader = `[${tableName}]`;
  const output: Record<string, string> = {};
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inTable = trimmed === tableHeader;
      continue;
    }
    if (!inTable || !trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*"(.*?)"\s*$/);
    const key = match?.[1];
    const value = match?.[2];
    if (key && value !== undefined) output[key] = value;
  }
  return output;
}

// ===== YAML utilities =====

export function readYamlString(text: string, path: string[]): string | undefined {
  return parseYamlEntries(text).find((entry) => samePath(entry.path, path))?.value;
}

export function readYamlMapKeys(text: string, path: string[]): string[] {
  return Array.from(
    new Set(
      parseYamlEntries(text)
        .filter((entry) => entry.path.length === path.length + 1 && samePath(entry.path.slice(0, -1), path))
        .map((entry) => entry.path[entry.path.length - 1])
        .filter((entry): entry is string => Boolean(entry?.trim())),
    ),
  );
}

function parseYamlEntries(text: string): Array<{ path: string[]; value?: string }> {
  const stack: Array<{ indent: number; key: string }> = [];
  const entries: Array<{ path: string[]; value?: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = (match[1] ?? "").length;
    const key = (match[2] || match[3] || match[4] || "").trim();
    if (!key) continue;
    while ((stack.at(-1)?.indent ?? -1) >= indent) {
      stack.pop();
    }
    const path = [...stack.map((item) => item.key), key];
    const value = yamlScalarValue(match[5] ?? "");
    entries.push({ path, value });
    if (value === undefined) {
      stack.push({ indent, key });
    }
  }
  return entries;
}

function yamlScalarValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim() || undefined;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// ===== Shared helpers =====

export function configHome(configHomeOverride: string | undefined, fallbackHomePath: string): string {
  return configHomeOverride?.trim() || resolve(homedir(), fallbackHomePath);
}

export function readSelectedProcessEnv(keys: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) output[key] = value;
  }
  return output;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function modelDisplayName(model: string): string {
  const longContext = /\[1m\]$/i.test(model);
  const cleaned = model
    .replace(/^global\.anthropic\./, "")
    .replace(/^us\.anthropic\./, "")
    .replace(/^anthropic\//, "")
    .replace(/\[1m\]$/i, "")
    .replace(/-v\d+$/i, "")
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
  return longContext ? `${cleaned} (1M context)` : cleaned;
}

export function readStringMap(input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") output[key] = value;
    if (typeof value === "number" || typeof value === "boolean") output[key] = String(value);
  }
  return output;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

export function readOptions(input: string | KernelLocalRouteReadOptions): KernelLocalRouteReadOptions {
  return typeof input === "string" ? { cwd: input } : input;
}

// ===== Credential helpers =====

export function firstConfiguredCredentialId(input: Record<string, unknown>): string | undefined {
  return Object.entries(input).find(([, value]) => hasCredentialRecord(value))?.[0];
}

export function hasCredentialRecord(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nested = objectValue(record.tokens);
  if (Object.values(nested).some((item) => hasCredentialRecord(item))) return true;
  const credentialKeys = ["key", "apiKey", "api_key", "token", "access", "access_token", "refresh", "refresh_token"];
  return credentialKeys.some((key) => typeof record[key] === "string" && Boolean((record[key] as string).trim()));
}

export function providerDisplayName(value: string): string {
  const normalized = value.trim().toLowerCase();
  const known: Record<string, string> = {
    google: "Google",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    anthropic: "Anthropic",
    kimi: "Kimi",
    "kimi-code": "Kimi Code",
  };
  return known[normalized] || value;
}

export function isEnabled(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

export function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

// ===== Numeric utility =====

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ===== Kernel env readers (used by adapters) =====

export function readCodexConfiguredModel() {
  return (
    readAppEnv("CODEX_MODEL")?.trim() ||
    (readAppEnv("KERNEL") === "codex" ? readAppEnv("DEFAULT_MODEL")?.trim() : "") ||
    "gpt-5.4"
  );
}

export function readHermesConfiguredModel() {
  return (
    readAppEnv("HERMES_MODEL")?.trim() ||
    (readAppEnv("KERNEL") === "hermes" ? readAppEnv("DEFAULT_MODEL")?.trim() : "") ||
    undefined
  );
}
