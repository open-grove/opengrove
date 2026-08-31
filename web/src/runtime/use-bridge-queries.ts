import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalsResponse,
  AuthSessionResponse,
  BridgeSettingsResponse,
  ClientUpdateResponse,
  ContextRecordsResponse,
  HealthResponse,
  InventoryResponse,
  KernelLoginsResponse,
  ProviderModelCatalogResponse,
  QuestionsResponse,
} from "../bridge";
import { bridgeHeaders, fetchJson, getAppStoreCatalog, postJson } from "../bridge";
import { APP_STORAGE_KEYS } from "../identity";
import { readDesktopApi } from "../desktop-api";
import { resolveBridgeAuthPolicy } from "../app-auth-policy";
import { useAgentEventsQuery } from "./use-agent-events-query";
import { pendingActionEventMarker } from "./bridge-sync-policy";
import { providerModelCatalogKey } from "./provider-model-catalog";
import {
  LIVE_APP_STORE_CATALOG_SOURCE,
  appStoreQueryKeys,
  resolveAppStoreCatalogQueryPolicy,
} from "../components/network/app-store-query";
import {
  claimDailyClientActivityAttempt,
  desktopClientActivityReport,
  desktopClientActivityWindowIsForeground,
  millisecondsUntilNextUtcDay,
} from "./client-activity";

const HEALTH_REFETCH_INTERVAL_MS = 60_000;
const KERNEL_LOGIN_DELAYED_REFETCH_MS = 1_500;

type OpsRunsResponse = {
  ok: boolean;
  runs?: InventoryResponse["runs"];
  revision?: string;
  unchanged?: boolean;
};

type OpsExecutionsResponse = {
  ok: boolean;
  executions?: InventoryResponse["executions"];
  revision?: string;
  unchanged?: boolean;
};

export function useBridgeQueries(input: {
  contextRecordsEnabled?: boolean;
  contextRunId?: string;
  desktopAccountOnboardingCompleted: boolean;
  desktopBridgeReady: boolean;
  kernelLoginsEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const desktopApi = readDesktopApi();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchJson<HealthResponse>("/health", { signal }),
    enabled: desktopApi ? input.desktopBridgeReady === true : true,
    refetchInterval: HEALTH_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const sessionAuthActive = healthQuery.data?.auth?.mode === "session";
  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: ({ signal }) =>
      fetchJson<AuthSessionResponse>("/auth/session", {
        signal,
        headers: bridgeHeaders(false),
      }),
    enabled: sessionAuthActive,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const desktopSavedSessionQuery = useQuery({
    queryKey: ["desktop-saved-auth-session"],
    queryFn: async () => Boolean(await desktopApi?.hasSavedAuthSession?.()),
    enabled: Boolean(desktopApi?.hasSavedAuthSession),
    retry: false,
    staleTime: Infinity,
  });
  const desktopBridgeAuthenticated = Boolean(desktopApi) && input.desktopBridgeReady === true;
  const desktopSavedSession = desktopSavedSessionQuery.data === true;
  const authPolicy = resolveBridgeAuthPolicy({
    healthKnown: Boolean(healthQuery.data),
    healthPending: healthQuery.isPending,
    sessionAuthActive,
    sessionPending: sessionQuery.isPending,
    sessionStatus: sessionQuery.data?.status,
    sessionFailed: sessionQuery.isError,
    sessionDegraded: sessionQuery.data?.verification === "stale",
    desktopBridgeAuthenticated,
    desktopSavedSession,
    desktopAccountOnboardingCompleted: input.desktopAccountOnboardingCompleted,
    bridgeTokenKnownOptional: healthQuery.data?.tokenRequired === false,
    bridgeTokenStored: hasBridgeToken(),
  });
  const protectedQueriesEnabled = authPolicy.bridgeProtectedQueriesEnabled;
  useEffect(() => {
    const userId = sessionQuery.data?.user?.userId;
    const report = desktopClientActivityReport(desktopApi);
    if (
      !userId ||
      !report ||
      sessionQuery.data?.status !== "authenticated" ||
      sessionQuery.data.verification === "stale"
    )
      return;

    let nextDayTimer: ReturnType<typeof setTimeout> | undefined;
    const reportIfActive = () => {
      if (!desktopClientActivityWindowIsForeground(document)) return;
      if (!claimDailyClientActivityAttempt(window.localStorage, userId)) return;
      void postJson<{ ok: boolean; day: string }>("/auth/activity", report).catch(() => undefined);
    };
    const scheduleNextDay = () => {
      if (nextDayTimer !== undefined) clearTimeout(nextDayTimer);
      nextDayTimer = setTimeout(() => {
        reportIfActive();
        scheduleNextDay();
      }, millisecondsUntilNextUtcDay());
    };
    const onForeground = () => {
      if (!desktopClientActivityWindowIsForeground(document)) return;
      reportIfActive();
      scheduleNextDay();
    };
    onForeground();
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
      if (nextDayTimer !== undefined) clearTimeout(nextDayTimer);
    };
  }, [desktopApi, sessionQuery.data?.status, sessionQuery.data?.user?.userId, sessionQuery.data?.verification]);
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<BridgeSettingsResponse>("/settings", { headers: bridgeHeaders(false) }),
    enabled: protectedQueriesEnabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const appStoreRegistryUrl = settingsQuery.data?.settings?.appStore?.registryUrl ?? "";
  const appStoreRegistryConfigured = Boolean(
    appStoreRegistryUrl.trim() && settingsQuery.data?.settings?.appStore?.registryToken?.trim(),
  );
  const appStoreCatalogQueryPolicy = resolveAppStoreCatalogQueryPolicy(LIVE_APP_STORE_CATALOG_SOURCE);
  const appStoreCatalogQuery = useQuery({
    queryKey: appStoreQueryKeys.catalog({
      userId: sessionQuery.data?.user?.userId,
      registryUrl: appStoreRegistryUrl,
      registryConfigured: appStoreRegistryConfigured,
    }),
    queryFn: () => getAppStoreCatalog(),
    ...appStoreCatalogQueryPolicy,
    enabled: protectedQueriesEnabled && appStoreCatalogQueryPolicy.enabled,
  });
  const providerCatalogKey = providerModelCatalogKey(settingsQuery.data?.settings);
  const providerModelsQuery = useQuery({
    queryKey: ["provider-models", providerCatalogKey],
    queryFn: () =>
      fetchJson<ProviderModelCatalogResponse>("/settings/provider-models", {
        headers: bridgeHeaders(false),
      }),
    placeholderData: keepPreviousData,
    enabled: protectedQueriesEnabled && Boolean(settingsQuery.data?.settings),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const kernelLoginsQuery = useQuery({
    queryKey: ["kernel-logins"],
    queryFn: ({ signal }) =>
      fetchJson<KernelLoginsResponse>("/settings/kernel-logins", {
        signal,
        headers: bridgeHeaders(false),
      }),
    enabled: protectedQueriesEnabled && input.kernelLoginsEnabled === true,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!protectedQueriesEnabled || input.kernelLoginsEnabled !== true) return;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["kernel-logins"] });
    }, KERNEL_LOGIN_DELAYED_REFETCH_MS);
    return () => clearTimeout(timer);
  }, [input.kernelLoginsEnabled, protectedQueriesEnabled, queryClient]);

  const inventoryQuery = useQuery({
    queryKey: ["inventory"],
    queryFn: () => fetchJson<InventoryResponse>("/inventory", { headers: bridgeHeaders(false) }),
    enabled: protectedQueriesEnabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const approvalsQuery = useQuery({
    queryKey: ["approvals"],
    queryFn: () => fetchJson<ApprovalsResponse>("/approvals?status=pending", { headers: bridgeHeaders(false) }),
    enabled: protectedQueriesEnabled,
    refetchOnWindowFocus: true,
  });

  const questionsQuery = useQuery({
    queryKey: ["questions"],
    queryFn: () => fetchJson<QuestionsResponse>("/questions?status=pending", { headers: bridgeHeaders(false) }),
    enabled: protectedQueriesEnabled,
    refetchOnWindowFocus: true,
  });

  const contextRecordsQuery = useQuery({
    queryKey: ["context-records", input.contextRunId || "recent"],
    queryFn: async () => {
      const key = ["context-records", input.contextRunId || "recent"] as const;
      const previous = queryClient.getQueryData<ContextRecordsResponse>(key);
      const params = new URLSearchParams();
      if (input.contextRunId) params.set("runId", input.contextRunId);
      if (previous?.revision) params.set("afterRevision", previous.revision);
      const response = await fetchJson<ContextRecordsResponse>(
        `/context-records${params.size ? `?${params.toString()}` : ""}`,
        { headers: bridgeHeaders(false) },
      );
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: protectedQueriesEnabled && input.contextRecordsEnabled === true,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const opsRunsQuery = useQuery<OpsRunsResponse>({
    queryKey: ["runs", "ops"],
    queryFn: async () => {
      const key = ["runs", "ops"] as const;
      const previous = queryClient.getQueryData<OpsRunsResponse>(key);
      const params = new URLSearchParams({ limit: "200" });
      if (previous?.revision) params.set("afterRevision", previous.revision);
      const response = await fetchJson<OpsRunsResponse>(`/runs?${params.toString()}`, {
        headers: bridgeHeaders(false),
      });
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: protectedQueriesEnabled && input.contextRecordsEnabled === true,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const opsExecutionsQuery = useQuery<OpsExecutionsResponse>({
    queryKey: ["executions", "ops"],
    queryFn: async () => {
      const key = ["executions", "ops"] as const;
      const previous = queryClient.getQueryData<OpsExecutionsResponse>(key);
      const params = new URLSearchParams({ limit: "200" });
      if (previous?.revision) params.set("afterRevision", previous.revision);
      const response = await fetchJson<OpsExecutionsResponse>(`/executions?${params.toString()}`, {
        headers: bridgeHeaders(false),
      });
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: protectedQueriesEnabled && input.contextRecordsEnabled === true,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const eventsQuery = useAgentEventsQuery({
    enabled: protectedQueriesEnabled,
    scopeKey: sessionQuery.data?.user?.userId ?? (sessionAuthActive ? "session:anonymous" : "local"),
    // The request itself waits for an event. This interval only reconnects
    // after a response. A Bridge that predates waitMs is held near the former
    // eight-second cadence instead of being accidentally polled every second.
    refetchInterval: 1_000,
    longPoll: true,
    legacyServerMinimumIntervalMs: 8_000,
  });
  const pendingActionMarker = pendingActionEventMarker(eventsQuery.data?.events ?? []);
  useEffect(() => {
    if (!protectedQueriesEnabled || !pendingActionMarker) return;
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    void queryClient.invalidateQueries({ queryKey: ["questions"] });
  }, [pendingActionMarker, protectedQueriesEnabled, queryClient]);

  // 登录后获取当前机器对应的最新安装包。打包桌面端用于更新提示，Web 端用于桌面版下载入口。
  // 这个六小时请求同时是已安装 App Store App 自动更新的周期触发器。
  const clientUpdateQuery = useQuery({
    queryKey: ["client-update"],
    queryFn: () => fetchJson<ClientUpdateResponse>("/auth/client-update", { headers: bridgeHeaders(false) }),
    enabled: authPolicy.clientUpdateEnabled,
    refetchInterval: 6 * 60 * 60_000,
    refetchIntervalInBackground: true,
    staleTime: 60 * 60_000,
    retry: 1,
  });

  return {
    desktopSavedSession,
    healthQuery,
    sessionQuery,
    settingsQuery,
    appStoreCatalogQuery,
    providerModelsQuery,
    kernelLoginsQuery,
    inventoryQuery,
    approvalsQuery,
    questionsQuery,
    contextRecordsQuery,
    opsRunsQuery,
    opsExecutionsQuery,
    eventsQuery,
    clientUpdateQuery,
  };
}

function hasBridgeToken(): boolean {
  return typeof localStorage !== "undefined" && Boolean(localStorage.getItem(APP_STORAGE_KEYS.bridgeToken)?.trim());
}
