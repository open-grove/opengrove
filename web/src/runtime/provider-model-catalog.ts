import type { BridgeSettings, ProviderModelCatalogResponse } from "../bridge";

export function providerModelCatalogKey(settings: BridgeSettings | undefined): string {
  return (
    settings?.providers
      ?.map((provider) => `${provider.id}:${provider.modelCatalogRevision ?? provider.modelCount ?? 0}`)
      .join("|") ?? ""
  );
}

export function settingsWithProviderModels(
  settings: BridgeSettings | undefined,
  catalog: ProviderModelCatalogResponse | undefined,
): BridgeSettings | undefined {
  if (!settings?.providers) return settings;
  if (!catalog) return undefined;
  const modelsByProvider = new Map(catalog.providers.map((provider) => [provider.id, provider.models]));
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({
      ...provider,
      models: modelsByProvider.get(provider.id) ?? provider.models ?? [],
    })),
  };
}
