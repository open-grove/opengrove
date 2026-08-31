import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { appStoreQueryKeys } from "./components/network/app-store-query";
import type { BridgeSettings, ExtensionItemRecord } from "./bridge";
import { APP_STORAGE_KEYS } from "./identity";
import {
  readEmbeddedMountedAppRequest,
  resolveActiveMountedApp,
  resolveMountedApps,
} from "./app-mounted-app-workflow-model";
import { mountedAppMatchesId } from "./components/apps/mounted-app-model";
import { BridgeRequestError, uninstallMountedApp } from "./bridge";
import { useI18n } from "./i18n";
import type { ConfirmFn } from "./components/ui/confirm-dialog";

export function useMountedAppWorkflow(input: {
  activeView: string;
  confirm: ConfirmFn;
  inventoryItems: ExtensionItemRecord[];
  queryClient: QueryClient;
  settings: BridgeSettings | undefined;
  setView(view: string): void;
  showErrorToast(message: string): void;
}) {
  const { activeView, confirm, inventoryItems, queryClient, settings, setView, showErrorToast } = input;
  const { t } = useI18n();
  const [activeMountedAppId, setActiveMountedAppId] = useState(readStoredActiveMountedAppId);
  const [pendingMountedAppOpenId, setPendingMountedAppOpenId] = useState("");
  const storeActiveMountedAppId = useCallback((appId: string) => {
    setActiveMountedAppId(appId);
    writeStoredActiveMountedAppId(appId);
  }, []);

  const mountedApps = useMemo(() => resolveMountedApps(inventoryItems), [inventoryItems]);
  const { embedded: embeddedMountedAppMode, appId: embeddedMountedAppId } = readEmbeddedMountedAppRequest();
  const activeMountedApp = useMemo(
    () =>
      resolveActiveMountedApp({
        activeMountedAppId,
        activeView,
        embeddedAppId: embeddedMountedAppId,
        embeddedMode: embeddedMountedAppMode,
        mountedApps,
        pendingMountedAppOpenId,
      }),
    [
      activeMountedAppId,
      activeView,
      embeddedMountedAppId,
      embeddedMountedAppMode,
      mountedApps,
      pendingMountedAppOpenId,
    ],
  );
  const requestedMountedAppId = embeddedMountedAppMode ? embeddedMountedAppId : pendingMountedAppOpenId;
  const unresolvedMountedAppRequestId =
    requestedMountedAppId && (!activeMountedApp || !mountedAppMatchesId(activeMountedApp, requestedMountedAppId))
      ? requestedMountedAppId
      : "";

  useEffect(() => {
    if (embeddedMountedAppMode || !mountedApps.length) return;
    if (activeMountedAppId && mountedApps.some((app) => mountedAppMatchesId(app, activeMountedAppId))) return;
    if (activeView === "app" && !pendingMountedAppOpenId) storeActiveMountedAppId(mountedApps[0]!.name);
  }, [
    activeMountedAppId,
    activeView,
    embeddedMountedAppMode,
    mountedApps,
    pendingMountedAppOpenId,
    storeActiveMountedAppId,
  ]);

  useEffect(() => {
    if (!pendingMountedAppOpenId) return;
    const mounted = mountedApps.find((app) => mountedAppMatchesId(app, pendingMountedAppOpenId));
    if (!mounted) return;
    storeActiveMountedAppId(mounted.name);
    setPendingMountedAppOpenId("");
    setView("app");
  }, [mountedApps, pendingMountedAppOpenId, setView, storeActiveMountedAppId]);

  function selectMountedApp(appId: string) {
    const mounted = mountedApps.find((app) => mountedAppMatchesId(app, appId));
    if (!mounted) {
      setPendingMountedAppOpenId(appId);
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      return;
    }
    setPendingMountedAppOpenId("");
    storeActiveMountedAppId(mounted.name);
    setView("app");
  }

  async function deleteMountedAppTab(appId: string) {
    const app = mountedApps.find((item) => item.name === appId);
    if (!app) return;
    const uninstallChoice = await confirm({
      title: t("confirm.deleteMountedAppTitle", { title: app.title }),
      body: t("confirm.deleteMountedAppWithDraftBody"),
      confirmLabel: t("confirm.deleteMountedAppKeepDraft"),
      alternateLabel: t("confirm.deleteMountedAppAndDraft"),
      alternateDanger: true,
    });
    if (uninstallChoice === null) return;
    const deleteLocalDraft = uninstallChoice === "alternate";
    try {
      let result;
      try {
        result = await uninstallMountedApp({ appId, deleteLocalDraft });
      } catch (error) {
        if (!(error instanceof BridgeRequestError) || error.message !== "app_store_cleanup_confirmation_required") {
          throw error;
        }
        const cleanupConfirmed = await confirm({
          title: t("confirm.trashUnverifiedAppTitle", { title: app.title }),
          body: t("confirm.trashUnverifiedAppBody"),
          confirmLabel: t("common.delete"),
          danger: true,
        });
        if (cleanupConfirmed !== "primary") return;
        result = await uninstallMountedApp({ appId, allowUnverifiedTrash: true, deleteLocalDraft });
      }
      if (!result.ok) {
        showErrorToast(t("shell.mountedAppNotFound", { title: app.title }));
        return;
      }
      if (result.uninstall?.trashError) {
        showErrorToast(t("shell.mountedAppTrashFailed", { title: app.title, error: result.uninstall.trashError }));
      }
      if (result.uninstall?.localDraftDeleteError) {
        showErrorToast(
          t("shell.mountedAppDraftDeleteFailed", {
            title: app.title,
            error: result.uninstall.localDraftDeleteError,
          }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
      if (activeMountedAppId === appId || activeMountedApp?.name === appId) {
        const remaining = (settings?.mountedApps ?? []).filter(
          (item) => item.id !== appId && !(result.uninstall?.removedMountIds ?? []).includes(item.id),
        );
        const nextActiveAppId = remaining[0]?.id ?? "";
        storeActiveMountedAppId(nextActiveAppId);
        if (!nextActiveAppId) setView("chat");
      }
    } catch (error) {
      showErrorToast(
        t("shell.removeMountedAppFailed", {
          title: app.title,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return {
    activeMountedApp,
    deleteMountedAppTab,
    embeddedMountedAppMode,
    mountedApps,
    selectMountedApp,
    unresolvedMountedAppRequestId,
  };
}

function readStoredActiveMountedAppId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(APP_STORAGE_KEYS.activeMountedAppId)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeStoredActiveMountedAppId(appId: string): void {
  if (typeof window === "undefined") return;
  try {
    const normalized = appId.trim();
    if (normalized) {
      window.localStorage.setItem(APP_STORAGE_KEYS.activeMountedAppId, normalized);
    } else {
      window.localStorage.removeItem(APP_STORAGE_KEYS.activeMountedAppId);
    }
  } catch {
    // non-critical-fallback: Losing this optional preference must not block App navigation.
  }
}
