import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeAppStoreRegistryUrl } from "../app-store-package-identity.js";
import {
  DESKTOP_BRIDGE_STARTUP_ACTIVITY_MESSAGE_TYPE,
  type DesktopBridgeStartupActivity,
  type DesktopBridgeStartupActivityMessage,
} from "../desktop-bridge-startup-state.js";
import { APP_DESKTOP_UI_ORIGIN, appEnvName } from "../identity.js";
import { commandVersion } from "../kernel/discovery.js";
import { resolveClaudeCodeCliPath } from "../runtime/claude-code-runtime.js";
import { defaultOpenGroveDataDir } from "../storage/default-data-dir.js";
import { isStateFileLockError } from "../storage/state-file-lock.js";
import { startLocalBridgeServer } from "./local-bridge.js";

export interface DesktopBridgeReadyMessage {
  type: "opengrove.desktop.bridge.ready";
  host: string;
  port: number;
  url: string;
  apiBase: string;
  authMode: "bridge-token" | "session";
  pid: number;
  dataDir: string;
  statePath: string;
  settingsPath: string;
  logDir: string;
}

export interface DesktopBridgeShutdownMessage {
  type: "opengrove.desktop.bridge.shutdown";
}

interface DesktopBridgeClosableServer {
  close(callback: () => void): void;
  closeAllConnections?(): void;
}

interface DesktopBridgeParentLifecycle {
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  exit(): void;
}

interface DesktopBridgeParentLifecycleOptions {
  forceExitAfterMs?: number;
}

const DESKTOP_BRIDGE_PARENT_EXIT_TIMEOUT_MS = 1_000;

export function startDesktopBridgeFromEnv() {
  const dataDir = resolve(envValue("DATA_DIR") ?? defaultOpenGroveDataDir());
  const logDir = resolve(envValue("LOG_DIR") ?? join(dirname(dataDir), "logs"));
  const statePath = resolve(envValue("STATE_PATH") ?? join(dataDir, "local-state.sqlite"));
  const settingsPath = resolve(envValue("BRIDGE_SETTINGS_PATH") ?? join(dataDir, "bridge-settings.json"));
  const programsDir = resolve(envValue("PROGRAMS_DIR") ?? join(dirname(dataDir), "programs"));
  const workspacesDir = resolve(
    envValue("WORKSPACES_DIR") ?? envValue("TARGET_APPS_DIR") ?? join(dirname(dataDir), "workspaces"),
  );
  const legacyAppsDir = resolve(envValue("LEGACY_APPS_DIR") ?? join(dirname(dataDir), "apps"));
  const bridgeToken = envValue("BRIDGE_TOKEN");
  const allowUnauthenticated = envValue("DESKTOP_BRIDGE_ALLOW_UNAUTHENTICATED") === "1";
  const authMode = desktopAuthModeFromEnv();
  validateDesktopDevProfileEnvironment({
    profile: envValue("DESKTOP_DEV_PROFILE"),
    userDataDir: envValue("DESKTOP_DEV_USER_DATA_DIR"),
    dataDir,
    targetAppsDir: workspacesDir,
    programsDir,
    wwBaseUrl: envValue("WW_BASE_URL"),
    appStoreRegistryUrl: envValue("APP_STORE_REGISTRY_URL"),
    releaseControlUrl: envValue("RELEASE_CONTROL_URL"),
    appStoreRegistryToken: envValue("APP_STORE_REGISTRY_TOKEN"),
    legacyAppStoreRegistryUrl: process.env.APP_STORE_REGISTRY_URL?.trim() || undefined,
    legacyAppStoreRegistryToken: process.env.APP_STORE_REGISTRY_TOKEN?.trim() || undefined,
    wwApiKey: envValue("WW_API_KEY"),
    wwAccessToken: envValue("WW_ACCESS_TOKEN"),
  });
  if (!bridgeToken && !allowUnauthenticated) {
    throw new Error("Desktop bridge requires OPENGROVE_BRIDGE_TOKEN.");
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(statePath), { recursive: true });
  mkdirSync(dirname(settingsPath), { recursive: true });
  mkdirSync(programsDir, { recursive: true });
  mkdirSync(workspacesDir, { recursive: true });

  process.env[appEnvName("DATA_DIR")] = dataDir;
  process.env[appEnvName("STATE_PATH")] = statePath;
  process.env[appEnvName("BRIDGE_SETTINGS_PATH")] = settingsPath;
  process.env[appEnvName("PROGRAMS_DIR")] = programsDir;
  process.env[appEnvName("WORKSPACES_DIR")] = workspacesDir;
  process.env[appEnvName("LEGACY_APPS_DIR")] = legacyAppsDir;
  process.env[appEnvName("APP_STORE_APPS_DIR")] = workspacesDir;
  process.env[appEnvName("BRIDGE_HOST")] = "127.0.0.1";
  prewarmClaudeCodeVersion();

  const preferredPort = Number(envValue("BRIDGE_PORT") ?? "0");
  const server = startLocalBridgeServer({
    host: "127.0.0.1",
    port: Number.isFinite(preferredPort) ? preferredPort : 0,
    statePath,
    bridgeToken,
    privateHealthRequiresBridgeToken: true,
    allowedOrigins: [APP_DESKTOP_UI_ORIGIN],
    onStartupActivity(activity) {
      sendDesktopBridgeStartupActivity(activity);
    },
    onListening(info) {
      const ready: DesktopBridgeReadyMessage = {
        type: "opengrove.desktop.bridge.ready",
        host: info.host,
        port: info.port,
        url: info.url,
        apiBase: `${info.url}/api`,
        authMode,
        pid: process.pid,
        dataDir,
        statePath: info.statePath,
        settingsPath,
        logDir,
      };
      if (process.send) {
        process.send(ready);
      }
      process.stdout.write(`${JSON.stringify(ready)}\n`);
    },
  });

  installDesktopBridgeParentLifecycle(server, {
    onMessage(listener) {
      process.on("message", listener);
    },
    onDisconnect(listener) {
      process.once("disconnect", listener);
    },
    exit() {
      process.exit(0);
    },
  });

  return server;
}

function sendDesktopBridgeStartupActivity(activity: DesktopBridgeStartupActivity): void {
  if (!process.send || !process.connected) return;
  const message: DesktopBridgeStartupActivityMessage = {
    type: DESKTOP_BRIDGE_STARTUP_ACTIVITY_MESSAGE_TYPE,
    activity,
  };
  try {
    // Best-effort only: the renderer never acknowledges this message and an
    // unavailable IPC channel must not delay or fail Bridge startup.
    process.send(message, () => undefined);
  } catch {
    // non-critical-fallback: the generic startup copy remains valid when
    // progress reporting is lost.
  }
}

export function validateDesktopDevProfileEnvironment(input: {
  profile?: string;
  userDataDir?: string;
  dataDir: string;
  targetAppsDir: string;
  programsDir?: string;
  wwBaseUrl?: string;
  appStoreRegistryUrl?: string;
  releaseControlUrl?: string;
  appStoreRegistryToken?: string;
  legacyAppStoreRegistryUrl?: string;
  legacyAppStoreRegistryToken?: string;
  wwApiKey?: string;
  wwAccessToken?: string;
}): void {
  if (!input.profile) return;
  if (!input.userDataDir) {
    throw new Error("Desktop Dev profile requires an isolated user data directory.");
  }
  const expectedDataDir = resolve(input.userDataDir, "data");
  const expectedProgramsDir = resolve(input.userDataDir, "programs");
  const expectedWorkspacesDir = resolve(input.userDataDir, "workspaces");
  if (
    resolve(input.dataDir) !== expectedDataDir ||
    resolve(input.targetAppsDir) !== expectedWorkspacesDir ||
    (input.programsDir && resolve(input.programsDir) !== expectedProgramsDir)
  ) {
    throw new Error("Desktop Dev profile paths do not match its isolated user data directory.");
  }
  const wwBaseUrl = normalizeAppStoreRegistryUrl(input.wwBaseUrl ?? "");
  const registryUrl = normalizeAppStoreRegistryUrl(input.appStoreRegistryUrl ?? "");
  const releaseControlUrl = normalizeAppStoreRegistryUrl(input.releaseControlUrl ?? "");
  if (!wwBaseUrl) {
    throw new Error("Desktop Dev profile requires an isolated WW URL.");
  }
  if (!releaseControlUrl || releaseControlUrl === wwBaseUrl) {
    throw new Error("Desktop Dev profile requires an independent Release Control URL.");
  }
  if (!registryUrl || registryUrl !== releaseControlUrl) {
    throw new Error("Desktop Dev profile App Store and Release Control URLs must match.");
  }
  if (input.appStoreRegistryToken || input.wwApiKey || input.wwAccessToken) {
    throw new Error("Desktop Dev profile must not inherit process-scoped WW or App Store credentials.");
  }
  if (input.legacyAppStoreRegistryUrl || input.legacyAppStoreRegistryToken) {
    throw new Error("Desktop Dev profile must not inherit legacy App Store environment aliases.");
  }
}

export function installDesktopBridgeParentLifecycle(
  server: DesktopBridgeClosableServer,
  lifecycle: DesktopBridgeParentLifecycle,
  options: DesktopBridgeParentLifecycleOptions = {},
): void {
  let shuttingDown = false;
  let exited = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    if (forceExitTimer) clearTimeout(forceExitTimer);
    lifecycle.exit();
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExitAfterMs = Math.max(1, options.forceExitAfterMs ?? DESKTOP_BRIDGE_PARENT_EXIT_TIMEOUT_MS);
    forceExitTimer = setTimeout(exitOnce, forceExitAfterMs);
    forceExitTimer.unref?.();
    try {
      server.close(exitOnce);
      if (!exited) server.closeAllConnections?.();
    } catch (error) {
      process.stderr.write(
        `[desktop-bridge] parent shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      server.closeAllConnections?.();
      exitOnce();
    }
  };
  lifecycle.onMessage((message) => {
    if (
      message &&
      typeof message === "object" &&
      (message as DesktopBridgeShutdownMessage).type === "opengrove.desktop.bridge.shutdown"
    ) {
      shutdown();
    }
  });
  // A Desktop-owned Bridge must not outlive a crashed or force-quit parent.
  // Closing on IPC disconnect turns the next launch into the normal dead-lock
  // recovery path instead of leaving a live orphan that blocks the user.
  lifecycle.onDisconnect(shutdown);
}

function envValue(name: string): string | undefined {
  const value = process.env[appEnvName(name)];
  return value && value.trim() ? value.trim() : undefined;
}

function desktopAuthModeFromEnv(): "bridge-token" | "session" {
  const requested = envValue("WEB_AUTH_MODE");
  if (requested === "bridge-token") return "bridge-token";
  if (requested === "session" || Boolean(envValue("WW_BASE_URL"))) return "session";
  return "bridge-token";
}

function prewarmClaudeCodeVersion(): void {
  const timer = setTimeout(() => {
    try {
      commandVersion(resolveClaudeCodeCliPath());
    } catch {
      // non-critical-fallback: Version probing is optional; normal kernel discovery still reports availability.
    }
  }, 0);
  timer.unref?.();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startDesktopBridgeFromEnv();
  } catch (error) {
    if (isStateFileLockError(error)) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
