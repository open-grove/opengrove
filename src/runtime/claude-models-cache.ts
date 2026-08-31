import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// Claude Code's reasoning effort support is model-specific and reported at runtime by
// the SDK (query.supportedModels() → ModelInfo.supportedEffortLevels). The bridge that
// builds composer runtime-controls is synchronous and cannot await the SDK, so the
// runtime persists what it learns to a small cache file that the bridge reads later.
// This mirrors how Codex exposes per-model reasoning levels via ~/.codex/models_cache.json.

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export interface ClaudeModelEffortInfo {
  id: string;
  label?: string;
  supportsEffort: boolean;
  supportedEffortLevels: ClaudeEffortLevel[];
  // True when the SDK marks this model as a legacy/older revision (its description ends with
  // "· Legacy", e.g. "Opus 4.1 · Legacy"). Claude Code / VS Code hide these from the picker by
  // default, so the composer dropdown does too — but the entry is still cached so a pinned
  // legacy model can resolve its effort levels.
  legacy?: boolean;
}

interface ClaudeModelsCacheFile {
  updatedAt: string;
  models: ClaudeModelEffortInfo[];
}

const CACHE_FILE_NAME = "opengrove-models-cache.json";

function resolveCachePath(configHome?: string): string {
  const home = configHome?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), ".claude");
  return resolve(home, CACHE_FILE_NAME);
}

// The SDK signals a deprecated model only via its description text (e.g.
// "Opus 4.1 · Legacy") — there is no structured flag. Match the trailing "Legacy" marker.
function isLegacyDescription(value: unknown): boolean {
  return typeof value === "string" && /\blegacy\b/i.test(value);
}

function normalizeEffortLevels(value: unknown): ClaudeEffortLevel[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(CLAUDE_EFFORT_LEVELS);
  const seen = new Set<ClaudeEffortLevel>();
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item)) {
      seen.add(item as ClaudeEffortLevel);
    }
  }
  // Preserve canonical low→max order regardless of source ordering.
  return CLAUDE_EFFORT_LEVELS.filter((level) => seen.has(level));
}

// Persist per-model effort support learned from the SDK. Best-effort: any failure is
// swallowed so a cache write never disrupts a live turn.
export function writeClaudeModelsCache(
  // The SDK's supportedModels() returns ModelInfo objects keyed by `value`
  // (e.g. "us.anthropic.claude-opus-4-7"); older shapes used `id`. Accept both so a
  // field-name drift never silently drops every model and strands the composer on its
  // static effort fallback.
  models: Array<{
    value?: unknown;
    id?: unknown;
    displayName?: unknown;
    description?: unknown;
    supportsEffort?: unknown;
    supportedEffortLevels?: unknown;
  }>,
  options: { configHome?: string; now: string },
): void {
  try {
    const normalized: ClaudeModelEffortInfo[] = [];
    for (const model of models) {
      const rawId =
        typeof model.value === "string" && model.value.trim()
          ? model.value
          : typeof model.id === "string"
            ? model.id
            : "";
      const id = rawId.trim();
      if (!id) continue;
      const supportedEffortLevels = normalizeEffortLevels(model.supportedEffortLevels);
      const legacy = isLegacyDescription(model.description);
      normalized.push({
        id,
        label: typeof model.displayName === "string" && model.displayName.trim() ? model.displayName.trim() : undefined,
        supportsEffort: model.supportsEffort === true || supportedEffortLevels.length > 0,
        supportedEffortLevels,
        ...(legacy ? { legacy: true } : {}),
      });
    }
    if (!normalized.length) return;
    const payload: ClaudeModelsCacheFile = { updatedAt: options.now, models: normalized };
    const path = resolveCachePath(options.configHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Ignore — the bridge falls back to static effort levels when the cache is absent.
  }
}

// Read the cache server-side. Returns an empty array when absent/unreadable so callers
// fall back to a conservative static effort list.
export function readClaudeModelsCache(configHome?: string): ClaudeModelEffortInfo[] {
  try {
    const raw = readFileSync(resolveCachePath(configHome), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    const result: ClaudeModelEffortInfo[] = [];
    for (const entry of models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) continue;
      const supportedEffortLevels = normalizeEffortLevels(record.supportedEffortLevels);
      result.push({
        id,
        label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined,
        supportsEffort: record.supportsEffort === true || supportedEffortLevels.length > 0,
        supportedEffortLevels,
        ...(record.legacy === true ? { legacy: true } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}

// Resolve the effort options to advertise for a given model id, falling back across:
// exact model match → any cached model that supports effort → conservative static list.
export function resolveClaudeEffortLevels(
  cache: ClaudeModelEffortInfo[],
  modelId: string | undefined,
): ClaudeEffortLevel[] {
  const exact = modelId ? cache.find((model) => model.id === modelId) : undefined;
  if (exact && exact.supportsEffort && exact.supportedEffortLevels.length) {
    return exact.supportedEffortLevels;
  }
  const anySupported = cache.find((model) => model.supportsEffort && model.supportedEffortLevels.length);
  if (anySupported) {
    return anySupported.supportedEffortLevels;
  }
  return [];
}
