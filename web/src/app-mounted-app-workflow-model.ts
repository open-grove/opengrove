import type { ExtensionItemRecord } from "./bridge";
import { isMountedWorkbenchApp, mountedAppMatchesId } from "./components/apps/mounted-app-model";

export function resolveMountedApps(inventoryItems: ExtensionItemRecord[]): ExtensionItemRecord[] {
  return inventoryItems.filter(isMountedWorkbenchApp);
}

export function readEmbeddedMountedAppRequest(): { embedded: boolean; appId: string } {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : undefined;
  return {
    embedded: params?.get("embedded") === "app",
    appId: params?.get("app") || "",
  };
}

export function resolveActiveMountedApp(input: {
  activeMountedAppId: string;
  activeView: string;
  embeddedAppId: string;
  embeddedMode: boolean;
  mountedApps: ExtensionItemRecord[];
  pendingMountedAppOpenId: string;
}): ExtensionItemRecord | undefined {
  if (input.embeddedMode) {
    return input.mountedApps.find((app) => mountedAppMatchesId(app, input.embeddedAppId));
  }
  if (input.pendingMountedAppOpenId) {
    return input.mountedApps.find((app) => mountedAppMatchesId(app, input.pendingMountedAppOpenId));
  }
  const matched = input.mountedApps.find((app) => mountedAppMatchesId(app, input.activeMountedAppId));
  if (matched) return matched;
  return input.activeView === "app" ? input.mountedApps[0] : undefined;
}

export type MountedAppHostState = "inactive" | "resolving" | "ready" | "empty" | "missing" | "unavailable";

export function resolveMountedAppHostState(input: {
  activeView: string;
  hasActiveMountedApp: boolean;
  hasUnresolvedMountedAppRequest: boolean;
  inventoryError: boolean;
  inventoryFetching: boolean;
  inventoryPending: boolean;
}): MountedAppHostState {
  if (input.activeView !== "app") return "inactive";
  if (input.hasActiveMountedApp) return "ready";
  if (input.inventoryPending || (input.hasUnresolvedMountedAppRequest && input.inventoryFetching)) {
    return "resolving";
  }
  if (input.inventoryError) return "unavailable";
  return input.hasUnresolvedMountedAppRequest ? "missing" : "empty";
}
