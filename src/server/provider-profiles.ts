import { migrateWwProvisioning } from "./migrations/ww-provisioning-v1.js";
import { createHash } from "node:crypto";
import { appEnvName, readAppEnv } from "../identity.js";
import type {
  BridgeKernelId,
  BridgeModelProviderBinding,
  BridgeProviderCredentialKind,
  BridgeProviderModelCatalogEntry,
  BridgeProviderProfile,
  BridgeProviderSummary,
  BridgeProviderView,
  BridgeRuntimeControlOption,
} from "./bridge-types.js";
import {
  BRIDGE_KERNEL_IDS,
  LEGACY_NATIVE_PROVIDER_BINDING_ID,
  LOGIN_PROVIDER_BINDING_ID,
  UNCONFIGURED_PROVIDER_BINDING_ID,
} from "./bridge-types.js";
import { buildProviderEnvForKernel } from "./kernel-registry.js";
import type { HermesProviderApiMode, HermesProviderRuntimeConfig } from "../runtime/hermes-runtime.js";
import {
  planProviderBinding,
  providerHasTransferableCredential,
  usesKernelManagedProviderConfig,
} from "./provider-binding.js";
import { providerModelDiscoveryRevision, readDiscoveredProviderModels } from "./provider-model-discovery.js";
import {
  applyModelsDevCatalog,
  modelOfferingKey,
  modelOfferingKeyForSelection,
  modelsDevCatalogModelCount,
  modelsDevCatalogModelRevision,
  providerModelForSelection,
  providerServesModelSelection,
} from "./models-dev-catalog.js";
import { providerRuntimeState, providerView, resolveProviderApiKey } from "./provider-state.js";
import type { ProviderProfile, ProviderProtocol } from "../kernel/types.js";

export { resolveProviderApiKey } from "./provider-state.js";

export const VOLC_CODING_PROVIDER_ID = "volc-coding-plan";
export const WW_PROVIDER_ID = "ww";
export const WW_DEFAULT_MODEL_ID = "deepseek-v4-flash";

const VOLC_MODELS: BridgeRuntimeControlOption[] = [
  { id: "glm-5.1", label: "GLM-5.1" },
  { id: "minimax-m2.7", label: "MiniMax-M2.7" },
  { id: "ark-code-latest", label: "Ark Code Latest" },
];

const WW_MODELS: BridgeRuntimeControlOption[] = [
  {
    id: WW_DEFAULT_MODEL_ID,
    label: "DeepSeek V4 Flash",
    apiModelId: WW_DEFAULT_MODEL_ID,
    canonicalModelId: "deepseek/deepseek-v4-flash-0731",
    family: "deepseek-v4",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    apiModelId: "claude-opus-4-8",
    canonicalModelId: "anthropic/claude-opus-4-8",
    family: "claude-opus",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    apiModelId: "deepseek-v4-pro",
    canonicalModelId: "deepseek/deepseek-v4-pro-0813",
    family: "deepseek-v4",
  },
];

export function wwDefaultProviderModels(): BridgeRuntimeControlOption[] {
  return WW_MODELS.map((model) => ({ ...model }));
}

function azureOpenAiBaseUrl(): string | undefined {
  const override = readAppEnv("AZURE_OPENAI_BASE_URL")?.trim();
  if (override) return override;
  const resourceName = process.env.AZURE_RESOURCE_NAME?.trim();
  if (!resourceName || !/^[a-z0-9][a-z0-9-]{1,62}$/i.test(resourceName)) return undefined;
  return `https://${resourceName}.openai.azure.com/openai/v1`;
}

export function getBridgeProviderProfiles(): BridgeProviderProfile[] {
  const profiles: BridgeProviderProfile[] = [
    {
      id: VOLC_CODING_PROVIDER_ID,
      name: "Volcengine Coding Plan",
      protocol: "openai-compatible",
      description:
        "Volcengine Coding Plan, available to multiple kernels through OpenAI-compatible or Anthropic-compatible protocols.",
      openaiBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      anthropicBaseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      apiKeyEnv: appEnvName("VOLC_CODING_API_KEY"),
      credentialKind: "env-key",
      wireApi: "chat",
      models: VOLC_MODELS,
      websiteUrl: "https://console.volcengine.com/ark",
    },
    {
      id: "openai",
      name: "OpenAI API",
      protocol: "openai-compatible",
      routeKind: "provider",
      description: "OpenAI API credentials managed as a Provider. Codex account login is a separate Login route.",
      openaiBaseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialKind: "env-key",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
        { id: "gpt-5.2", label: "GPT-5.2" },
      ],
      websiteUrl: "https://platform.openai.com",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic-compatible",
      description:
        "Anthropic API credentials configured explicitly in OpenGrove. Claude account login is managed separately by the Claude Kernel.",
      anthropicBaseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      credentialKind: "env-key",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
        { id: "claude-fable-5", label: "Claude Fable 5" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
      websiteUrl: "https://console.anthropic.com",
    },
    {
      id: WW_PROVIDER_ID,
      name: "WW",
      protocol: "anthropic-compatible",
      description: "WW Anthropic-compatible provider.",
      anthropicBaseUrl: readAppEnv("WW_BASE_URL"),
      apiKeyEnv: appEnvName("WW_API_KEY"),
      credentialKind: "env-key",
      models: wwDefaultProviderModels(),
    },
    {
      id: "aws-bedrock-api-key",
      name: "AWS Bedrock (API Key)",
      protocol: "anthropic-compatible",
      description: "AWS Bedrock Provider using the host AWS credential chain.",
      credentialKind: "aws",
      models: [],
      websiteUrl: "https://aws.amazon.com/bedrock/",
    },
    {
      id: "google-vertex",
      name: "Google Vertex AI",
      protocol: "anthropic-compatible",
      description: "Google Vertex Provider using host Google Application Default Credentials.",
      credentialKind: "google-adc",
      models: [],
      websiteUrl: "https://cloud.google.com/vertex-ai",
    },
    {
      id: "gemini",
      name: "Google AI Studio (Gemini API Key)",
      protocol: "gemini-compatible",
      description: "A Gemini API key created and managed in Google AI Studio.",
      geminiBaseUrl: "https://generativelanguage.googleapis.com",
      apiKeyEnv: "GEMINI_API_KEY",
      credentialKind: "env-key",
      models: [
        { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
        { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
        { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      ],
      websiteUrl: "https://ai.google.dev/",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-compatible",
      description: "DeepSeek OpenAI-compatible / Anthropic-compatible API.",
      anthropicBaseUrl: "https://api.deepseek.com/anthropic",
      apiKeyEnv: appEnvName("DEEPSEEK_API_KEY"),
      wireApi: "responses",
      models: [
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", defaultProviderId: "deepseek" },
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", defaultProviderId: "deepseek" },
      ],
      websiteUrl: "https://platform.deepseek.com",
    },
    {
      id: "zhipu-glm",
      name: "Zhipu GLM",
      protocol: "openai-compatible",
      description: "A commonly used compatible API for Zhipu GLM / Z.ai.",
      openaiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: appEnvName("ZHIPU_API_KEY"),
      models: [{ id: "glm-5", label: "GLM-5" }],
      websiteUrl: "https://open.bigmodel.cn",
    },
    {
      id: "kimi",
      name: "Kimi",
      protocol: "openai-compatible",
      description: "Moonshot/Kimi APIs compatible with OpenAI and the Claude Agent runtime.",
      openaiBaseUrl: "https://api.moonshot.cn/v1",
      anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
      apiKeyEnv: appEnvName("KIMI_API_KEY"),
      models: [
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
        { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed" },
        { id: "kimi-k2.6", label: "Kimi K2.6" },
      ],
      websiteUrl: "https://platform.moonshot.cn",
    },
    {
      id: "xiaomi-mimo",
      name: "Xiaomi MiMo",
      protocol: "openai-compatible",
      description: "Xiaomi MiMo OpenAI-compatible / Anthropic-compatible API.",
      anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic",
      apiKeyEnv: appEnvName("XIAOMI_API_KEY"),
      credentialKind: "env-key",
      models: [],
      websiteUrl: "https://platform.xiaomimimo.com",
    },
    {
      id: "bailian",
      name: "Alibaba Bailian",
      protocol: "openai-compatible",
      description: "An API compatible with Alibaba Cloud Bailian / DashScope.",
      openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropicBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      apiKeyEnv: appEnvName("DASHSCOPE_API_KEY"),
      models: [],
      websiteUrl: "https://bailian.console.aliyun.com",
    },
    {
      id: "minimax",
      name: "MiniMax",
      protocol: "openai-compatible",
      description: "MiniMax OpenAI-compatible / Anthropic-compatible API.",
      openaiBaseUrl: "https://api.minimax.io/v1",
      anthropicBaseUrl: "https://api.minimax.io/anthropic",
      apiKeyEnv: appEnvName("MINIMAX_API_KEY"),
      models: [
        { id: "MiniMax-M3", label: "MiniMax M3" },
        { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
      ],
      websiteUrl: "https://www.minimaxi.com",
    },
    {
      id: "aihubmix",
      name: "AiHubMix",
      protocol: "openai-compatible",
      description: "AiHubMix APIs compatible with OpenAI and the Claude Agent runtime.",
      openaiBaseUrl: "https://aihubmix.com/v1",
      anthropicBaseUrl: "https://aihubmix.com",
      apiKeyEnv: appEnvName("AIHUBMIX_API_KEY"),
      models: [],
      websiteUrl: "https://aihubmix.com",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      protocol: "openai-compatible",
      description: "An aggregated gateway compatible with OpenAI and Anthropic.",
      anthropicBaseUrl: "https://openrouter.ai/api",
      apiKeyEnv: appEnvName("OPENROUTER_API_KEY"),
      models: [],
      websiteUrl: "https://openrouter.ai",
    },
    {
      id: "azure",
      name: "Azure OpenAI",
      protocol: "openai-compatible",
      description:
        "Azure OpenAI v1 API. Configure AZURE_RESOURCE_NAME or an explicit base URL, and use deployment names when they differ from model ids.",
      openaiBaseUrl: azureOpenAiBaseUrl(),
      apiKeyEnv: "AZURE_API_KEY",
      credentialKind: "env-key",
      wireApi: "chat",
      models: [],
      websiteUrl: "https://ai.azure.com",
    },
    {
      id: "xai",
      name: "xAI",
      protocol: "openai-compatible",
      description: "xAI API through its OpenAI-compatible endpoint.",
      openaiBaseUrl: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
      credentialKind: "env-key",
      wireApi: "responses",
      models: [],
      websiteUrl: "https://console.x.ai",
    },
  ];
  return profiles.map((profile) =>
    applyModelsDevCatalog(
      {
        ...profile,
        descriptionCode: providerDescriptionCode(profile.id),
      },
      { declaredModelsOnly: true },
    ),
  );
}

export function getAllBridgeProviderProfiles(
  customProviders: BridgeProviderProfile[] | undefined,
): BridgeProviderProfile[] {
  return resolveBridgeProviderProfiles(customProviders, "full").map((entry) => entry.profile);
}

type ResolvedBridgeProviderProfile = {
  profile: BridgeProviderProfile;
  modelCount: number;
  modelCatalogRevision: string;
};

type RouteProviderDirectoryCache = {
  revision: string;
  profiles: BridgeProviderProfile[];
};

const routeProviderDirectories = new WeakMap<BridgeProviderProfile[], RouteProviderDirectoryCache>();
let defaultRouteProviderDirectory: RouteProviderDirectoryCache | undefined;

function providerProfilesForRoute(customProviders: BridgeProviderProfile[] | undefined): BridgeProviderProfile[] {
  const revision = [
    providerModelDiscoveryRevision(),
    createHash("sha256")
      .update(JSON.stringify(customProviders ?? []))
      .digest("hex"),
    readAppEnv("WW_BASE_URL") ?? "",
    readAppEnv("AZURE_OPENAI_BASE_URL") ?? "",
    process.env.AZURE_RESOURCE_NAME ?? "",
  ].join("\0");
  const cached = customProviders ? routeProviderDirectories.get(customProviders) : defaultRouteProviderDirectory;
  if (cached?.revision === revision) return cached.profiles;
  const profiles = getAllBridgeProviderProfiles(customProviders);
  const next = { revision, profiles };
  if (customProviders) routeProviderDirectories.set(customProviders, next);
  else defaultRouteProviderDirectory = next;
  return profiles;
}

function resolveBridgeProviderProfiles(
  customProviders: BridgeProviderProfile[] | undefined,
  catalogMode: "full" | "summary",
): ResolvedBridgeProviderProfile[] {
  const presets = getBridgeProviderProfiles();
  const profiles = new Map(presets.map((profile) => [profile.id, profile]));
  const custom = (customProviders ?? [])
    .map(normalizeCustomProviderProfile)
    .filter((profile): profile is BridgeProviderProfile => Boolean(profile));
  const customModelOverrides = new Set(
    custom
      .filter((profile) => profile.models.length > 0 && profile.modelsPinned !== false)
      .map((profile) => profile.id),
  );
  for (const profile of custom) {
    if (profile.deleted) {
      profiles.delete(profile.id);
      continue;
    }
    const preset = profiles.get(profile.id);
    if (!preset) {
      profiles.set(profile.id, profile);
      continue;
    }
    const merged = { ...preset, ...withoutUndefined(profile), custom: true, deleted: false };
    if (profile.description && profile.description !== preset.description) {
      delete merged.descriptionCode;
    }
    if (profile.id === WW_PROVIDER_ID && profile.modelsPinned !== true) {
      // WW credentials are provisioned into a saved profile, but its model catalog
      // remains product-owned. Let new built-in models reach existing users unless
      // they explicitly pinned a custom WW model list.
      merged.models = preset.models;
    } else if (profile.models.length === 0 && preset.models.length > 0) {
      merged.models = preset.models;
    }
    if (profile.credentialKind === "api-key" && !profile.apiKey && !profile.apiKeyEnv) {
      delete merged.apiKey;
      delete merged.apiKeyEnv;
    }
    profiles.set(profile.id, merged);
  }
  if (hasDiscoveredClaudeBedrock(custom)) {
    const template = profiles.get("aws-bedrock-api-key");
    if (template && !template.custom && !template.apiKey) {
      profiles.delete("aws-bedrock-api-key");
    }
  }
  return Array.from(profiles.values())
    .filter((profile) => !profile.deleted)
    .map((profile) => {
      const discoveredModels = customModelOverrides.has(profile.id) ? undefined : readDiscoveredProviderModels(profile);
      const resolved = discoveredModels ? { ...profile, models: discoveredModels } : profile;
      const declaredModelsOnly = Boolean(discoveredModels || customModelOverrides.has(profile.id));
      return {
        profile: applyModelsDevCatalog(resolved, {
          declaredModelsOnly: catalogMode === "summary" || declaredModelsOnly,
        }),
        modelCount: modelsDevCatalogModelCount(resolved, { declaredModelsOnly }),
        modelCatalogRevision:
          catalogMode === "summary" ? modelsDevCatalogModelRevision(resolved, { declaredModelsOnly }) : "",
      };
    });
}

/** Joins the Provider directory with live activation and credential state for UI reads. */
export function getBridgeProviderViews(
  customProviders: BridgeProviderProfile[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BridgeProviderView[] {
  return getAllBridgeProviderProfiles(customProviders).map((profile) => providerView(profile, env));
}

/** Bounded settings projection. Complete model arrays use getBridgeProviderModelCatalog(). */
export function getBridgeProviderSummaries(
  customProviders: BridgeProviderProfile[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BridgeProviderSummary[] {
  return resolveBridgeProviderProfiles(customProviders, "summary").map(
    ({ profile, modelCount, modelCatalogRevision }) => ({
      ...providerView(profile, env),
      models: [],
      modelCount,
      modelCatalogRevision,
    }),
  );
}

export function getBridgeProviderModelCatalog(
  customProviders: BridgeProviderProfile[] | undefined,
): BridgeProviderModelCatalogEntry[] {
  return getAllBridgeProviderProfiles(customProviders).map((profile) => ({
    id: profile.id,
    models: profile.models,
  }));
}

function providerDescriptionCode(providerId: string): NonNullable<BridgeProviderProfile["descriptionCode"]> {
  switch (providerId) {
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "aws-bedrock-api-key":
      return "bedrock";
    case "google-vertex":
      return "vertex";
    case "gemini":
      return "gemini";
    default:
      return "compatible";
  }
}

function hasDiscoveredClaudeBedrock(profiles: BridgeProviderProfile[]): boolean {
  return profiles.some(
    (profile) =>
      profile.id === "aws-bedrock" &&
      profile.origin === "discovered" &&
      profile.sourceKernel === "claude-code" &&
      profile.deleted !== true,
  );
}

export function resolveProviderForRoute(
  kernelId: BridgeKernelId,
  modelId: string | undefined,
  employeeProviderId: string | undefined,
  modelBindings: BridgeModelProviderBinding[] | undefined,
  customProviders?: BridgeProviderProfile[],
): BridgeProviderProfile | undefined {
  const route = resolveProviderRoute(kernelId, modelId, employeeProviderId, modelBindings, customProviders);
  return route.binding.kind === "provider" && route.binding.status === "ready" ? route.binding.profile : undefined;
}

export type BridgeProviderRouteSource = "employee" | "runtime" | "model" | "unresolved";

export interface BridgeResolvedProviderRoute {
  providerId: string;
  source: BridgeProviderRouteSource;
  binding: BridgeKernelProviderBindingInfo;
}

/** Resolves the Provider independently for one Employee turn. */
export function resolveProviderRoute(
  kernelId: BridgeKernelId,
  modelId: string | undefined,
  providerOverrideId: string | undefined,
  modelBindings: BridgeModelProviderBinding[] | undefined,
  customProviders?: BridgeProviderProfile[],
  overrideSource: Extract<BridgeProviderRouteSource, "employee" | "runtime"> = "employee",
): BridgeResolvedProviderRoute {
  const providerOverride = providerOverrideId?.trim();
  const normalizedModel = modelId?.trim();
  const exactModelRoute = normalizedModel
    ? modelBindings?.find((binding) => binding.modelId === normalizedModel)
    : undefined;
  const compatibleProfiles =
    normalizedModel && !exactModelRoute ? providerProfilesForRoute(customProviders) : undefined;
  const selectedOffering =
    normalizedModel && !exactModelRoute
      ? modelOfferingKeyForSelection(normalizedModel, compatibleProfiles ?? [])
      : undefined;
  const compatibleModelRoute =
    normalizedModel && !exactModelRoute
      ? modelBindings?.find((binding) => {
          const boundProfile = compatibleProfiles?.find((profile) => profile.id === binding.providerId);
          const boundModel = providerModelForSelection(boundProfile, binding.modelId);
          const selectedModel = providerModelForSelection(boundProfile, normalizedModel);
          return (
            Boolean(boundModel && selectedModel && modelOfferingKey(boundModel) === modelOfferingKey(selectedModel)) ||
            modelOfferingKeyForSelection(binding.modelId, compatibleProfiles ?? []) === selectedOffering
          );
        })
      : undefined;
  const modelRoute = (exactModelRoute || compatibleModelRoute)?.providerId.trim();
  const providerId = providerOverride || modelRoute || UNCONFIGURED_PROVIDER_BINDING_ID;
  const source: BridgeProviderRouteSource = providerOverride ? overrideSource : modelRoute ? "model" : "unresolved";
  const routeProfiles =
    compatibleProfiles ?? (providerRouteNeedsDirectory(providerId) ? providerProfilesForRoute(customProviders) : []);
  return {
    providerId,
    source,
    binding: describeProviderRouteFromProfiles(kernelId, providerId, routeProfiles, normalizedModel),
  };
}

export function providerKeyPresent(profile: BridgeProviderProfile): boolean {
  return Boolean(resolveProviderApiKey(profile));
}

export type BridgeKernelProviderBindingStatus =
  | "ready"
  | "missing-key"
  | "verification-required"
  | "missing-provider"
  | "unsupported"
  | "disabled"
  | "unknown";

export type BridgeKernelProviderBindingInfo =
  | { kind: "login" }
  | { kind: "unresolved"; status: "selection-required" }
  | {
      kind: "provider";
      providerId: string;
      profile?: BridgeProviderProfile;
      status: BridgeKernelProviderBindingStatus;
    };

// Unlike runtime route resolution, this preserves an unavailable binding so the UI
// can show it explicitly instead of silently switching the visible model catalog.
export function describeProviderRoute(
  kernelId: BridgeKernelId,
  providerId: string | undefined,
  customProviders?: BridgeProviderProfile[],
  modelId?: string,
): BridgeKernelProviderBindingInfo {
  const profiles = providerRouteNeedsDirectory(providerId) ? providerProfilesForRoute(customProviders) : [];
  return describeProviderRouteFromProfiles(kernelId, providerId, profiles, modelId);
}

function providerRouteNeedsDirectory(providerId: string | undefined): boolean {
  return Boolean(
    providerId &&
      providerId !== UNCONFIGURED_PROVIDER_BINDING_ID &&
      providerId !== LEGACY_NATIVE_PROVIDER_BINDING_ID &&
      providerId !== LOGIN_PROVIDER_BINDING_ID,
  );
}

function describeProviderRouteFromProfiles(
  kernelId: BridgeKernelId,
  providerId: string | undefined,
  profiles: BridgeProviderProfile[],
  modelId?: string,
): BridgeKernelProviderBindingInfo {
  if (
    !providerId ||
    providerId === UNCONFIGURED_PROVIDER_BINDING_ID ||
    providerId === LEGACY_NATIVE_PROVIDER_BINDING_ID
  ) {
    return { kind: "unresolved", status: "selection-required" };
  }
  if (providerId === LOGIN_PROVIDER_BINDING_ID) return { kind: "login" };
  const profile = profiles.find((item) => item.id === providerId);
  if (!profile) return { kind: "provider", providerId, status: "unknown" };
  const support = providerSupportForBindingStatus(kernelId, profile);
  const normalizedModel = modelId?.trim();
  const modelUnsupported = Boolean(
    normalizedModel &&
      profile.models.length &&
      profile.modelsPinned !== false &&
      !providerServesModelSelection(profile, normalizedModel, profiles),
  );
  const runtime = providerRuntimeState(profile);
  const credentialsUnavailable = !runtime.credential.configured;
  const status: BridgeKernelProviderBindingStatus = !runtime.active
    ? "disabled"
    : credentialsUnavailable
      ? "missing-key"
      : profile.provisioningBlocked === true
        ? "verification-required"
        : !support.supported
          ? "unsupported"
          : modelUnsupported
            ? "unsupported"
            : "ready";
  return { kind: "provider", providerId, profile, status };
}

export function normalizeCustomProviderProfiles(input: unknown): BridgeProviderProfile[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(normalizeCustomProviderProfile)
    .filter((profile): profile is BridgeProviderProfile => Boolean(profile));
}

function normalizeCustomProviderProfile(input: unknown): BridgeProviderProfile | undefined {
  const source = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const id = slug(String(source.id || source.name || "")).slice(0, 48);
  const name = String(source.name || id || "")
    .trim()
    .slice(0, 80);
  if (!id || !name) return undefined;
  const protocol = normalizeProviderProtocol(source.protocol);
  const models = normalizeProviderModels(source.models);
  const deleted = source.deleted === true;
  const origin = normalizeProviderOrigin(source.origin);
  const sourceKernel = normalizeSourceKernel(source.sourceKernel);
  const sourceManaged = origin === "discovered" || Boolean(sourceKernel);
  const credentialKind = normalizeProfileCredentialKind(id, normalizeCredentialKind(source.credentialKind));
  const apiKey = normalizeProfileApiKey(id, credentialKind, normalizeApiKey(source.apiKey, source.apiKeyEnv));
  return {
    id,
    name,
    custom: true,
    deleted,
    enabled: typeof source.enabled === "boolean" ? source.enabled : undefined,
    origin,
    sourceKernel,
    source: stringOrUndefined(source.source),
    sourcePaths: normalizeStringArray(source.sourcePaths),
    // authConfigured is an adapter/discovery observation, never a Host-managed
    // credential preference. Drop stale values copied from renderer read models.
    authConfigured: sourceManaged && typeof source.authConfigured === "boolean" ? source.authConfigured : undefined,
    routeKind: normalizeProviderRouteKind(source, protocol, credentialKind),
    protocol,
    description: stringOrUndefined(source.description),
    openaiBaseUrl: stringOrUndefined(source.openaiBaseUrl),
    anthropicBaseUrl: stringOrUndefined(source.anthropicBaseUrl),
    geminiBaseUrl: stringOrUndefined(source.geminiBaseUrl),
    apiKey,
    apiKeyEnv: normalizeApiKeyEnv(source.apiKeyEnv),
    provisioningBlocked: source.provisioningBlocked === true ? true : undefined,
    provisioning: id === "ww" ? migrateWwProvisioning(source) : undefined,
    credentialKind,
    wireApi: normalizeProviderWireApi(source.wireApi),
    modelsPinned: typeof source.modelsPinned === "boolean" ? source.modelsPinned : undefined,
    models,
    websiteUrl: stringOrUndefined(source.websiteUrl),
  };
}

function normalizeProviderProtocol(value: unknown): BridgeProviderProfile["protocol"] {
  return value === "native-oauth" ||
    value === "openai-compatible" ||
    value === "anthropic-compatible" ||
    value === "gemini-compatible" ||
    value === "custom-gateway"
    ? value
    : "openai-compatible";
}

function normalizeProviderOrigin(value: unknown): BridgeProviderProfile["origin"] | undefined {
  return value === "builtin" || value === "discovered" || value === "user" ? value : undefined;
}

function normalizeProviderRouteKind(
  source: Record<string, unknown>,
  protocol: BridgeProviderProfile["protocol"],
  credentialKind: BridgeProviderProfile["credentialKind"],
): NonNullable<BridgeProviderProfile["routeKind"]> {
  if (source.routeKind === "login" || source.routeKind === "provider") return source.routeKind;
  // v0.6.1 persisted Kernel-owned routes without routeKind. Only product-account
  // credentials become Login; cloud, API, and Gateway credentials stay Providers.
  if (protocol === "native-oauth" || credentialKind === "native-login") return "login";
  const kernel = normalizeSourceKernel(source.sourceKernel);
  const id = slug(String(source.id || source.name || ""));
  if (kernel === "kimi") return "login";
  if (kernel === "codex" && id === "openai" && credentialKind === "kernel-native") return "login";
  if (kernel === "claude-code" && id === "anthropic" && credentialKind === "kernel-native") return "login";
  return "provider";
}

function normalizeSourceKernel(value: unknown): BridgeKernelId | undefined {
  return typeof value === "string" && (BRIDGE_KERNEL_IDS as readonly string[]).includes(value)
    ? (value as BridgeKernelId)
    : undefined;
}

function normalizeCredentialKind(value: unknown): BridgeProviderCredentialKind | undefined {
  return value === "none" ||
    value === "native-login" ||
    value === "api-key" ||
    value === "env-key" ||
    value === "aws" ||
    value === "google-adc" ||
    value === "kernel-native" ||
    value === "gateway-managed"
    ? value
    : undefined;
}

function normalizeProfileCredentialKind(
  providerId: string,
  credentialKind: BridgeProviderCredentialKind | undefined,
): BridgeProviderCredentialKind | undefined {
  return isAwsBedrockProviderId(providerId) ? "aws" : credentialKind;
}

function isAwsBedrockProviderId(providerId: string): boolean {
  return providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === "amazon-bedrock";
}

function normalizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values = input.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return values.length ? Array.from(new Set(values)) : undefined;
}

function normalizeProviderModels(input: unknown): BridgeRuntimeControlOption[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const models: BridgeRuntimeControlOption[] = [];
  for (const item of input) {
    const source: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { id: item };
    const id = String(source.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: String(source.label || id).trim(),
      description: stringOrUndefined(source.description),
      defaultProviderId: stringOrUndefined(source.defaultProviderId),
      apiModelId: stringOrUndefined(source.apiModelId),
      canonicalModelId: stringOrUndefined(source.canonicalModelId),
      family: stringOrUndefined(source.family),
      status: normalizeModelStatus(source.status),
    });
  }
  return models;
}

function normalizeModelStatus(value: unknown): BridgeRuntimeControlOption["status"] {
  return value === "alpha" || value === "beta" || value === "deprecated" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApiKey(input: unknown, legacyApiKeyEnv: unknown): string | undefined {
  const explicit = stringOrUndefined(input);
  if (explicit) return normalizeInlineApiKey(explicit);
  const legacy = stringOrUndefined(legacyApiKeyEnv);
  return legacy && !isEnvironmentVariableName(legacy) ? normalizeInlineApiKey(legacy) : undefined;
}

function normalizeInlineApiKey(value: string): string | undefined {
  const trimmed = value.trim();
  const assignment = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const normalized = stripShellValue(assignment?.[1] ?? trimmed);
  return normalized || undefined;
}

function stripShellValue(value: string): string {
  let next = value.trim();
  if (next.endsWith(";")) next = next.slice(0, -1).trim();
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

function normalizeProfileApiKey(
  providerId: string,
  credentialKind: BridgeProviderCredentialKind | undefined,
  apiKey: string | undefined,
): string | undefined {
  if (!apiKey) return undefined;
  if (providerId === "aws-bedrock-api-key") {
    return apiKey.startsWith("ABSK") ? apiKey : undefined;
  }
  if (credentialKind === "aws" && apiKey.startsWith("ark-")) {
    return undefined;
  }
  return apiKey;
}

function normalizeApiKeyEnv(input: unknown): string | undefined {
  const value = stringOrUndefined(input);
  return value && isEnvironmentVariableName(value) ? value : undefined;
}

function normalizeProviderWireApi(input: unknown): "chat" | "responses" | undefined {
  return input === "chat" || input === "responses" ? input : undefined;
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function providerEnvForKernel(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
  model: string | undefined,
): NodeJS.ProcessEnv | undefined {
  const binding = providerProfileForKernel(kernelId, profile, model);
  return binding ? buildProviderEnvForKernel(kernelId, binding) : undefined;
}

export function providerProfileForKernel(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
  model: string | undefined,
): ProviderProfile | undefined {
  if (!profile) return undefined;
  if (!providerRuntimeState(profile).usable) return undefined;
  if (usesKernelManagedProviderConfig(kernelId, profile)) return undefined;
  const plan = planProviderBinding(kernelId, profile);
  if (!plan.supported) return undefined;
  const protocol = externalProviderProtocol(plan.protocol);
  if (!protocol) return undefined;
  const selectedRoute = providerModelForSelection(profile, model);
  const selectedModel =
    selectedRoute?.apiModelId ||
    selectedRoute?.id ||
    model?.trim() ||
    profile.models[0]?.apiModelId ||
    profile.models[0]?.id;
  const baseUrl =
    protocol === "anthropic-compatible"
      ? profile.anthropicBaseUrl
      : protocol === "gemini-compatible"
        ? profile.geminiBaseUrl
        : profile.openaiBaseUrl;
  return {
    id: profile.id,
    name: profile.name,
    baseUrl,
    openaiBaseUrl: profile.openaiBaseUrl,
    anthropicBaseUrl: profile.anthropicBaseUrl,
    geminiBaseUrl: profile.geminiBaseUrl,
    apiKey: resolveProviderApiKey(profile) || undefined,
    apiKeyEnv: profile.apiKeyEnv,
    model: selectedModel,
    protocol,
    credentialKind: plan.credentialKind,
    wireApi: profile.wireApi,
    models: profile.models.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      apiModelId: m.apiModelId,
      canonicalModelId: m.canonicalModelId,
      family: m.family,
      status: m.status,
    })),
  };
}

function externalProviderProtocol(
  protocol: BridgeProviderProfile["protocol"] | undefined,
): ProviderProtocol | undefined {
  return protocol === "openai-compatible" || protocol === "anthropic-compatible" || protocol === "gemini-compatible"
    ? protocol
    : undefined;
}

export function providerModelsForKernel(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
): BridgeRuntimeControlOption[] {
  if (!profile) return [];
  if (!providerRuntimeState(profile).usable) return [];
  if (!providerSupportsKernel(kernelId, profile)) return [];
  return profile.models;
}

export function providerSupportsKernel(kernelId: BridgeKernelId, profile: BridgeProviderProfile): boolean {
  return planProviderBinding(kernelId, profile).supported;
}

/** Whether this route is structurally valid once its credentials are ready. */
export function providerCanBindKernel(kernelId: BridgeKernelId, profile: BridgeProviderProfile): boolean {
  return providerSupportForBindingStatus(kernelId, profile).supported;
}

function codexProviderApiKeyEnv(providerId: string): string {
  const normalized = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return appEnvName(`${normalized || "PROVIDER"}_API_KEY`);
}

export function hermesProviderConfigForKernel(
  profile: BridgeProviderProfile | undefined,
  model: string | undefined,
): HermesProviderRuntimeConfig | undefined {
  if (!profile) return undefined;
  if (profile.enabled === false) return undefined;
  const support = providerSupportForKernel("hermes", profile);
  const protocol = support.supported ? hermesProtocolForProvider(profile) : undefined;
  if (!protocol) return undefined;
  const baseUrl = protocol === "anthropic-compatible" ? profile.anthropicBaseUrl : profile.openaiBaseUrl;
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) return undefined;
  const apiKeyEnv = profile.apiKeyEnv || codexProviderApiKeyEnv(profile.id);
  const selectedRoute = providerModelForSelection(profile, model);
  const selectedModel =
    selectedRoute?.apiModelId ||
    selectedRoute?.id ||
    model?.trim() ||
    profile.models[0]?.apiModelId ||
    profile.models[0]?.id;
  return {
    providerKey: hermesProviderKey(profile.id),
    name: profile.name,
    baseUrl: trimmedBaseUrl,
    apiKeyEnv,
    apiMode: hermesApiModeForProtocol(protocol),
    model: selectedModel,
    models: profile.models.map((item) => item.id),
  };
}

export function providerSupportForKernel(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile,
): { supported: boolean; protocol?: BridgeProviderProfile["protocol"]; reason: string } {
  const plan = planProviderBinding(kernelId, profile);
  return {
    supported: plan.supported,
    protocol: plan.protocol,
    reason: plan.reason,
  };
}

function requiresEnvironmentKey(kernelId: string, profile: BridgeProviderProfile): boolean {
  if (profile.sourceKernel === kernelId && profile.authConfigured) return false;
  if (profile.protocol === "native-oauth") return false;
  return (
    profile.credentialKind === "api-key" ||
    profile.credentialKind === "env-key" ||
    providerHasTransferableCredential(profile)
  );
}

// 支持性回答“Key 就绪后这条路能不能跑”，Key 是否已经就绪由 binding status 单独表达。
// 对尚未拿到 Key 的配置补一个仅用于规划的 env 名，避免 planProviderBinding 把缺 Key 误判成协议不支持。
function providerSupportForBindingStatus(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile,
): ReturnType<typeof providerSupportForKernel> {
  const profileForPlanning =
    requiresEnvironmentKey(kernelId, profile) && !providerHasTransferableCredential(profile)
      ? { ...profile, apiKeyEnv: "OPENGROVE_PROVIDER_BINDING_STATUS_KEY" }
      : profile;
  return providerSupportForKernel(kernelId, profileForPlanning);
}

function hermesProtocolForProvider(
  profile: BridgeProviderProfile,
): "openai-compatible" | "anthropic-compatible" | undefined {
  if (profile.protocol === "anthropic-compatible" && profile.anthropicBaseUrl) {
    return "anthropic-compatible";
  }
  if (profile.openaiBaseUrl) {
    return "openai-compatible";
  }
  if (profile.anthropicBaseUrl) {
    return "anthropic-compatible";
  }
  return undefined;
}

function hermesApiModeForProtocol(protocol: "openai-compatible" | "anthropic-compatible"): HermesProviderApiMode {
  return protocol === "anthropic-compatible" ? "anthropic_messages" : "chat_completions";
}

function hermesProviderKey(providerId: string): string {
  return `opengrove-${slug(providerId) || "provider"}`.slice(0, 64);
}
