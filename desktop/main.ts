import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import {
  desktopBridgeBlockerDetails,
  DesktopBridgeSupervisor,
  isDesktopBridgeBlocker,
  type DesktopBridgeDiagnostics,
  type DesktopBridgeRuntimeInfo,
} from "./bridge-supervisor.js";
import { DesktopBridgeStartupRetrySignal, startDesktopBridgeWithRecovery } from "./bridge-startup-recovery.js";
import { DESKTOP_UI_ORIGIN, registerDesktopProtocol, registerDesktopProtocolPrivileges } from "./protocol.js";
import { redactDiagnosticText as redactText } from "../src/diagnostics/redaction.js";
import { recordProblemInDirectory } from "../src/server/problem-records.js";
import { APP_BRIDGE_TOKEN_HEADER, readAppEnv } from "../src/identity.js";
import { hostMessage } from "../src/localization/host-messages.js";
import {
  isSupportedLocale,
  resolveSupportedLocale,
  type SupportedLocale,
} from "../src/localization/locale-registry.js";
import { DesktopAuthCookieJar } from "./auth-cookies.js";
import { DesktopClientUpdateManager, type DesktopClientUpdateState } from "./client-update-manager.js";
import {
  DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES,
  readDesktopClientUpdatePreferences,
  writeDesktopClientUpdatePreferences,
} from "./client-update-preferences.js";
import { defaultDiagnosticBundleFileName, exportDesktopDiagnosticBundle } from "./diagnostic-bundle.js";
import { DesktopSourceUpdateManager, type DesktopSourceUpdateState } from "./source-update-manager.js";
import { registerDesktopDirectoryPickerIpc } from "./directory-picker.js";
import {
  activateBridgeInRetainedMainWindow,
  clearClosedMainWindow,
  focusOrCreateMainWindow,
} from "./main-window-lifecycle.js";
import { DesktopBridgeHostController } from "./bridge-host-controller.js";
import { verifyDesktopBridgeReady } from "./bridge-readiness.js";
import {
  createTrustedDesktopIpcRegistrar,
  createTrustedDesktopSyncIpcRegistrar,
  installDesktopExternalNavigationPolicy,
  installDesktopPermissionPolicy,
  installDesktopProtocolRequestAuthentication,
} from "./security-policy.js";
import {
  DESKTOP_BRIDGE_STARTUP_STATE_CHANGE_CHANNEL,
  DESKTOP_BRIDGE_STARTUP_STATE_QUERY_CHANNEL,
  type DesktopBridgeStartupBlockerAction,
  type DesktopBridgeStartupState,
} from "../src/desktop-bridge-startup-state.js";
import { stopOwnedDesktopBridgeProcesses } from "./bridge-process-control.js";
import { repairDesktopStateAccess } from "./state-access-repair.js";
import { defaultOpenGroveProgramsDir, defaultOpenGroveWorkspacesDir } from "../src/storage/default-data-dir.js";
import {
  DESKTOP_STRIPE_DEEP_LINK_CHANNEL,
  desktopStripeDeepLinkScheme,
  findDesktopStripeDeepLink,
  parseDesktopStripeDeepLink,
  type DesktopStripeDeepLink,
} from "../src/desktop-stripe-deep-link.js";
import { appendBoundedLog } from "./bounded-log.js";
import { cleanupDesktopRebuildableFiles } from "./rebuildable-storage-cleanup.js";

const MAIN_LOG_POLICY = { maxBytes: 10 * 1024 * 1024, retainedFiles: 2 } as const;

type DesktopChannel = "stable" | "dev";

const PRODUCT_NAME = "OpenGrove";
const DESKTOP_CHANNEL: DesktopChannel = app.isPackaged ? "stable" : "dev";
const DESKTOP_STRIPE_DEEP_LINK_SCHEME = desktopStripeDeepLinkScheme(DESKTOP_CHANNEL);
// 开发版使用独立身份，userData 目录和单实例锁都与安装版分离，两者可并存。
const APP_NAME = DESKTOP_CHANNEL === "stable" ? PRODUCT_NAME : `${PRODUCT_NAME} Dev`;
const APP_USER_DATA_DIR_NAME = desktopUserDataDirName(DESKTOP_CHANNEL);
const OFFICIAL_DESKTOP_RELEASE = isOfficialDesktopRelease();
const WINDOW_STATE_CHANNEL = "opengrove:desktop:window-state";
const WINDOW_STATE_QUERY_CHANNEL = "opengrove:desktop:get-window-state";
const WINDOW_CHROME_THEME_CHANNEL = "opengrove:desktop:set-window-chrome-theme";
const SYSTEM_THEME_QUERY_CHANNEL = "opengrove:desktop:get-system-theme";
const SYSTEM_THEME_CHANGE_CHANNEL = "opengrove:desktop:system-theme-change";
const DESKTOP_LANGUAGE_CHANNEL = "opengrove:desktop:set-language";
const SAVED_AUTH_SESSION_QUERY_CHANNEL = "opengrove:desktop:has-saved-auth-session";
const SOURCE_UPDATE_STATE_CHANNEL = "opengrove:desktop:source-update-state";
const CLIENT_UPDATE_STATE_CHANNEL = "opengrove:desktop:client-update-state";
const CLIENT_UPDATE_PREFERENCES_FILE = "client-update-preferences.json";
const BRIDGE_STARTUP_RETRY_CHANNEL = "opengrove:desktop:retry-bridge-startup";
const BRIDGE_STARTUP_RESOLVE_CHANNEL = "opengrove:desktop:resolve-bridge-startup-blocker";
const SOURCE_UPDATE_STARTUP_DELAY_MS = 2_000;
const SOURCE_UPDATE_BACKGROUND_INTERVAL_MS = 30 * 60_000;
const SOURCE_UPDATE_FOCUS_MIN_INTERVAL_MS = 5 * 60_000;
const CLIENT_UPDATE_STARTUP_DELAY_MS = 8_000;
const CLIENT_UPDATE_BACKGROUND_INTERVAL_MS = 6 * 60 * 60_000;
const CLIENT_UPDATE_AUTH_MIN_INTERVAL_MS = 60_000;
const WINDOWS_TITLEBAR_OVERLAY_HEIGHT = 44;
const RELEASE_GATE_READY_RECEIPT = "release-gate-ready.json";

type DesktopChromeTheme = "light" | "dark";
type DesktopLanguage = SupportedLocale;

type DesktopWindowState = {
  fullscreen: boolean;
};

let mainWindow: BrowserWindow | undefined;
let bridgeSupervisor: DesktopBridgeSupervisor | undefined;
const bridgeHost = new DesktopBridgeHostController<DesktopBridgeRuntimeInfo>(broadcastBridgeStartupState);
let bridgeStartupTask: Promise<void> | undefined;
let lastBridgeStartupBlocker:
  | {
      actions: DesktopBridgeStartupBlockerAction[];
      blockingPids: number[];
    }
  | undefined;
let bridgeToken = "";
let desktopProxyToken = "";
let bridgeAuthCookies = new DesktopAuthCookieJar();
let quittingAfterBridgeStop = false;
let mainLogPath: string | undefined;
let reusedWatchdog: NodeJS.Timeout | undefined;
let reusedWatchdogFailures = 0;
let reusedWatchdogChecking = false;
let bridgeSupervisorLifecycleActive = false;
let bridgeSupervisorRecoveryTask: Promise<void> | undefined;
let bridgeSupervisorRetryTimer: NodeJS.Timeout | undefined;
let sourceUpdateManager: DesktopSourceUpdateManager | undefined;
let sourceUpdateStartupTimer: NodeJS.Timeout | undefined;
let sourceUpdatePoller: NodeJS.Timeout | undefined;
let sourceUpdateChecking = false;
let sourceUpdateLastCheckStartedAt = 0;
let clientUpdateManager: DesktopClientUpdateManager | undefined;
let clientUpdateStartupTimer: NodeJS.Timeout | undefined;
let clientUpdatePoller: NodeJS.Timeout | undefined;
let clientUpdateChecking = false;
let clientUpdateLastCheckStartedAt = 0;
let desktopStorageCleanupActive = false;
let desktopStartupTimeoutProblem: { code: string; incidentId: string } | undefined;
let desktopLanguage: DesktopLanguage = "en";
let pendingStripeDeepLink = findDesktopStripeDeepLink(process.argv, DESKTOP_STRIPE_DEEP_LINK_SCHEME);
const bridgeStartupRetrySignal = new DesktopBridgeStartupRetrySignal();
const releaseGateReceiptWindows = new WeakSet<BrowserWindow>();
const releaseGateReceiptListenerWindows = new WeakSet<BrowserWindow>();

app.setName(APP_NAME);
app.setPath("userData", configuredDesktopUserDataDir());
configureApplicationMenu();
installDevelopmentKeychainIsolation();
registerDesktopProtocolPrivileges();
registerDesktopStripeDeepLinkProtocol();

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveDesktopStripeDeepLink(parseDesktopStripeDeepLink(url, DESKTOP_STRIPE_DEEP_LINK_SCHEME));
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    receiveDesktopStripeDeepLink(findDesktopStripeDeepLink(commandLine, DESKTOP_STRIPE_DEEP_LINK_SCHEME));
    mainWindow = focusOrCreateMainWindow(mainWindow, () => createMainWindow());
  });

  app
    .whenReady()
    .then(async () => {
      desktopLanguage = resolveSupportedLocale(app.getLocale());
      bridgeToken = app.isPackaged ? randomBytes(32).toString("base64url") : "";
      desktopProxyToken = randomBytes(32).toString("base64url");
      bridgeAuthCookies = new DesktopAuthCookieJar(join(app.getPath("userData"), "auth-cookies.json"));
      registerDesktopProtocol(join(app.getAppPath(), "web-dist"), () => ({
        bridgeApiBase: bridgeHost.runtime?.apiBase,
        bridgeToken,
        proxyToken: desktopProxyToken,
        mergeCookieHeader: (header) => bridgeAuthCookies.mergeRequestCookieHeader(header),
        applySetCookieHeaders: (headers) => {
          bridgeAuthCookies.applySetCookieHeaders(headers);
          if (headers.length > 0) {
            void checkClientUpdatesIfStale("auth-cookie", CLIENT_UPDATE_AUTH_MIN_INTERVAL_MS);
          }
        },
        mcpAppSandboxOrigin: readAppEnv("MCP_APP_SANDBOX_ORIGIN"),
      }));
      installDesktopProtocolRequestAuthentication(session.defaultSession, () => desktopProxyToken);
      installDesktopPermissionPolicy(session.defaultSession);
      const desktopUserDataDir = app.getPath("userData");
      bridgeSupervisor = new DesktopBridgeSupervisor({
        appRoot: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        userDataDir: desktopUserDataDir,
        programsDir: app.isPackaged ? defaultOpenGroveProgramsDir() : join(desktopUserDataDir, "programs"),
        workspacesDir: app.isPackaged ? defaultOpenGroveWorkspacesDir() : join(desktopUserDataDir, "workspaces"),
        updaterCacheDir: desktopUpdaterCacheDir(),
        token: bridgeToken,
        isPackaged: app.isPackaged,
        channel: DESKTOP_CHANNEL,
        expectedPackageVersion: app.getVersion(),
        allowLegacyHostnameDriftRecovery: isDefaultDesktopUserDataDir(),
        onStatus: handleBridgeSupervisorStatus,
        onStartupActivity: (activity) => {
          if (activity !== "migrating_local_data") return;
          logMain("desktop Bridge is migrating local data");
          bridgeHost.migrating();
        },
        onStateLockRecovered: (recovered) => {
          if (recovered.reason === "dead_holder") {
            logMain(`recovered stale desktop state lock for dead pid ${recovered.holder.pid}: ${recovered.lockPath}`);
          } else {
            logMain(`recovered malformed desktop state lock (${recovered.detail}): ${recovered.lockPath}`);
          }
        },
      });
      mainLogPath = bridgeSupervisor.paths.mainLogPath;
      sourceUpdateManager = new DesktopSourceUpdateManager({
        appRoot: app.getAppPath(),
        enabled: !app.isPackaged,
        restartLogPath: join(bridgeSupervisor.paths.logDir, "desktop-restart.log"),
        log: logMain,
        onStateChange: broadcastSourceUpdateState,
        requestQuit: () => app.quit(),
      });
      registerDesktopIpc();
      nativeTheme.on("updated", broadcastSystemTheme);
      logMain("desktop starting");
      await ensureDesktopBridgeRuntime();
    })
    .catch((error) => {
      logMain(`desktop startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      if (quittingAfterBridgeStop) return;
      if (!mainWindow || mainWindow.isDestroyed()) {
        try {
          mainWindow = createMainWindow();
        } catch (windowError) {
          dialog.showErrorBox(
            `${APP_NAME} startup incomplete`,
            windowError instanceof Error ? windowError.message : String(windowError),
          );
        }
      }
    });
}

function desktopUserDataDirName(channel: DesktopChannel): string {
  if (channel === "stable") {
    return process.platform === "linux" ? "opengrove" : PRODUCT_NAME;
  }
  return process.platform === "linux" ? "opengrove-dev" : `${PRODUCT_NAME}Dev`;
}

function configuredDesktopUserDataDir(): string {
  const devPath = process.env.OPENGROVE_DESKTOP_DEV_USER_DATA_DIR?.trim() ?? "";
  if (!app.isPackaged && devPath) {
    if (!isAbsolute(devPath)) {
      throw new Error("desktop dev userData override must be an absolute path");
    }
    return resolve(devPath);
  }
  const gateEnabled = process.env.OPENGROVE_DESKTOP_RELEASE_GATE === "1";
  const gatePath = process.env.OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR?.trim() ?? "";
  if (!gateEnabled && !gatePath) return join(app.getPath("appData"), APP_USER_DATA_DIR_NAME);
  if (!app.isPackaged || !gateEnabled || !gatePath || !isAbsolute(gatePath)) {
    throw new Error(
      "desktop release gate userData override requires a packaged app, the gate flag, and an absolute path",
    );
  }
  return resolve(gatePath);
}

function isDefaultDesktopUserDataDir(): boolean {
  return resolve(app.getPath("userData")) === resolve(join(app.getPath("appData"), APP_USER_DATA_DIR_NAME));
}

function isOfficialDesktopRelease(): boolean {
  if (!app.isPackaged) return false;
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
      opengroveOfficialRelease?: unknown;
    };
    return metadata.opengroveOfficialRelease === true;
  } catch {
    return false;
  }
}

app.on("before-quit", (event) => {
  cancelBridgeSupervisorRetry();
  if (clientUpdateManager?.isInstalling()) {
    stopReusedWatchdog();
    stopSourceUpdateScheduler();
    stopClientUpdateScheduler();
    return;
  }
  if (!bridgeSupervisor || quittingAfterBridgeStop) {
    return;
  }
  event.preventDefault();
  quittingAfterBridgeStop = true;
  stopReusedWatchdog();
  stopSourceUpdateScheduler();
  stopClientUpdateScheduler();
  logMain(
    bridgeHost.runtime?.mode === "reused"
      ? "desktop quitting; detaching reused bridge"
      : "desktop quitting; stopping bridge",
  );
  void bridgeSupervisor.stop().finally(() => {
    bridgeSupervisor = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
  void checkSourceUpdatesIfStale("app-activate", SOURCE_UPDATE_FOCUS_MIN_INTERVAL_MS);
  void checkClientUpdatesIfStale("app-activate", CLIENT_UPDATE_AUTH_MIN_INTERVAL_MS);
});

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: APP_NAME,
    ...(process.platform !== "darwin"
      ? {
          autoHideMenuBar: true,
        }
      : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 15 },
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: titleBarOverlayOptions("light"),
          }
        : {}),
    webPreferences: {
      preload: join(app.getAppPath(), "desktop-dist", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [
        `--opengrove-app-version=${app.getVersion()}`,
        `--opengrove-client-release-number=${desktopClientReleaseNumber() ?? ""}`,
        `--opengrove-packaged=${app.isPackaged ? "1" : "0"}`,
        `--opengrove-official-release=${OFFICIAL_DESKTOP_RELEASE ? "1" : "0"}`,
      ],
    },
  });
  if (process.platform !== "darwin") {
    window.setMenuBarVisibility(false);
  }
  installDesktopExternalNavigationPolicy(window.webContents, (url) => {
    void shell.openExternal(url);
  });
  installRendererDiagnostics(window);
  installReleaseGateReadyReceipt(window);
  installWindowStateEvents(window);
  window.on("focus", () => {
    void checkSourceUpdatesIfStale("window-focus", SOURCE_UPDATE_FOCUS_MIN_INTERVAL_MS);
    void checkClientUpdatesIfStale("window-focus", CLIENT_UPDATE_AUTH_MIN_INTERVAL_MS);
  });
  window.on("closed", () => {
    mainWindow = clearClosedMainWindow(mainWindow, window);
  });
  void window.loadURL(`${DESKTOP_UI_ORIGIN}/ui/`);
  return window;
}

function installReleaseGateReadyReceipt(window: BrowserWindow): void {
  if (!app.isPackaged || process.env.OPENGROVE_DESKTOP_RELEASE_GATE !== "1") return;
  if (releaseGateReceiptListenerWindows.has(window)) return;
  releaseGateReceiptListenerWindows.add(window);
  window.webContents.on("did-finish-load", () => writeReleaseGateReadyReceipt(window));
  writeReleaseGateReadyReceipt(window);
}

function writeReleaseGateReadyReceipt(window: BrowserWindow): void {
  if (!app.isPackaged || process.env.OPENGROVE_DESKTOP_RELEASE_GATE !== "1") return;
  if (releaseGateReceiptWindows.has(window) || bridgeHost.state.stage !== "ready") return;
  if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  releaseGateReceiptWindows.add(window);
  void window.webContents
    .executeJavaScript(
      `
      (async () => {
        const desktop = window.openGroveDesktop;
        const health = await fetch(\`\${desktop.apiBase}/health\`, { cache: "no-store" });
        return {
          title: document.title,
          desktopMarker: document.documentElement.dataset.opengroveDesktop,
          version: desktop.versions.app,
          healthStatus: health.status,
          health: await health.json(),
        };
      })()
  `,
      true,
    )
    .then((result: unknown) => {
      const receiptPath = join(app.getPath("userData"), RELEASE_GATE_READY_RECEIPT);
      writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      logMain(`desktop release gate ready receipt written: ${receiptPath}`);
    })
    .catch((error: unknown) => {
      releaseGateReceiptWindows.delete(window);
      logMain(
        `desktop release gate ready receipt failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      );
    });
}

function installDevelopmentKeychainIsolation(): void {
  if (process.platform !== "darwin" || app.isPackaged || process.env.OPENGROVE_DEV_REAL_KEYCHAIN === "1") {
    return;
  }
  // The dev app is ad-hoc signed and may be rebuilt locally; using the real
  // macOS keychain makes it repeatedly ask for "OpenGrove Safe Storage".
  app.commandLine.appendSwitch("use-mock-keychain");
}

function configureApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]),
  );
}

function titleBarOverlayOptions(theme: DesktopChromeTheme): Electron.TitleBarOverlayOptions {
  return {
    color: theme === "dark" ? "#171b20" : "#f5f5f7",
    symbolColor: theme === "dark" ? "#f4f6f8" : "#242a31",
    height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
  };
}

function setWindowChromeTheme(window: BrowserWindow, theme: DesktopChromeTheme): void {
  if (process.platform !== "win32" || window.isDestroyed()) return;
  window.setTitleBarOverlay(titleBarOverlayOptions(theme));
}

function installRendererDiagnostics(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    const levelName = consoleLevelName(level);
    logMain(`renderer console ${levelName}: ${singleLine(message)} (${singleLine(sourceId)}:${line})`);
  });
  contents.on("did-fail-load", (_event, errorCodeValue, errorDescription, validatedURL, isMainFrame) => {
    logMain(
      `renderer did-fail-load code=${errorCodeValue} main=${isMainFrame} url=${singleLine(validatedURL)} description=${singleLine(errorDescription)}`,
    );
  });
  contents.on("dom-ready", () => {
    logMain(`renderer dom-ready ${contents.getURL()}`);
  });
  contents.on("did-finish-load", () => {
    logMain(`renderer did-finish-load ${contents.getURL()}`);
    deliverPendingDesktopStripeDeepLink(window);
  });
  contents.on("unresponsive", () => {
    logMain("renderer unresponsive");
  });
  contents.on("responsive", () => {
    logMain("renderer responsive");
  });
  contents.on("render-process-gone", (_event, details) => {
    logMain(`renderer process gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
}

function registerDesktopStripeDeepLinkProtocol(): void {
  const registered =
    process.platform === "win32" && process.defaultApp && process.argv[1]
      ? app.setAsDefaultProtocolClient(DESKTOP_STRIPE_DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])])
      : app.setAsDefaultProtocolClient(DESKTOP_STRIPE_DEEP_LINK_SCHEME);
  if (!registered) {
    console.warn(`Could not register ${DESKTOP_STRIPE_DEEP_LINK_SCHEME} as a desktop URL handler.`);
  }
}

function receiveDesktopStripeDeepLink(deepLink: DesktopStripeDeepLink | null): void {
  if (!deepLink) return;
  pendingStripeDeepLink = deepLink;
  if (!app.isReady()) return;
  const window = focusOrCreateMainWindow(mainWindow, () => createMainWindow());
  mainWindow = window;
  if (!window) return;
  deliverPendingDesktopStripeDeepLink(window);
}

function deliverPendingDesktopStripeDeepLink(window: BrowserWindow): void {
  if (!pendingStripeDeepLink || window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (window.webContents.isLoadingMainFrame()) return;
  const deepLink = pendingStripeDeepLink;
  pendingStripeDeepLink = null;
  window.webContents.send(DESKTOP_STRIPE_DEEP_LINK_CHANNEL, deepLink);
  logMain(`Stripe desktop deep link delivered action=${deepLink.action}`);
}

function registerDesktopIpc(): void {
  const handle = createTrustedDesktopIpcRegistrar(ipcMain);
  const handleSync = createTrustedDesktopSyncIpcRegistrar(ipcMain, (channel, error) => {
    logMain(`rejected untrusted synchronous desktop IPC ${channel}: ${messageOf(error)}`);
  });
  handleSync(DESKTOP_BRIDGE_STARTUP_STATE_QUERY_CHANNEL, () => bridgeHost.state);
  registerDesktopDirectoryPickerIpc({
    handle,
    dialog,
    getParentWindow: () => mainWindow,
    getLanguage: () => desktopLanguage,
  });
  handle("opengrove:desktop:diagnostics", () => diagnostics());
  handle(BRIDGE_STARTUP_RETRY_CHANNEL, () => retryDesktopBridgeStartup());
  handle(BRIDGE_STARTUP_RESOLVE_CHANNEL, async (_event, action: unknown) => {
    if (!isDesktopBridgeStartupBlockerAction(action)) {
      throw new Error("desktop_bridge_blocker_action_invalid");
    }
    const blocker = lastBridgeStartupBlocker;
    if (!blocker || !blocker.actions.includes(action)) {
      throw new Error("desktop_bridge_blocker_action_unavailable");
    }
    if (action === "open_data_dir") {
      await openPathOrThrow(requireBridgeSupervisor().paths.dataDir);
      return;
    }
    if (action === "stop_blocking_process") {
      await stopOwnedDesktopBridgeProcesses(blocker.blockingPids);
    } else if (action === "repair_state_access") {
      repairDesktopStateAccess(requireBridgeSupervisor().paths.userDataDir);
    }
    await retryDesktopBridgeStartup();
  });
  handle("opengrove:desktop:record-startup-timeout", () => {
    if (desktopStartupTimeoutProblem) return desktopStartupTimeoutProblem;
    const problem = recordProblemInDirectory(requireBridgeSupervisor().paths.diagnosticsDir, {
      category: "desktop",
      phase: "startup",
      code: "desktop_startup_timeout",
      error: new Error("desktop_startup_timeout"),
      retryable: true,
    });
    desktopStartupTimeoutProblem = { code: problem.code, incidentId: problem.incidentId };
    logMain(`desktop startup timeout recorded incident=${problem.incidentId}`);
    return desktopStartupTimeoutProblem;
  });
  handle("opengrove:desktop:export-diagnostics", async () => {
    // This IPC path is the emergency fallback for the startup-timeout screen:
    // the Bridge HTTP route may be the component that failed to start. Normal
    // in-app exports use /diagnostics/bundle so both web and desktop share it.
    const options = {
      title: hostMessage(desktopLanguage, "desktop.export_diagnostics"),
      defaultPath: join(app.getPath("downloads"), defaultDiagnosticBundleFileName()),
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return { status: "cancelled" as const };
    try {
      const result = await exportDesktopDiagnosticBundle({
        outputPath: selection.filePath,
        diagnostics: diagnostics(),
        versions: {
          app: app.getVersion(),
          electron: process.versions.electron ?? "",
          chrome: process.versions.chrome ?? "",
          node: process.versions.node ?? "",
        },
        isPackaged: app.isPackaged,
        runDiagnostics: await readBridgeDiagnosticSummary(),
        secrets: [bridgeToken],
      });
      logMain(`diagnostic bundle exported: ${result.fileName} (${result.sizeBytes} bytes)`);
      return result;
    } catch (error) {
      logMain(
        `diagnostic bundle export failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      );
      throw error;
    }
  });
  handle(WINDOW_STATE_QUERY_CHANNEL, (event) => desktopWindowState(BrowserWindow.fromWebContents(event.sender)));
  handle(SYSTEM_THEME_QUERY_CHANNEL, () => desktopSystemTheme());
  handle(SAVED_AUTH_SESSION_QUERY_CHANNEL, () => bridgeAuthCookies.hasSavedSession());
  handle(WINDOW_CHROME_THEME_CHANNEL, (event, theme: unknown) => {
    if (theme !== "light" && theme !== "dark") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) setWindowChromeTheme(window, theme);
  });
  handle(DESKTOP_LANGUAGE_CHANNEL, (_event, language: unknown) => {
    if (!isSupportedLocale(language)) return;
    desktopLanguage = language;
  });
  handle("opengrove:desktop:get-source-update-state", () => requireSourceUpdateManager().snapshot());
  handle("opengrove:desktop:check-source-update", () => requireSourceUpdateManager().checkForUpdates());
  handle("opengrove:desktop:install-source-update", () => requireSourceUpdateManager().installUpdate());
  handle("opengrove:desktop:get-client-update-state", () => requireClientUpdateManager().snapshot());
  handle("opengrove:desktop:check-client-update", () => requireClientUpdateManager().checkForUpdates());
  handle("opengrove:desktop:download-client-update", () => requireClientUpdateManager().downloadUpdate());
  handle("opengrove:desktop:install-client-update", () => requireClientUpdateManager().installUpdate());
  handle("opengrove:desktop:set-client-update-auto-download", async (_event, autoDownload: unknown) => {
    if (typeof autoDownload !== "boolean") throw new Error("invalid_client_update_auto_download");
    const manager = requireClientUpdateManager();
    writeDesktopClientUpdatePreferences(clientUpdatePreferencesPath(), { autoDownload });
    const state = manager.setAutoDownload(autoDownload);
    if (autoDownload && state.stage === "available" && state.updaterBaseUrl) {
      void manager.downloadUpdate().catch((error) => {
        logMain(`automatic client update download failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return manager.snapshot();
  });
  handle("opengrove:desktop:restart-bridge", async () => {
    logMain("bridge restart requested");
    stopReusedWatchdog();
    bridgeHost.starting();
    const bridge = await requireBridgeSupervisor().restart();
    await verifyBridgeRuntime(bridge);
    logMain(`bridge restarted at ${bridge.apiBase}`);
    activateBridgeInMainWindow(bridge);
    startReusedWatchdogIfNeeded();
    void checkClientUpdates("bridge-restart");
    return diagnostics();
  });
  handle("opengrove:desktop:cleanup-rebuildable-storage", () => cleanupDesktopRebuildableStorage());
  handle("opengrove:desktop:open-data-dir", async () => {
    await openPathOrThrow(requireBridgeSupervisor().paths.dataDir);
  });
  handle("opengrove:desktop:open-log-dir", async () => {
    await openPathOrThrow(requireBridgeSupervisor().paths.logDir);
  });
  handle("opengrove:desktop:reset-data", async () => {
    const supervisor = requireBridgeSupervisor();
    logMain("desktop data reset requested");
    stopReusedWatchdog();
    await supervisor.stop();
    const dataDir = supervisor.paths.dataDir;
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    bridgeAuthCookies.clear();
    bridgeHost.starting();
    const bridge = await supervisor.start();
    await verifyBridgeRuntime(bridge);
    logMain(`bridge started after data reset at ${bridge.apiBase}`);
    activateBridgeInMainWindow(bridge);
    startReusedWatchdogIfNeeded();
    void checkClientUpdates("data-reset");
  });
}

async function cleanupDesktopRebuildableStorage() {
  if (desktopStorageCleanupActive) throw new Error("desktop_storage_maintenance_in_progress");
  desktopStorageCleanupActive = true;
  const supervisor = requireBridgeSupervisor();
  let maintenanceLeaseId: string | undefined;
  try {
    if (bridgeHost.runtime?.mode === "reused") throw new Error("rebuildable_cleanup_reused_bridge_unsupported");
    maintenanceLeaseId = await acquireDesktopStorageMaintenanceGate();
    const orphanCleanup = parseDesktopStorageCleanupResponse(
      await postBridgeStorageAction("/settings/storage/cleanup", { leaseId: maintenanceLeaseId }),
    );
    const bridgeCacheCleanup = parseDesktopStorageCleanupResponse(
      await postBridgeStorageAction("/settings/storage/clear-history", {
        scope: "rebuildable-caches",
        leaseId: maintenanceLeaseId,
      }),
    );

    const chromiumCachePaths = [
      "Cache",
      "Code Cache",
      "GPUCache",
      "DawnCache",
      "DawnWebGPUCache",
      "DawnGraphiteCache",
    ].map((name) => join(supervisor.paths.userDataDir, name));
    const updaterStage = clientUpdateManager?.snapshot().stage;
    const updaterCacheDir =
      updaterStage === "downloading" || updaterStage === "downloaded" || updaterStage === "installing"
        ? undefined
        : supervisor.updaterCacheDirectory();

    stopReusedWatchdog();
    bridgeSupervisorLifecycleActive = false;
    bridgeHost.maintenance("storage_cleanup");
    await supervisor.stop();
    const files = await cleanupDesktopRebuildableFiles({
      // Workspace media caches are removed by the Bridge while it still has
      // the authoritative mounted-workspace list. Desktop must not guess from
      // a broad Apps or Workspaces directory.
      workspaceRoots: [],
      logDir: supervisor.paths.logDir,
      chromiumCacheDirs: chromiumCachePaths,
      updaterCacheDir,
    });
    await session.defaultSession.clearCache();
    const bridge = await supervisor.start({ allowReuse: false });
    await verifyBridgeRuntime(bridge);
    activateBridgeInMainWindow(bridge);
    startReusedWatchdogIfNeeded();
    const orphanBlobBytes = orphanCleanup.reclaimedBytes;
    const bridgeCacheBytes = bridgeCacheCleanup.reclaimedBytes;
    const reclaimedBytes = orphanBlobBytes + bridgeCacheBytes + files.reclaimedBytes;
    logMain(`safe storage cleanup completed (${reclaimedBytes} logical bytes removed)`);
    return {
      status: "cleaned" as const,
      orphanBlobBytes,
      bridgeCacheBytes,
      ...files,
      reclaimedBytes,
      updaterCacheSkipped: Boolean(supervisor.updaterCacheDirectory() && !updaterCacheDir),
    };
  } catch (error) {
    if (supervisor.diagnostics().status !== "running") {
      try {
        const bridge = await supervisor.start({ allowReuse: false });
        await verifyBridgeRuntime(bridge);
        activateBridgeInMainWindow(bridge);
        startReusedWatchdogIfNeeded();
      } catch (restartError) {
        bridgeSupervisorLifecycleActive = true;
        throw new Error(`rebuildable_cleanup_and_restart_failed:${messageOf(error)}:${messageOf(restartError)}`);
      }
    } else if (maintenanceLeaseId) {
      await releaseDesktopStorageMaintenanceGate(maintenanceLeaseId);
      if (bridgeHost.runtime) bridgeHost.activate(bridgeHost.runtime);
    }
    throw error;
  } finally {
    desktopStorageCleanupActive = false;
  }
}

async function postBridgeStorageAction(path: string, body: unknown): Promise<unknown> {
  const bridge = bridgeHost.runtime;
  if (!bridge) throw new Error("desktop_bridge_unavailable");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bridgeToken) headers[APP_BRIDGE_TOKEN_HEADER] = bridgeToken;
  const cookies = bridgeAuthCookies.mergeRequestCookieHeader(undefined);
  if (cookies) headers.cookie = cookies;
  const response = await fetch(`${bridge.apiBase}${path}`, {
    method: "POST",
    cache: "no-store",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `desktop_storage_action_failed:http_${response.status}`,
    );
  }
  return payload;
}

async function acquireDesktopStorageMaintenanceGate(): Promise<string> {
  return parseDesktopStorageMaintenanceStartResponse(
    await postBridgeStorageAction("/settings/storage/maintenance/start", {}),
  ).leaseId;
}

async function releaseDesktopStorageMaintenanceGate(leaseId: string): Promise<void> {
  try {
    parseDesktopStorageOkResponse(
      await postBridgeStorageAction("/settings/storage/maintenance/end", { leaseId }),
      "desktop_storage_maintenance_end_response_invalid",
    );
  } catch (error) {
    logMain(`storage maintenance gate release failed: ${messageOf(error)}`);
  }
}

function parseDesktopStorageMaintenanceStartResponse(value: unknown): { leaseId: string } {
  const response = desktopStorageResponseRecord(value, "desktop_storage_maintenance_start_response_invalid");
  if (response.ok !== true || typeof response.leaseId !== "string" || !response.leaseId) {
    throw new Error("desktop_storage_maintenance_start_response_invalid");
  }
  return { leaseId: response.leaseId };
}

function parseDesktopStorageCleanupResponse(value: unknown): { reclaimedBytes: number } {
  const response = desktopStorageResponseRecord(value, "desktop_storage_cleanup_response_invalid");
  const cleanup = desktopStorageResponseRecord(response.cleanup, "desktop_storage_cleanup_response_invalid");
  if (
    response.ok !== true ||
    typeof cleanup.reclaimedBytes !== "number" ||
    !Number.isFinite(cleanup.reclaimedBytes) ||
    cleanup.reclaimedBytes < 0
  ) {
    throw new Error("desktop_storage_cleanup_response_invalid");
  }
  return { reclaimedBytes: cleanup.reclaimedBytes };
}

function parseDesktopStorageOkResponse(value: unknown, errorCode: string): void {
  if (desktopStorageResponseRecord(value, errorCode).ok !== true) throw new Error(errorCode);
}

function desktopStorageResponseRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

async function readBridgeDiagnosticSummary(): Promise<unknown> {
  const bridge = bridgeHost.runtime;
  if (!bridge) return { unavailable: true, reason: "bridge_not_running" };
  const headers: Record<string, string> = {};
  if (bridgeToken) headers[APP_BRIDGE_TOKEN_HEADER] = bridgeToken;
  const cookies = bridgeAuthCookies.mergeRequestCookieHeader(undefined);
  if (cookies) headers.cookie = cookies;
  try {
    const response = await fetch(`${bridge.apiBase}/diagnostics/summary`, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return { unavailable: true, reason: `http_${response.status}` };
    return await response.json();
  } catch (error) {
    return { unavailable: true, reason: error instanceof Error ? error.name : "request_failed" };
  }
}

function installWindowStateEvents(window: BrowserWindow): void {
  const send = () => sendWindowState(window);
  window.on("enter-full-screen", send);
  window.on("leave-full-screen", send);
  window.webContents.on("did-finish-load", send);
}

function sendWindowState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  window.webContents.send(WINDOW_STATE_CHANNEL, desktopWindowState(window));
}

function broadcastSourceUpdateState(state: DesktopSourceUpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(SOURCE_UPDATE_STATE_CHANNEL, state);
  }
}

function broadcastClientUpdateState(state: DesktopClientUpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(CLIENT_UPDATE_STATE_CHANNEL, state);
  }
}

function broadcastSystemTheme(): void {
  const theme = desktopSystemTheme();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(SYSTEM_THEME_CHANGE_CHANNEL, theme);
  }
}

function desktopSystemTheme(): DesktopChromeTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function desktopWindowState(window: BrowserWindow | null | undefined): DesktopWindowState {
  return {
    fullscreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
  };
}

function ensureDesktopBridgeRuntime(): Promise<void> {
  if (bridgeHost.runtime) return Promise.resolve();
  if (bridgeStartupTask) return bridgeStartupTask;
  bridgeStartupTask = startAndActivateDesktopBridge().finally(() => {
    bridgeStartupTask = undefined;
  });
  return bridgeStartupTask;
}

async function startAndActivateDesktopBridge(): Promise<void> {
  const bridge = await startBridgeWithAutomaticRecovery();
  logMain(`bridge started at ${bridge.apiBase}`);
  if (!clientUpdateManager) {
    clientUpdateManager = new DesktopClientUpdateManager({
      enabled: app.isPackaged,
      currentVersion: app.getVersion(),
      autoDownload: loadClientUpdatePreferences().autoDownload,
      bridgeToken,
      getApiBase: () => bridgeHost.runtime?.apiBase,
      getCookieHeader: () => bridgeAuthCookies.mergeRequestCookieHeader(undefined),
      applySetCookieHeaders: (headers) => bridgeAuthCookies.applySetCookieHeaders(headers),
      prepareForInstall: prepareForClientUpdateInstall,
      log: logMain,
      onStateChange: broadcastClientUpdateState,
    });
  }
  activateBridgeInMainWindow(bridge);
  startReusedWatchdogIfNeeded();
  startSourceUpdateScheduler();
  startClientUpdateScheduler();
}

async function startBridgeWithAutomaticRecovery(): Promise<DesktopBridgeRuntimeInfo> {
  const supervisor = requireBridgeSupervisor();
  return startDesktopBridgeWithRecovery({
    beforeFirstAttempt: () => {
      bridgeHost.starting(1);
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow();
      }
    },
    start: async () => {
      const bridge = await supervisor.start();
      await verifyBridgeRuntime(bridge);
      return bridge;
    },
    isStopping: () => quittingAfterBridgeStop,
    isBlocker: isDesktopBridgeBlocker,
    onBlocked: ({ attempt, error }) => {
      const code = errorCodeOf(error);
      const message = messageOf(error);
      const blocker = desktopBridgeBlockerDetails(error);
      lastBridgeStartupBlocker = blocker;
      bridgeHost.blocked({ attempt, code, message, actions: blocker.actions });
      logMain(`desktop bridge startup blocked code=${code}: ${message}`);
    },
    onFailure: ({ attempt, delayMs, error }) => {
      const message = messageOf(error);
      bridgeHost.retrying({ attempt, retryInMs: delayMs, message });
      logMain(`desktop bridge startup attempt ${attempt} failed; retrying in ${delayMs}ms: ${message}`);
    },
    waitForRetry: (delayMs) => bridgeStartupRetrySignal.wait(delayMs),
  });
}

async function verifyBridgeRuntime(bridge: DesktopBridgeRuntimeInfo): Promise<void> {
  await verifyDesktopBridgeReady({
    apiBase: bridge.apiBase,
    bridgeToken,
    cookieHeader: bridgeAuthCookies.mergeRequestCookieHeader(undefined),
  });
}

function handleBridgeSupervisorStatus(diagnostics: DesktopBridgeDiagnostics): void {
  if (!bridgeSupervisorLifecycleActive || quittingAfterBridgeStop) return;

  if (diagnostics.status === "restarting") {
    if (bridgeHost.runtime) {
      bridgeHost.retrying({
        attempt: Math.max(1, diagnostics.restartCount),
        retryInMs: 1_000,
        message: "The local Bridge stopped. OpenGrove is restoring it.",
      });
    }
    return;
  }

  if (diagnostics.status === "failed") {
    bridgeHost.retrying({
      attempt: Math.max(1, diagnostics.restartCount + 1),
      retryInMs: 1_000,
      message: "The local Bridge could not be restored yet. OpenGrove will retry.",
    });
    scheduleBridgeSupervisorRetry();
    return;
  }

  if (diagnostics.status !== "running") return;
  if (bridgeSupervisorRetryTimer) {
    clearTimeout(bridgeSupervisorRetryTimer);
    bridgeSupervisorRetryTimer = undefined;
  }
  const runtime = bridgeSupervisor?.currentRuntime();
  if (!runtime || sameBridgeRuntime(bridgeHost.runtime, runtime) || bridgeSupervisorRecoveryTask) return;
  bridgeSupervisorRecoveryTask = (async () => {
    await verifyBridgeRuntime(runtime);
    activateBridgeInMainWindow(runtime);
    startReusedWatchdogIfNeeded();
    void checkClientUpdates("bridge-auto-recovered");
  })()
    .catch((error) => {
      const message = messageOf(error);
      bridgeHost.retrying({
        attempt: Math.max(1, diagnostics.restartCount + 1),
        retryInMs: 1_000,
        message,
      });
      logMain(`automatic Bridge readiness verification failed: ${message}`);
      scheduleBridgeSupervisorRetry();
    })
    .finally(() => {
      bridgeSupervisorRecoveryTask = undefined;
    });
}

function scheduleBridgeSupervisorRetry(): void {
  if (bridgeSupervisorRetryTimer || quittingAfterBridgeStop) return;
  bridgeSupervisorRetryTimer = setTimeout(() => {
    bridgeSupervisorRetryTimer = undefined;
    void ensureDesktopBridgeRuntime().catch((error) => {
      logMain(`automatic Bridge recovery retry failed: ${messageOf(error)}`);
    });
  }, 1_000);
  bridgeSupervisorRetryTimer.unref();
}

function cancelBridgeSupervisorRetry(): void {
  if (!bridgeSupervisorRetryTimer) return;
  clearTimeout(bridgeSupervisorRetryTimer);
  bridgeSupervisorRetryTimer = undefined;
}

function sameBridgeRuntime(left: DesktopBridgeRuntimeInfo | undefined, right: DesktopBridgeRuntimeInfo): boolean {
  return Boolean(left && left.pid === right.pid && left.apiBase === right.apiBase);
}

function startSourceUpdateScheduler(): void {
  stopSourceUpdateScheduler();
  sourceUpdateStartupTimer = setTimeout(() => {
    void checkSourceUpdates("startup");
  }, SOURCE_UPDATE_STARTUP_DELAY_MS);
  sourceUpdatePoller = setInterval(() => {
    void checkSourceUpdates("background");
  }, SOURCE_UPDATE_BACKGROUND_INTERVAL_MS);
}

function stopSourceUpdateScheduler(): void {
  if (sourceUpdateStartupTimer) {
    clearTimeout(sourceUpdateStartupTimer);
    sourceUpdateStartupTimer = undefined;
  }
  if (sourceUpdatePoller) {
    clearInterval(sourceUpdatePoller);
    sourceUpdatePoller = undefined;
  }
  sourceUpdateChecking = false;
}

function startClientUpdateScheduler(): void {
  stopClientUpdateScheduler();
  if (!clientUpdateManager?.snapshot().supported) return;
  clientUpdateStartupTimer = setTimeout(() => {
    clientUpdateStartupTimer = undefined;
    void checkClientUpdates("startup");
  }, CLIENT_UPDATE_STARTUP_DELAY_MS);
  clientUpdatePoller = setInterval(() => {
    void checkClientUpdatesIfStale("background", CLIENT_UPDATE_BACKGROUND_INTERVAL_MS);
  }, CLIENT_UPDATE_BACKGROUND_INTERVAL_MS);
}

function stopClientUpdateScheduler(): void {
  if (clientUpdateStartupTimer) {
    clearTimeout(clientUpdateStartupTimer);
    clientUpdateStartupTimer = undefined;
  }
  if (clientUpdatePoller) {
    clearInterval(clientUpdatePoller);
    clientUpdatePoller = undefined;
  }
  clientUpdateChecking = false;
}

async function checkClientUpdatesIfStale(reason: string, minIntervalMs: number): Promise<void> {
  if (Date.now() - clientUpdateLastCheckStartedAt < minIntervalMs) return;
  await checkClientUpdates(reason);
}

async function checkClientUpdates(reason: string): Promise<void> {
  if (!clientUpdateManager || clientUpdateChecking) return;
  const state = clientUpdateManager.snapshot();
  if (!state.supported || state.stage === "installing" || state.stage === "downloaded" || state.stage === "downloading")
    return;
  clientUpdateChecking = true;
  clientUpdateLastCheckStartedAt = Date.now();
  logMain(`client update scheduled check: ${reason}`);
  try {
    await clientUpdateManager.checkForUpdates();
  } catch (error) {
    logMain(
      `client update scheduled check failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    clientUpdateChecking = false;
  }
}

async function checkSourceUpdatesIfStale(reason: string, minIntervalMs: number): Promise<void> {
  if (Date.now() - sourceUpdateLastCheckStartedAt < minIntervalMs) return;
  await checkSourceUpdates(reason);
}

async function checkSourceUpdates(reason: string): Promise<void> {
  if (!sourceUpdateManager || sourceUpdateChecking) return;
  const state = sourceUpdateManager.snapshot();
  if (!state.supported || state.stage === "updating" || state.stage === "restarting") return;
  sourceUpdateChecking = true;
  sourceUpdateLastCheckStartedAt = Date.now();
  logMain(`source update scheduled check: ${reason}`);
  try {
    await sourceUpdateManager.checkForUpdates();
  } catch (error) {
    logMain(
      `source update scheduled check failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    sourceUpdateChecking = false;
  }
}

async function prepareForClientUpdateInstall(): Promise<void> {
  stopReusedWatchdog();
  stopSourceUpdateScheduler();
  stopClientUpdateScheduler();

  const supervisor = bridgeSupervisor;
  if (!supervisor) return;
  if (bridgeHost.runtime?.mode === "reused") {
    throw new Error("当前正在复用外部 OpenGrove bridge。请完全退出 OpenGrove 后重新打开，再安装更新。");
  }

  logMain("client update install requested; stopping owned bridge before quitAndInstall");
  await supervisor.stop();
  bridgeSupervisor = undefined;
  bridgeHost.detach();
}

function startReusedWatchdogIfNeeded(): void {
  if (bridgeHost.runtime?.mode !== "reused") {
    stopReusedWatchdog();
    return;
  }
  if (reusedWatchdog) {
    return;
  }
  reusedWatchdogFailures = 0;
  reusedWatchdog = setInterval(() => {
    void checkReusedBridge();
  }, 4_000);
  logMain("reused bridge watchdog started");
}

function stopReusedWatchdog(): void {
  if (reusedWatchdog) {
    clearInterval(reusedWatchdog);
    reusedWatchdog = undefined;
  }
  reusedWatchdogFailures = 0;
  reusedWatchdogChecking = false;
}

async function checkReusedBridge(): Promise<void> {
  if (reusedWatchdogChecking || bridgeHost.runtime?.mode !== "reused") {
    return;
  }
  reusedWatchdogChecking = true;
  try {
    const healthy = await requireBridgeSupervisor().isReusableExternalBridgeHealthy();
    if (healthy) {
      reusedWatchdogFailures = 0;
      return;
    }
    reusedWatchdogFailures += 1;
    logMain(`reused bridge watchdog miss ${reusedWatchdogFailures}`);
    if (reusedWatchdogFailures < 2) {
      return;
    }
    stopReusedWatchdog();
    const supervisor = requireBridgeSupervisor();
    await supervisor.stop();
    bridgeHost.retrying({
      attempt: 1,
      retryInMs: 0,
      message: "The reused Bridge disconnected. OpenGrove is starting a replacement.",
    });
    const bridge = await supervisor.start({ allowReuse: false });
    await verifyBridgeRuntime(bridge);
    logMain(`reused bridge recovered by starting owned bridge at ${bridge.apiBase}`);
    activateBridgeInMainWindow(bridge);
    void checkClientUpdates("bridge-recovered");
  } catch (error) {
    logMain(
      `reused bridge watchdog recovery failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    startReusedWatchdogIfNeeded();
    reusedWatchdogChecking = false;
  }
}

function activateBridgeInMainWindow(bridge: DesktopBridgeRuntimeInfo): void {
  lastBridgeStartupBlocker = undefined;
  bridgeSupervisorLifecycleActive = true;
  activateBridgeInRetainedMainWindow(() => bridgeHost.activate(bridge));
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  installReleaseGateReadyReceipt(mainWindow);
}

function broadcastBridgeStartupState(state: DesktopBridgeStartupState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(DESKTOP_BRIDGE_STARTUP_STATE_CHANGE_CHANNEL, state);
    if (state.stage === "ready") writeReleaseGateReadyReceipt(window);
  }
}

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "DESKTOP_BRIDGE_BLOCKED";
  return String((error as { code?: unknown }).code || "DESKTOP_BRIDGE_BLOCKED");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function retryDesktopBridgeStartup(): Promise<void> {
  bridgeStartupRetrySignal.retryNow();
  if (bridgeHost.state.stage !== "blocked" || bridgeHost.runtime) return;
  bridgeHost.starting(1);
  try {
    await ensureDesktopBridgeRuntime();
  } catch (error) {
    logMain(`desktop bridge retry failed: ${messageOf(error)}`);
  }
}

function isDesktopBridgeStartupBlockerAction(value: unknown): value is DesktopBridgeStartupBlockerAction {
  return (
    value === "stop_blocking_process" ||
    value === "repair_state_access" ||
    value === "open_data_dir" ||
    value === "retry"
  );
}

function diagnostics(): DesktopBridgeDiagnostics {
  return requireBridgeSupervisor().diagnostics();
}

function requireBridgeSupervisor(): DesktopBridgeSupervisor {
  if (!bridgeSupervisor) {
    throw new Error("desktop_bridge_not_started");
  }
  return bridgeSupervisor;
}

function requireSourceUpdateManager(): DesktopSourceUpdateManager {
  if (!sourceUpdateManager) {
    throw new Error("desktop_source_update_not_started");
  }
  return sourceUpdateManager;
}

function requireClientUpdateManager(): DesktopClientUpdateManager {
  if (!clientUpdateManager) {
    throw new Error("desktop_client_update_not_started");
  }
  return clientUpdateManager;
}

function clientUpdatePreferencesPath(): string {
  return join(app.getPath("userData"), CLIENT_UPDATE_PREFERENCES_FILE);
}

function loadClientUpdatePreferences() {
  try {
    return readDesktopClientUpdatePreferences(clientUpdatePreferencesPath());
  } catch (error) {
    logMain(`client update preferences read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ...DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES };
  }
}

async function openPathOrThrow(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) {
    throw new Error(error);
  }
}

function desktopClientReleaseNumber(): number | null {
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
      clientReleaseNumber?: unknown;
    };
    return typeof metadata.clientReleaseNumber === "number" &&
      Number.isSafeInteger(metadata.clientReleaseNumber) &&
      metadata.clientReleaseNumber > 0
      ? metadata.clientReleaseNumber
      : null;
  } catch {
    return null;
  }
}

function consoleLevelName(level: number): string {
  if (level === 0) return "verbose";
  if (level === 1) return "info";
  if (level === 2) return "warning";
  if (level === 3) return "error";
  return String(level);
}

function singleLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

function logMain(message: string): void {
  if (!mainLogPath) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendBoundedLog(mainLogPath, redactText(line, [bridgeToken]), MAIN_LOG_POLICY);
  } catch (error) {
    // Logging must never block startup or bridge recovery.
    console.warn("desktop_main_log_write_failed", {
      path: mainLogPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function desktopUpdaterCacheDir(): string {
  const home = homedir();
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(home, "AppData", "Local")
      : process.platform === "darwin"
        ? join(home, "Library", "Caches")
        : process.env.XDG_CACHE_HOME || join(home, ".cache");
  // electron-builder writes this exact directory name to app-update.yml.
  return join(base, "opengrove-updater");
}
