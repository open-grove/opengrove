import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { APP_DESKTOP_API_BASE } from "../src/identity.js";
import type { SupportedLocale } from "../src/localization/locale-registry.js";
import {
  DESKTOP_BRIDGE_STARTUP_STATE_CHANGE_CHANNEL,
  DESKTOP_BRIDGE_STARTUP_STATE_QUERY_CHANNEL,
  isDesktopBridgeStartupState,
  type DesktopBridgeStartupBlockerAction,
  type DesktopBridgeStartupState,
} from "../src/desktop-bridge-startup-state.js";
import {
  DESKTOP_STRIPE_DEEP_LINK_CHANNEL,
  isDesktopStripeDeepLink,
  type DesktopStripeDeepLink,
} from "../src/desktop-stripe-deep-link.js";

type DesktopVersions = {
  app: string;
  clientReleaseNumber?: number;
  electron: string;
  chrome: string;
  node: string;
};

type DesktopHostVersion = {
  packageVersion: string;
  clientReleaseNumber: number | null;
};

type DesktopDiagnostics = {
  status: string;
  pid?: number;
  apiBase?: string;
  port?: number;
  restartCount: number;
  crashCount: number;
  paths: Record<string, string>;
  recentMainLog: string;
  recentBridgeLog: string;
  recentCrashLog: string;
};

type DesktopDiagnosticExportResult =
  | { status: "cancelled" }
  | {
      status: "saved";
      path: string;
      fileName: string;
      sizeBytes: number;
      sha256: string;
      evidenceComplete: boolean;
    };

type DesktopDirectoryPickerResult = { status: "cancelled" } | { status: "selected"; path: string };

type DesktopRebuildableCleanupResult = {
  status: "cleaned";
  reclaimedBytes: number;
  updaterCacheSkipped: boolean;
};

type DesktopStartupTimeoutRecordResult = {
  code: string;
  incidentId: string;
};

type DesktopWindowState = {
  fullscreen: boolean;
};

type DesktopChromeTheme = "light" | "dark";

type DesktopSourceUpdateState = {
  supported: boolean;
  stage: string;
  busy: boolean;
  updateAvailable: boolean;
  message: string;
  details?: string;
  appRoot: string;
  branch?: string;
  remote?: string;
  remoteRef?: string;
  currentRevision?: string;
  latestRevision?: string;
  ahead?: number;
  behind?: number;
  worktreeDirty?: boolean;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
};

type DesktopClientUpdateState = {
  supported: boolean;
  stage: string;
  busy: boolean;
  updateAvailable: boolean;
  downloaded: boolean;
  canAutoInstall: boolean;
  autoDownload: boolean;
  currentVersion: string;
  latestVersion?: string;
  currentReleaseNumber?: number;
  latestReleaseNumber?: number;
  downloadUrl?: string;
  updaterBaseUrl?: string;
  updaterFeedUrl?: string;
  downloadProgress?: number;
  message: string;
  details?: string;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
};

const WINDOW_STATE_CHANNEL = "opengrove:desktop:window-state";
const WINDOW_STATE_QUERY_CHANNEL = "opengrove:desktop:get-window-state";
const WINDOW_CHROME_THEME_CHANNEL = "opengrove:desktop:set-window-chrome-theme";
const SYSTEM_THEME_QUERY_CHANNEL = "opengrove:desktop:get-system-theme";
const SYSTEM_THEME_CHANGE_CHANNEL = "opengrove:desktop:system-theme-change";
const DESKTOP_LANGUAGE_CHANNEL = "opengrove:desktop:set-language";
const SAVED_AUTH_SESSION_QUERY_CHANNEL = "opengrove:desktop:has-saved-auth-session";
const SOURCE_UPDATE_STATE_CHANNEL = "opengrove:desktop:source-update-state";
const CLIENT_UPDATE_STATE_CHANNEL = "opengrove:desktop:client-update-state";
const BRIDGE_STARTUP_RESOLVE_CHANNEL = "opengrove:desktop:resolve-bridge-startup-blocker";
const args = parseArguments(process.argv);
const packageVersion = args["opengrove-app-version"] ?? "";
const clientReleaseNumber = positiveInteger(args["opengrove-client-release-number"]);
let bridgeStartupState = readBridgeStartupState();
const bridgeStartupStateCallbacks = new Set<(state: DesktopBridgeStartupState) => void>();
const stripeDeepLinkCallbacks = new Set<(deepLink: DesktopStripeDeepLink) => void>();
let pendingStripeDeepLink: DesktopStripeDeepLink | undefined;
ipcRenderer.on(DESKTOP_BRIDGE_STARTUP_STATE_CHANGE_CHANNEL, (_event, state: unknown) => {
  if (!isDesktopBridgeStartupState(state)) return;
  bridgeStartupState = state;
  for (const callback of bridgeStartupStateCallbacks) callback(state);
});
ipcRenderer.on(DESKTOP_STRIPE_DEEP_LINK_CHANNEL, (_event, value: unknown) => {
  if (!isDesktopStripeDeepLink(value)) return;
  if (stripeDeepLinkCallbacks.size === 0) {
    pendingStripeDeepLink = value;
    return;
  }
  for (const callback of stripeDeepLinkCallbacks) callback(value);
});
const bridgeApiBase = APP_DESKTOP_API_BASE;

markDesktopDocument();

contextBridge.exposeInMainWorld("openGroveDesktop", {
  apiBase: bridgeApiBase,
  bridgeStartupState,
  getBridgeStartupState: () => bridgeStartupState,
  platform: process.platform,
  isPackaged: args["opengrove-packaged"] === "1",
  isOfficialRelease: args["opengrove-official-release"] === "1",
  versions: {
    app: packageVersion,
    ...(clientReleaseNumber === null ? {} : { clientReleaseNumber }),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  } satisfies DesktopVersions,
  getHostVersion: async () =>
    ({
      packageVersion,
      clientReleaseNumber,
    }) satisfies DesktopHostVersion,
  diagnostics: () => ipcRenderer.invoke("opengrove:desktop:diagnostics") as Promise<DesktopDiagnostics>,
  retryBridgeStartup: () => ipcRenderer.invoke("opengrove:desktop:retry-bridge-startup") as Promise<void>,
  resolveBridgeStartupBlocker: (action: DesktopBridgeStartupBlockerAction) =>
    ipcRenderer.invoke(BRIDGE_STARTUP_RESOLVE_CHANNEL, action) as Promise<void>,
  recordStartupTimeout: () =>
    ipcRenderer.invoke("opengrove:desktop:record-startup-timeout") as Promise<DesktopStartupTimeoutRecordResult>,
  exportDiagnostics: () =>
    ipcRenderer.invoke("opengrove:desktop:export-diagnostics") as Promise<DesktopDiagnosticExportResult>,
  chooseDirectory: () =>
    ipcRenderer.invoke("opengrove:desktop:choose-directory") as Promise<DesktopDirectoryPickerResult>,
  cleanupRebuildableStorage: () =>
    ipcRenderer.invoke("opengrove:desktop:cleanup-rebuildable-storage") as Promise<DesktopRebuildableCleanupResult>,
  restartBridge: () => ipcRenderer.invoke("opengrove:desktop:restart-bridge") as Promise<DesktopDiagnostics>,
  getSourceUpdateState: () =>
    ipcRenderer.invoke("opengrove:desktop:get-source-update-state") as Promise<DesktopSourceUpdateState>,
  checkForSourceUpdate: () =>
    ipcRenderer.invoke("opengrove:desktop:check-source-update") as Promise<DesktopSourceUpdateState>,
  installSourceUpdate: () =>
    ipcRenderer.invoke("opengrove:desktop:install-source-update") as Promise<DesktopSourceUpdateState>,
  getClientUpdateState: () =>
    ipcRenderer.invoke("opengrove:desktop:get-client-update-state") as Promise<DesktopClientUpdateState>,
  checkForClientUpdate: () =>
    ipcRenderer.invoke("opengrove:desktop:check-client-update") as Promise<DesktopClientUpdateState>,
  downloadClientUpdate: () =>
    ipcRenderer.invoke("opengrove:desktop:download-client-update") as Promise<DesktopClientUpdateState>,
  installClientUpdate: () =>
    ipcRenderer.invoke("opengrove:desktop:install-client-update") as Promise<DesktopClientUpdateState>,
  setClientUpdateAutoDownload: (autoDownload: boolean) =>
    ipcRenderer.invoke(
      "opengrove:desktop:set-client-update-auto-download",
      autoDownload,
    ) as Promise<DesktopClientUpdateState>,
  openDataDir: () => ipcRenderer.invoke("opengrove:desktop:open-data-dir") as Promise<void>,
  openLogDir: () => ipcRenderer.invoke("opengrove:desktop:open-log-dir") as Promise<void>,
  resetData: () => ipcRenderer.invoke("opengrove:desktop:reset-data") as Promise<void>,
  hasSavedAuthSession: () => ipcRenderer.invoke(SAVED_AUTH_SESSION_QUERY_CHANNEL) as Promise<boolean>,
  getWindowState: () => ipcRenderer.invoke(WINDOW_STATE_QUERY_CHANNEL) as Promise<DesktopWindowState>,
  getSystemTheme: () => ipcRenderer.invoke(SYSTEM_THEME_QUERY_CHANNEL) as Promise<DesktopChromeTheme>,
  setWindowChromeTheme: (theme: DesktopChromeTheme) =>
    ipcRenderer.invoke(WINDOW_CHROME_THEME_CHANNEL, theme) as Promise<void>,
  setLanguage: (language: SupportedLocale) => ipcRenderer.invoke(DESKTOP_LANGUAGE_CHANNEL, language) as Promise<void>,
  onWindowStateChange: (callback: (state: DesktopWindowState) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (isDesktopWindowState(state)) {
        callback(state);
      }
    };
    ipcRenderer.on(WINDOW_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, listener);
  },
  onSystemThemeChange: (callback: (theme: DesktopChromeTheme) => void) => {
    const listener = (_event: IpcRendererEvent, theme: unknown) => {
      if (theme === "light" || theme === "dark") callback(theme);
    };
    ipcRenderer.on(SYSTEM_THEME_CHANGE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SYSTEM_THEME_CHANGE_CHANNEL, listener);
  },
  onSourceUpdateStateChange: (callback: (state: DesktopSourceUpdateState) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (isDesktopSourceUpdateState(state)) {
        callback(state);
      }
    };
    ipcRenderer.on(SOURCE_UPDATE_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SOURCE_UPDATE_STATE_CHANNEL, listener);
  },
  onClientUpdateStateChange: (callback: (state: DesktopClientUpdateState) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (isDesktopClientUpdateState(state)) {
        callback(state);
      }
    };
    ipcRenderer.on(CLIENT_UPDATE_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CLIENT_UPDATE_STATE_CHANNEL, listener);
  },
  onBridgeStartupStateChange: (callback: (state: DesktopBridgeStartupState) => void) => {
    bridgeStartupStateCallbacks.add(callback);
    if (bridgeStartupState) callback(bridgeStartupState);
    return () => {
      bridgeStartupStateCallbacks.delete(callback);
    };
  },
  onStripeDeepLink: (callback: (deepLink: DesktopStripeDeepLink) => void) => {
    stripeDeepLinkCallbacks.add(callback);
    if (pendingStripeDeepLink) {
      const deepLink = pendingStripeDeepLink;
      pendingStripeDeepLink = undefined;
      callback(deepLink);
    }
    return () => stripeDeepLinkCallbacks.delete(callback);
  },
});

function readBridgeStartupState(): DesktopBridgeStartupState | undefined {
  try {
    const state = ipcRenderer.sendSync(DESKTOP_BRIDGE_STARTUP_STATE_QUERY_CHANNEL) as unknown;
    return isDesktopBridgeStartupState(state) ? state : undefined;
  } catch {
    return undefined;
  }
}

function parseArguments(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const value of argv) {
    if (!value.startsWith("--opengrove-")) continue;
    const separator = value.indexOf("=");
    if (separator <= 2) continue;
    output[value.slice(2, separator)] = value.slice(separator + 1);
  }
  return output;
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return value && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function markDesktopDocument(): void {
  const mark = () => {
    document.documentElement.dataset.opengroveDesktop = "true";
  };
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", mark, { once: true });
  } else {
    mark();
  }
}

function isDesktopWindowState(value: unknown): value is DesktopWindowState {
  return Boolean(
    value && typeof value === "object" && typeof (value as { fullscreen?: unknown }).fullscreen === "boolean",
  );
}

function isDesktopSourceUpdateState(value: unknown): value is DesktopSourceUpdateState {
  const candidate = value as Partial<DesktopSourceUpdateState> | undefined;
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      typeof candidate.supported === "boolean" &&
      typeof candidate.stage === "string" &&
      typeof candidate.busy === "boolean" &&
      typeof candidate.updateAvailable === "boolean" &&
      typeof candidate.message === "string" &&
      typeof candidate.appRoot === "string" &&
      Array.isArray(candidate.log),
  );
}

function isDesktopClientUpdateState(value: unknown): value is DesktopClientUpdateState {
  const candidate = value as Partial<DesktopClientUpdateState> | undefined;
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      typeof candidate.supported === "boolean" &&
      typeof candidate.stage === "string" &&
      typeof candidate.busy === "boolean" &&
      typeof candidate.updateAvailable === "boolean" &&
      typeof candidate.downloaded === "boolean" &&
      typeof candidate.canAutoInstall === "boolean" &&
      typeof candidate.currentVersion === "string" &&
      typeof candidate.message === "string" &&
      Array.isArray(candidate.log),
  );
}
