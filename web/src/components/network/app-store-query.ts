import type { AppStoreResponse } from "../../bridge-settings-types";

const APP_STORE_QUERY_ROOT = ["app-store"] as const;

export const appStoreQueryKeys = {
  all: APP_STORE_QUERY_ROOT,
  catalog(input: { userId?: string; registryUrl: string; registryConfigured: boolean }) {
    return [...APP_STORE_QUERY_ROOT, input.userId ?? "anonymous", input.registryUrl, input.registryConfigured] as const;
  },
  publishPrepare(appId: string) {
    return [...APP_STORE_QUERY_ROOT, "publish", appId, "prepare"] as const;
  },
  publishProgress(appId: string) {
    return [...APP_STORE_QUERY_ROOT, "publish", appId, "progress"] as const;
  },
  versions(appId: string) {
    return [...APP_STORE_QUERY_ROOT, "versions", appId] as const;
  },
};

export type AppStoreCatalogSource = { kind: "live" } | { kind: "static"; data: AppStoreResponse };

export const LIVE_APP_STORE_CATALOG_SOURCE: AppStoreCatalogSource = { kind: "live" };

export function appStoreUpdateCount(catalog: AppStoreResponse | undefined): number {
  return catalog?.packages.filter((item) => item.updateAvailable === true).length ?? 0;
}

export function resolveAppStoreCatalogQueryPolicy(source: AppStoreCatalogSource) {
  return source.kind === "static"
    ? ({ enabled: false, refetchInterval: false } as const)
    : ({ enabled: true, refetchInterval: false, staleTime: 60_000, refetchOnWindowFocus: true } as const);
}

export function resolveAppStoreSaveAndPublishPolicy(input: { mountedAppCount: number; isAdmin: boolean }) {
  return {
    showEntry: input.mountedAppCount > 0 || input.isAdmin,
    canUploadArchive: input.isAdmin,
    canFormalPublish: input.isAdmin,
  };
}
