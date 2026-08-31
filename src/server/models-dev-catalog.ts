import { createHash } from "node:crypto";
import catalogJson from "./models-dev-catalog.generated.json" with { type: "json" };
import type { BridgeProviderProfile, BridgeRuntimeControlOption } from "./bridge-types.js";

type CatalogModel = {
  id: string;
  name: string;
  family?: string;
  canonicalModelId?: string;
  status?: BridgeRuntimeControlOption["status"];
};

type CatalogProvider = {
  id: string;
  name: string;
  api?: string;
  env?: string[];
  doc?: string;
  models: CatalogModel[];
};

type Catalog = {
  version: number;
  source: { repository: string; commit: string };
  providers: Record<string, CatalogProvider>;
};

type ProviderCatalogOverlay = {
  catalogProviderId: string;
  /** Some regional/multi-protocol routes only share model metadata, not a complete model inventory. */
  modelPolicy: "catalog" | "declared";
  /** Restrict a multi-lab host to the product route represented by this profile. */
  canonicalModelPrefixes?: string[];
  /** Catalog API is authoritative only when it describes this exact OpenGrove route. */
  apiPolicy?: "catalog";
};

const catalog = catalogJson as unknown as Catalog;

// Models.dev owns public Provider/model facts. This small table is the OpenGrove
// overlay: product route id plus whether the public catalog matches this exact endpoint.
const PROVIDER_CATALOG_OVERLAYS: Record<string, ProviderCatalogOverlay> = {
  openai: { catalogProviderId: "openai", modelPolicy: "catalog" },
  anthropic: { catalogProviderId: "anthropic", modelPolicy: "catalog" },
  "aws-bedrock-api-key": { catalogProviderId: "amazon-bedrock", modelPolicy: "catalog" },
  "google-vertex": { catalogProviderId: "google-vertex-anthropic", modelPolicy: "catalog" },
  gemini: { catalogProviderId: "google", modelPolicy: "catalog" },
  deepseek: { catalogProviderId: "deepseek", modelPolicy: "catalog", apiPolicy: "catalog" },
  "zhipu-glm": { catalogProviderId: "zai", modelPolicy: "declared" },
  kimi: { catalogProviderId: "moonshotai-cn", modelPolicy: "catalog", apiPolicy: "catalog" },
  "xiaomi-mimo": { catalogProviderId: "xiaomi", modelPolicy: "catalog", apiPolicy: "catalog" },
  bailian: { catalogProviderId: "alibaba-cn", modelPolicy: "catalog", apiPolicy: "catalog" },
  minimax: { catalogProviderId: "minimax", modelPolicy: "catalog" },
  aihubmix: { catalogProviderId: "aihubmix", modelPolicy: "catalog" },
  openrouter: { catalogProviderId: "openrouter", modelPolicy: "catalog", apiPolicy: "catalog" },
  azure: {
    catalogProviderId: "azure",
    modelPolicy: "catalog",
    canonicalModelPrefixes: ["openai/"],
  },
  xai: { catalogProviderId: "xai", modelPolicy: "catalog" },
};

export function applyModelsDevCatalog(
  profile: BridgeProviderProfile,
  options: { declaredModelsOnly?: boolean } = {},
): BridgeProviderProfile {
  const catalogRoute = catalogRouteForProfile(profile);
  if (!catalogRoute) return profile;
  const { overlay, provider } = catalogRoute;
  const declaredModelsOnly = options.declaredModelsOnly || overlay.modelPolicy === "declared";
  const models = declaredModelsOnly
    ? profile.models.map((model) => enrichDeclaredModel(model, provider))
    : catalogModelsWithDeclaredDefaults(provider, profile.models);
  const primaryApi = provider.api?.trim();
  const catalogApi = overlay.apiPolicy === "catalog" ? primaryApi : undefined;
  const catalogEnv =
    profile.credentialKind === "aws" || profile.credentialKind === "google-adc" ? undefined : provider.env?.[0]?.trim();
  return {
    ...profile,
    catalogProviderId: provider.id,
    docsUrl: provider.doc?.trim() || profile.docsUrl,
    apiKeyEnv: profile.apiKeyEnv || catalogEnv || undefined,
    openaiBaseUrl:
      profile.protocol === "openai-compatible" ? profile.openaiBaseUrl || catalogApi : profile.openaiBaseUrl,
    anthropicBaseUrl:
      profile.protocol === "anthropic-compatible" ? profile.anthropicBaseUrl || catalogApi : profile.anthropicBaseUrl,
    geminiBaseUrl:
      profile.protocol === "gemini-compatible" ? profile.geminiBaseUrl || catalogApi : profile.geminiBaseUrl,
    models,
  };
}

export function modelsDevCatalogModelCount(
  profile: BridgeProviderProfile,
  options: { declaredModelsOnly?: boolean } = {},
): number {
  const catalogRoute = catalogRouteForProfile(profile);
  if (!catalogRoute || options.declaredModelsOnly || catalogRoute.overlay.modelPolicy === "declared") {
    return profile.models.length;
  }
  const catalogIds = new Set(catalogRoute.provider.models.map((model) => model.id));
  const productOnlyCount = profile.models.filter(
    (model) => !catalogIds.has(model.apiModelId?.trim() || model.id.trim()),
  ).length;
  return catalogRoute.provider.models.length + productOnlyCount;
}

export function modelsDevCatalogModelRevision(
  profile: BridgeProviderProfile,
  options: { declaredModelsOnly?: boolean } = {},
): string {
  const catalogRoute = catalogRouteForProfile(profile);
  const catalogIdentity =
    catalogRoute && !options.declaredModelsOnly && catalogRoute.overlay.modelPolicy !== "declared"
      ? `${catalog.source.commit}\0${catalogRoute.provider.id}`
      : "declared";
  return createHash("sha256")
    .update(catalogIdentity)
    .update("\0")
    .update(JSON.stringify(profile.models))
    .digest("hex")
    .slice(0, 16);
}

function catalogRouteForProfile(profile: BridgeProviderProfile):
  | {
      overlay: ProviderCatalogOverlay;
      provider: CatalogProvider;
    }
  | undefined {
  const overlay = PROVIDER_CATALOG_OVERLAYS[profile.id];
  const catalogProvider = overlay ? catalog.providers[overlay.catalogProviderId] : undefined;
  if (!overlay || !catalogProvider) return undefined;
  const provider = overlay.canonicalModelPrefixes?.length
    ? {
        ...catalogProvider,
        models: catalogProvider.models.filter((model) =>
          overlay.canonicalModelPrefixes?.some((prefix) => model.canonicalModelId?.startsWith(prefix)),
        ),
      }
    : catalogProvider;
  return { overlay, provider };
}

export function canonicalModelId(model: Pick<BridgeRuntimeControlOption, "id" | "canonicalModelId">): string {
  return model.canonicalModelId?.trim() || model.id.trim();
}

export function modelOfferingKey(model: Pick<BridgeRuntimeControlOption, "id" | "label" | "canonicalModelId">): string {
  const catalogName = normalizedCatalogModelName(model.label);
  return catalogName ? `name:${catalogName}` : `id:${canonicalModelId(model)}`;
}

function normalizedCatalogModelName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function providerModelForSelection(
  profile: Pick<BridgeProviderProfile, "models"> | undefined,
  selection: string | undefined,
): BridgeRuntimeControlOption | undefined {
  const normalized = selection?.trim();
  if (!profile || !normalized) return undefined;
  const exact = profile.models.find((model) => model.id === normalized || model.apiModelId === normalized);
  if (exact) return exact;
  const canonical = profile.models.filter((model) => canonicalModelId(model) === normalized);
  return canonical.sort(compareProviderRoutes)[0];
}

export function providerServesModelSelection(
  profile: Pick<BridgeProviderProfile, "models">,
  selection: string,
  profiles: Array<Pick<BridgeProviderProfile, "models">> = [profile],
): boolean {
  if (providerModelForSelection(profile, selection)) return true;
  const selectedOffering = modelOfferingKeyForSelection(selection, profiles);
  return profile.models.some((model) => modelOfferingKey(model) === selectedOffering);
}

export function modelOfferingKeyForSelection(
  selection: string,
  profiles: Array<Pick<BridgeProviderProfile, "models">>,
): string {
  const normalized = selection.trim();
  for (const profile of profiles) {
    const exact = profile.models.find(
      (candidate) => candidate.id === normalized || candidate.apiModelId === normalized,
    );
    if (exact) return modelOfferingKey(exact);
  }
  for (const profile of profiles) {
    const canonical = providerModelForSelection(profile, normalized);
    if (canonical) return modelOfferingKey(canonical);
  }
  return normalized;
}

function catalogModelsWithDeclaredDefaults(
  provider: CatalogProvider,
  declaredModels: BridgeRuntimeControlOption[],
): BridgeRuntimeControlOption[] {
  const catalogModels = provider.models.map(catalogModelOption);
  const byId = new Map(catalogModels.map((model) => [model.id, model]));
  const preferred = declaredModels.flatMap((declared) => {
    const catalogModel = byId.get(declared.apiModelId?.trim() || declared.id.trim());
    if (!catalogModel) return [];
    byId.delete(catalogModel.id);
    return [{ ...catalogModel, ...withoutUndefined(declared), label: catalogModel.label }];
  });
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  const productOnly = declaredModels
    .filter((model) => !catalogIds.has(model.apiModelId?.trim() || model.id.trim()))
    .map((model) => ({ ...model, apiModelId: model.apiModelId?.trim() || model.id.trim() }));
  return [...preferred, ...productOnly, ...byId.values()];
}

function enrichDeclaredModel(model: BridgeRuntimeControlOption, provider: CatalogProvider): BridgeRuntimeControlOption {
  const apiModelId = model.apiModelId?.trim() || model.id.trim();
  const catalogModel = provider.models.find((candidate) => candidate.id === apiModelId);
  if (!catalogModel) return { ...model, apiModelId };
  return {
    ...model,
    ...withoutUndefined({
      label: catalogModel.name,
      apiModelId,
      canonicalModelId: catalogModel.canonicalModelId || model.canonicalModelId,
      family: catalogModel.family || model.family,
      status: catalogModel.status || model.status,
    }),
  };
}

function catalogModelOption(model: CatalogModel): BridgeRuntimeControlOption {
  return withoutUndefined({
    id: model.id,
    label: model.name,
    apiModelId: model.id,
    canonicalModelId: model.canonicalModelId,
    family: model.family,
    status: model.status,
  }) as BridgeRuntimeControlOption;
}

function compareProviderRoutes(left: BridgeRuntimeControlOption, right: BridgeRuntimeControlOption): number {
  const leftCanonicalSuffix = canonicalModelId(left).split("/").at(-1);
  const rightCanonicalSuffix = canonicalModelId(right).split("/").at(-1);
  const leftPreferred = left.id === leftCanonicalSuffix ? 0 : 1;
  const rightPreferred = right.id === rightCanonicalSuffix ? 0 : 1;
  return leftPreferred - rightPreferred || left.id.length - right.id.length || left.id.localeCompare(right.id);
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export const modelsDevCatalogSource = catalog.source;
