import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeProviderProfile, BridgeRuntimeControlOption } from "./bridge-types.js";
import { providerRuntimeState } from "./provider-state.js";
import { defaultOpenGroveDataDir } from "../storage/default-data-dir.js";

// 标准 API provider(OpenAI/Anthropic)有官方模型枚举接口,模型名单应当读取而非手写。
// 缓存只在 provider 地址、密钥指纹和 TTL 都匹配时生效；否则立即回退静态声明。

const CACHE_FILE_NAME = "provider-models-cache.json";
const CACHE_VERSION = 2 as const;
const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const ANTHROPIC_PAGE_LIMIT = 1_000;
const MAX_DISCOVERY_PAGES = 100;
const DISCOVERABLE_PROVIDER_IDS = ["openai", "anthropic"] as const;

type DiscoverableProviderId = (typeof DISCOVERABLE_PROVIDER_IDS)[number];

type DiscoveryIdentity = {
  providerId: DiscoverableProviderId;
  source: string;
  apiKey: string;
  credentialFingerprint: string;
};

type DiscoveredProviderEntry = {
  source: string;
  checkedAt: string;
  credentialFingerprint: string;
  models: BridgeRuntimeControlOption[];
};

type DiscoveryCache = {
  version: typeof CACHE_VERSION;
  providers: Record<string, DiscoveredProviderEntry>;
};

// ===== 缓存读取(同步,供 provider profile 构造时调用) =====

function discoveryCachePath(): string {
  return join(defaultOpenGroveDataDir(), CACHE_FILE_NAME);
}

export function providerModelDiscoveryRevision(): string {
  const path = discoveryCachePath();
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

let memo: { path: string; mtimeMs: number; cache: DiscoveryCache | undefined } | undefined;

function readDiscoveryCache(): DiscoveryCache | undefined {
  const path = discoveryCachePath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    memo = { path, mtimeMs, cache: undefined };
    return undefined;
  }
  if (memo && memo.path === path && memo.mtimeMs === mtimeMs) {
    return memo.cache;
  }
  let cache: DiscoveryCache | undefined;
  try {
    cache = normalizeDiscoveryCache(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Discovery cache data is disposable; callers perform live provider discovery when this result is undefined.
    cache = undefined;
  }
  memo = { path, mtimeMs, cache };
  return cache;
}

function normalizeDiscoveryCache(value: unknown): DiscoveryCache | undefined {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.providers)) return undefined;
  const providers: Record<string, DiscoveredProviderEntry> = {};
  for (const [providerId, rawEntry] of Object.entries(value.providers)) {
    if (!isRecord(rawEntry)) continue;
    const source = stringValue(rawEntry.source);
    const checkedAt = stringValue(rawEntry.checkedAt);
    const credentialFingerprint = stringValue(rawEntry.credentialFingerprint);
    const models = normalizeCachedModels(rawEntry.models);
    if (!source || !checkedAt || !credentialFingerprint || !models.length) continue;
    providers[providerId] = { source, checkedAt, credentialFingerprint, models };
  }
  return { version: CACHE_VERSION, providers };
}

function normalizeCachedModels(value: unknown): BridgeRuntimeControlOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawModel) => {
    if (!isRecord(rawModel)) return [];
    const id = stringValue(rawModel.id);
    if (!id) return [];
    return [{ id, label: stringValue(rawModel.label) || id }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readDiscoveredProviderModels(
  profile: BridgeProviderProfile,
  now = new Date(),
): BridgeRuntimeControlOption[] | undefined {
  const identity = providerDiscoveryIdentity(profile);
  const entry = identity ? readDiscoveryCache()?.providers?.[identity.providerId] : undefined;
  if (!identity || !entry || !isUsableCacheEntry(entry, identity, now)) return undefined;
  const models = entry.models
    ?.filter((model) => typeof model?.id === "string" && model.id.trim())
    .map((model) => ({
      id: model.id,
      label: typeof model.label === "string" && model.label.trim() ? model.label : model.id,
    }));
  return models?.length ? models : undefined;
}

// ===== 刷新(异步;服务启动与 provider 设置保存时触发,静默失败) =====

export async function refreshProviderModelDiscovery(input: {
  profiles: BridgeProviderProfile[];
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const cache: DiscoveryCache = readDiscoveryCache() ?? { version: CACHE_VERSION, providers: {} };
  let changed = false;
  for (const providerId of DISCOVERABLE_PROVIDER_IDS) {
    const profile = input.profiles.find((item) => item.id === providerId && providerRuntimeState(item).usable);
    const identity = profile ? providerDiscoveryIdentity(profile) : undefined;
    const previous = cache.providers[providerId];
    if (!profile || !identity) {
      changed = removeCacheEntry(cache, providerId) || changed;
      continue;
    }
    const previousUsable = Boolean(previous && isUsableCacheEntry(previous, identity, now));
    if (!input.force && previousUsable) continue;
    try {
      const models = await discoverProviderModels(profile, identity, fetchImpl);
      if (!models.length) {
        changed = removeCacheEntry(cache, providerId) || changed;
        continue;
      }
      cache.providers[providerId] = {
        source: identity.source,
        checkedAt: now.toISOString(),
        credentialFingerprint: identity.credentialFingerprint,
        models,
      };
      changed = true;
    } catch {
      // 同一账号与接口的未过期缓存可抵御短暂断网；其他旧缓存必须作废。
      if (!previousUsable) changed = removeCacheEntry(cache, providerId) || changed;
    }
  }
  if (!changed) return;
  try {
    const path = discoveryCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    memo = undefined;
  } catch {
    // 缓存写失败只影响下次启动的新鲜度,不阻塞当前请求。
  }
}

function providerDiscoveryIdentity(profile: BridgeProviderProfile): DiscoveryIdentity | undefined {
  if (!isDiscoverableProviderId(profile.id) || profile.enabled === false) return undefined;
  const apiKey = profile.apiKey?.trim() || (profile.apiKeyEnv ? process.env[profile.apiKeyEnv]?.trim() : undefined);
  if (!apiKey) return undefined;
  const source = profile.id === "openai" ? openAiModelsSource(profile) : anthropicModelsSource(profile);
  return {
    providerId: profile.id,
    source,
    apiKey,
    credentialFingerprint: createHash("sha256").update(`${profile.id}\0${apiKey}`).digest("hex"),
  };
}

function isDiscoverableProviderId(value: string): value is DiscoverableProviderId {
  return DISCOVERABLE_PROVIDER_IDS.some((providerId) => providerId === value);
}

function isUsableCacheEntry(entry: DiscoveredProviderEntry, identity: DiscoveryIdentity, now: Date): boolean {
  const checkedAt = Date.parse(entry.checkedAt);
  const age = now.getTime() - checkedAt;
  return (
    entry.source === identity.source &&
    entry.credentialFingerprint === identity.credentialFingerprint &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < REFRESH_TTL_MS
  );
}

function removeCacheEntry(cache: DiscoveryCache, providerId: DiscoverableProviderId): boolean {
  if (!cache.providers[providerId]) return false;
  delete cache.providers[providerId];
  return true;
}

async function discoverProviderModels(
  profile: BridgeProviderProfile,
  identity: DiscoveryIdentity,
  fetchImpl: typeof fetch,
): Promise<BridgeRuntimeControlOption[]> {
  if (identity.providerId === "openai") {
    const payload = await fetchJsonWithTimeout(fetchImpl, identity.source, {
      Authorization: `Bearer ${identity.apiKey}`,
    });
    return normalizeOpenAiModelsResponse(payload);
  }

  const rows: unknown[] = [];
  let afterId: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const request = anthropicModelsRequest(profile, identity.apiKey, afterId);
    const payload = await fetchJsonWithTimeout(fetchImpl, request.url, request.headers);
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    if (Array.isArray(record.data)) rows.push(...record.data);
    if (record.has_more !== true) return normalizeAnthropicModelsResponse({ data: rows });
    const nextCursor = typeof record.last_id === "string" ? record.last_id.trim() : "";
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("anthropic_models_invalid_cursor");
    seenCursors.add(nextCursor);
    afterId = nextCursor;
  }
  throw new Error("anthropic_models_too_many_pages");
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`provider_models_http_${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function openAiModelsSource(profile: BridgeProviderProfile): string {
  const base = profile.openaiBaseUrl?.trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
  return `${base}/models`;
}

function anthropicModelsSource(profile: BridgeProviderProfile): string {
  const base = profile.anthropicBaseUrl?.trim().replace(/\/+$/, "") || "https://api.anthropic.com";
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function anthropicModelsRequest(
  profile: BridgeProviderProfile,
  apiKey: string,
  afterId?: string,
): { url: string; headers: Record<string, string> } {
  const url = new URL(anthropicModelsSource(profile));
  url.searchParams.set("limit", String(ANTHROPIC_PAGE_LIMIT));
  if (afterId) url.searchParams.set("after_id", afterId);
  return {
    url: url.toString(),
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  };
}

const OPENAI_CHAT_MODEL_PATTERN = /^(?:ft:)?(?:gpt-|o\d)/i;
// /v1/models 混着语音/嵌入/图像等端点,按 id 关键词排除非对话模型。
const OPENAI_NON_CHAT_PATTERN = /(audio|realtime|transcribe|tts|whisper|embedding|moderation|image|dall)/i;

export function normalizeOpenAiModelsResponse(payload: unknown): BridgeRuntimeControlOption[] {
  const data = (payload as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      const record = item as { id?: unknown; created?: unknown };
      return {
        id: typeof record.id === "string" ? record.id.trim() : "",
        created: typeof record.created === "number" ? record.created : 0,
      };
    })
    .filter((model) => model.id && OPENAI_CHAT_MODEL_PATTERN.test(model.id) && !OPENAI_NON_CHAT_PATTERN.test(model.id))
    .sort((left, right) => right.created - left.created)
    .map((model) => ({ id: model.id, label: model.id }));
}

export function normalizeAnthropicModelsResponse(payload: unknown): BridgeRuntimeControlOption[] {
  const data = (payload as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  return data
    .map((item) => {
      const record = item as { id?: unknown; display_name?: unknown; created_at?: unknown };
      return {
        id: typeof record.id === "string" ? record.id.trim() : "",
        label:
          typeof record.display_name === "string" && record.display_name.trim()
            ? record.display_name.trim()
            : undefined,
        createdAt: typeof record.created_at === "string" ? Date.parse(record.created_at) || 0 : 0,
      };
    })
    .filter((model) => model.id)
    .sort((left, right) => right.createdAt - left.createdAt)
    .filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .map((model) => ({ id: model.id, label: model.label ?? model.id }));
}
