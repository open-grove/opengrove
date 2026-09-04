import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DEFAULT_RELEASE_CONTROL_URL, APP_DEFAULT_WW_BASE_URL, APP_DESKTOP_UI_ORIGIN } from "../src/identity.js";
import {
  isDesktopBridgeStartupActivityMessage,
  type DesktopBridgeStartupActivity,
  type DesktopBridgeStartupBlockerAction,
} from "../src/desktop-bridge-startup-state.js";
import { SQLITE_STATE_FILE_NAME } from "../src/storage/default-data-dir.js";
import { stateIdFor } from "../src/storage/state-identity.js";
import { resolveDesktopEnvironment } from "./shell-env.js";
import { redactDiagnosticText as redactText } from "../src/diagnostics/redaction.js";
import { BoundedLogWriter } from "./bounded-log.js";
import {
  recoverStaleDesktopStateLocks,
  type DesktopStateLockBlocker,
  type DesktopStateLockRecoveryResult,
  type RecoveredDesktopStateLock,
} from "./state-lock-recovery.js";
import { desktopBridgeListenerProcessIds, ownedDesktopBridgeProcessIds } from "./bridge-process-control.js";

const BRIDGE_LOG_POLICY = { maxBytes: 10 * 1024 * 1024, retainedFiles: 2 } as const;

export type BridgeProcessStatus = "stopped" | "starting" | "running" | "restarting" | "failed";

export interface DesktopBridgePaths {
  userDataDir: string;
  dataDir: string;
  programsDir: string;
  workspacesDir: string;
  logDir: string;
  cacheDir: string;
  diagnosticsDir: string;
  statePath: string;
  settingsPath: string;
  mainLogPath: string;
  bridgeLogPath: string;
  bridgeCrashLogPath: string;
}

export interface DesktopBridgeRuntimeInfo {
  status: BridgeProcessStatus;
  mode: "owned" | "reused";
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

export interface DesktopBridgeDiagnostics {
  status: BridgeProcessStatus;
  pid?: number;
  apiBase?: string;
  port?: number;
  mode?: "owned" | "reused";
  restartCount: number;
  crashCount: number;
  paths: DesktopBridgePaths;
  recentBridgeLog: string;
  recentCrashLog: string;
  recentMainLog: string;
}

interface DesktopBridgeSupervisorOptions {
  appRoot: string;
  resourcesPath: string;
  userDataDir: string;
  programsDir?: string;
  workspacesDir?: string;
  updaterCacheDir?: string;
  token: string;
  isPackaged: boolean;
  channel: "stable" | "dev";
  expectedPackageVersion?: string;
  allowLegacyHostnameDriftRecovery?: boolean;
  onStatus?(diagnostics: DesktopBridgeDiagnostics): void;
  onStartupActivity?(activity: DesktopBridgeStartupActivity): void;
  onStateLockRecovered?(recovered: RecoveredDesktopStateLock): void;
  recoverStateLocks?(userDataDir: string): DesktopStateLockRecoveryResult;
}

export interface DesktopBridgeStartOptions {
  allowReuse?: boolean;
}

interface DesktopBridgeReadyMessage {
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

interface BridgeProbeResponse {
  ok?: boolean;
  product?: string;
  name?: string;
  profile?: string;
  authMode?: "bridge-token" | "session";
  requiresToken?: boolean;
  stateId?: string | null;
  pid?: number;
  startedAt?: string;
  build?: {
    packageVersion?: string | null;
    gitSha?: string | null;
    modules?: Record<string, { mtime: string; mtimeMs: number; size: number } | null>;
  };
}

type BridgeReuseDecision =
  | { action: "reuse"; probe: BridgeProbeResponse }
  | { action: "spawn"; reason: string }
  | {
      action: "blocked";
      code: BridgeBlockerCode;
      message: string;
      actions: DesktopBridgeStartupBlockerAction[];
      blockingPids: number[];
    };

export type BridgeBlockerCode =
  | "LEGACY_BRIDGE_RUNNING"
  | "PROTECTED_BRIDGE_RUNNING"
  | "STALE_BRIDGE_RUNNING"
  | "LOCAL_STATE_LOCKED";

interface DesktopBridgeBlockerError extends Error {
  code: BridgeBlockerCode;
  actions: DesktopBridgeStartupBlockerAction[];
  blockingPids: number[];
}

export class DesktopBridgeSupervisor {
  readonly paths: DesktopBridgePaths;
  private readonly appRoot: string;
  private readonly resourcesPath: string;
  private readonly token: string;
  private readonly isPackaged: boolean;
  private readonly channel: DesktopBridgeSupervisorOptions["channel"];
  private readonly expectedPackageVersion: string | undefined;
  private readonly updaterCacheDir: string | undefined;
  private readonly onStatus?: DesktopBridgeSupervisorOptions["onStatus"];
  private readonly onStartupActivity?: DesktopBridgeSupervisorOptions["onStartupActivity"];
  private readonly onStateLockRecovered?: DesktopBridgeSupervisorOptions["onStateLockRecovered"];
  private readonly recoverStateLocks: NonNullable<DesktopBridgeSupervisorOptions["recoverStateLocks"]>;
  private child?: ChildProcess;
  private runtimeInfo?: DesktopBridgeRuntimeInfo;
  private status: BridgeProcessStatus = "stopped";
  private restartCount = 0;
  private crashCount = 0;
  private consecutiveCrashRestarts = 0;
  private preferredPort = 0;
  private stopping = false;
  private startPromise?: Promise<DesktopBridgeRuntimeInfo>;
  private bridgeLogWriter: BoundedLogWriter;
  private bridgeCrashLogWriter: BoundedLogWriter;

  constructor(options: DesktopBridgeSupervisorOptions) {
    this.appRoot = options.appRoot;
    this.resourcesPath = options.resourcesPath;
    this.token = options.token;
    this.isPackaged = options.isPackaged;
    this.channel = options.channel;
    this.expectedPackageVersion = options.expectedPackageVersion?.trim() || undefined;
    this.updaterCacheDir = options.updaterCacheDir?.trim() || undefined;
    this.onStatus = options.onStatus;
    this.onStartupActivity = options.onStartupActivity;
    this.onStateLockRecovered = options.onStateLockRecovered;
    this.recoverStateLocks =
      options.recoverStateLocks ??
      ((userDataDir) =>
        recoverStaleDesktopStateLocks(userDataDir, {
          allowLegacyHostnameDriftRecovery: options.allowLegacyHostnameDriftRecovery === true,
        }));
    this.paths = createBridgePaths(options.userDataDir, {
      programsDir: options.programsDir,
      workspacesDir: options.workspacesDir,
    });
    mkdirSync(this.paths.dataDir, { recursive: true });
    mkdirSync(this.paths.programsDir, { recursive: true });
    mkdirSync(this.paths.workspacesDir, { recursive: true });
    mkdirSync(this.paths.logDir, { recursive: true });
    mkdirSync(this.paths.cacheDir, { recursive: true });
    mkdirSync(this.paths.diagnosticsDir, { recursive: true });
    this.bridgeLogWriter = new BoundedLogWriter(this.paths.bridgeLogPath, BRIDGE_LOG_POLICY, (error) =>
      this.warnBridgeLogWriteFailed(this.paths.bridgeLogPath, error),
    );
    this.bridgeCrashLogWriter = new BoundedLogWriter(this.paths.bridgeCrashLogPath, BRIDGE_LOG_POLICY, (error) =>
      this.warnBridgeLogWriteFailed(this.paths.bridgeCrashLogPath, error),
    );
  }

  async start(options: DesktopBridgeStartOptions = {}): Promise<DesktopBridgeRuntimeInfo> {
    if (this.runtimeInfo && this.status === "running") {
      return this.runtimeInfo;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.stopping = false;
    this.status = this.restartCount > 0 ? "restarting" : "starting";
    this.notifyStatus();
    this.startPromise = this.startBridge(options);
    try {
      return await this.startPromise;
    } catch (error) {
      this.status = "failed";
      this.notifyStatus();
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  async restart(): Promise<DesktopBridgeRuntimeInfo> {
    await this.stop();
    this.restartCount += 1;
    this.consecutiveCrashRestarts = 0;
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.status = "stopped";
    if (this.runtimeInfo?.mode === "reused") {
      this.runtimeInfo = undefined;
      this.notifyStatus();
      await this.flushLogs();
      return;
    }
    const child = this.child;
    this.child = undefined;
    this.runtimeInfo = undefined;
    this.notifyStatus();
    if (!child || child.exitCode !== null || child.killed) {
      await this.flushLogs();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_500);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      if (child.connected) {
        child.send({ type: "opengrove.desktop.bridge.shutdown" });
      } else {
        child.kill("SIGTERM");
      }
    });
    await this.flushLogs();
  }

  diagnostics(): DesktopBridgeDiagnostics {
    return {
      status: this.status,
      pid: this.runtimeInfo?.pid,
      apiBase: this.runtimeInfo?.apiBase,
      port: this.runtimeInfo?.port,
      mode: this.runtimeInfo?.mode,
      restartCount: this.restartCount,
      crashCount: this.crashCount,
      paths: this.paths,
      recentMainLog: readTail(this.paths.mainLogPath, this.token),
      recentBridgeLog: readTail(this.paths.bridgeLogPath, this.token),
      recentCrashLog: readTail(this.paths.bridgeCrashLogPath, this.token),
    };
  }

  currentRuntime(): DesktopBridgeRuntimeInfo | undefined {
    return this.runtimeInfo;
  }

  updaterCacheDirectory(): string | undefined {
    return this.updaterCacheDir;
  }

  async isReusableExternalBridgeHealthy(): Promise<boolean> {
    const decision = await this.tryReuseExternalBridge();
    return decision.action === "reuse";
  }

  private async startBridge(options: DesktopBridgeStartOptions): Promise<DesktopBridgeRuntimeInfo> {
    if (options.allowReuse !== false) {
      const reuse = await this.tryReuseExternalBridge();
      if (reuse.action === "reuse") {
        const runtimeInfo = this.reusedRuntimeInfo(reuse.probe);
        this.runtimeInfo = runtimeInfo;
        this.status = "running";
        this.consecutiveCrashRestarts = 0;
        this.notifyStatus();
        return runtimeInfo;
      }
      if (reuse.action === "blocked") {
        throw desktopBridgeBlocker(reuse.code, reuse.message, reuse);
      }
    }
    let lockRecovery: DesktopStateLockRecoveryResult;
    try {
      lockRecovery = this.recoverStateLocks(this.paths.userDataDir);
    } catch (error) {
      throw desktopBridgeBlocker(
        "LOCAL_STATE_LOCKED",
        `OpenGrove could not inspect its local state locks (${messageOf(error)}). Retry after checking that the data directory is accessible.`,
        { actions: ["repair_state_access", "open_data_dir", "retry"] },
      );
    }
    for (const recovered of lockRecovery.recovered) {
      try {
        this.onStateLockRecovered?.(recovered);
      } catch {
        // Diagnostics must never turn a successful recovery back into a startup failure.
      }
    }
    if (lockRecovery.blockers.length > 0) {
      const liveHolderPids = lockRecovery.blockers
        .filter((blocked) => blocked.reason === "holder_alive" && blocked.holder)
        .map((blocked) => blocked.holder?.pid ?? 0);
      const blockingPids = ownedDesktopBridgeProcessIds(liveHolderPids);
      const accessRepairAvailable = lockRecovery.blockers.some(
        (blocked) => blocked.repairable === true || blocked.reason === "recovery_failed",
      );
      throw desktopBridgeBlocker("LOCAL_STATE_LOCKED", describeStateLockBlockers(lockRecovery.blockers), {
        actions: [
          ...(blockingPids.length > 0 ? ["stop_blocking_process" as const] : []),
          ...(accessRepairAvailable ? ["repair_state_access" as const] : []),
          "open_data_dir",
          "retry",
        ],
        blockingPids,
      });
    }
    return this.spawnBridge();
  }

  private async tryReuseExternalBridge(): Promise<BridgeReuseDecision> {
    const probe = await fetchExternalBridgeProbe();
    if (!probe) {
      return { action: "spawn", reason: "probe_unavailable" };
    }
    if (probe.ok !== true || probe.product !== "OpenGrove") {
      return { action: "spawn", reason: "not_opengrove" };
    }
    if (
      !Object.prototype.hasOwnProperty.call(probe, "requiresToken") ||
      !Object.prototype.hasOwnProperty.call(probe, "stateId")
    ) {
      return {
        action: "blocked",
        code: "LEGACY_BRIDGE_RUNNING",
        message:
          "Detected an older OpenGrove bridge on port 37371. It does not expose state identity and may overwrite desktop data. Quit the old bridge or restart it after updating OpenGrove, then retry.",
        ...runningBridgeBlockerDetails(probe.pid),
      };
    }
    const expectedStateId = stateIdFor(this.paths.statePath);
    const sameState = probe.stateId === expectedStateId;
    const bridgePackageVersion =
      typeof probe.build?.packageVersion === "string" ? probe.build.packageVersion.trim() : "";
    if (
      sameState &&
      this.isPackaged &&
      this.expectedPackageVersion &&
      bridgePackageVersion !== this.expectedPackageVersion
    ) {
      return {
        action: "blocked",
        code: "STALE_BRIDGE_RUNNING",
        message: `Detected an OpenGrove bridge from a different app version on port 37371 (bridge=${bridgePackageVersion || "unknown"}, app=${this.expectedPackageVersion}). Quit the old bridge or restart OpenGrove before continuing.`,
        ...runningBridgeBlockerDetails(probe.pid),
      };
    }

    if (probe.authMode === "session" && sameState) {
      return { action: "reuse", probe };
    }
    if (probe.requiresToken === true && sameState) {
      return {
        action: "blocked",
        code: "PROTECTED_BRIDGE_RUNNING",
        message:
          "Detected an OpenGrove bridge on port 37371 already using this desktop state file, but it requires authentication the desktop cannot reuse. Quit that bridge, then retry.",
        ...runningBridgeBlockerDetails(probe.pid),
      };
    }
    if (probe.requiresToken === false && sameState) {
      return { action: "reuse", probe };
    }
    return { action: "spawn", reason: "state_or_auth_mismatch" };
  }

  private reusedRuntimeInfo(probe: BridgeProbeResponse): DesktopBridgeRuntimeInfo {
    return {
      status: "running",
      mode: "reused",
      host: "127.0.0.1",
      port: 37371,
      url: "http://127.0.0.1:37371",
      apiBase: "http://127.0.0.1:37371/api",
      authMode: probe.authMode === "session" ? "session" : "bridge-token",
      pid: 0,
      dataDir: this.paths.dataDir,
      statePath: this.paths.statePath,
      settingsPath: this.paths.settingsPath,
      logDir: this.paths.logDir,
    };
  }

  private async spawnBridge(): Promise<DesktopBridgeRuntimeInfo> {
    const env = await resolveDesktopEnvironment(process.env);
    const bridgeEntry = this.bridgeEntryPath();
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = fork(bridgeEntry, [], {
        cwd: this.bridgeCwd(),
        // Raise the heap ceiling as an OOM safety net. The bridge loads and
        // checkpoints the local-state SQLite database; a large state can
        // otherwise push the default heap over its limit and crash the process,
        // taking every in-flight room run down with it.
        execArgv: ["--max-old-space-size=4096"],
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : env.ELECTRON_RUN_AS_NODE,
          OPENGROVE_DATA_DIR: this.paths.dataDir,
          OPENGROVE_USER_DATA_DIR: this.paths.userDataDir,
          OPENGROVE_LOG_DIR: this.paths.logDir,
          OPENGROVE_DIAGNOSTICS_DIR: this.paths.diagnosticsDir,
          OPENGROVE_STATE_PATH: this.paths.statePath,
          OPENGROVE_BRIDGE_SETTINGS_PATH: this.paths.settingsPath,
          OPENGROVE_BRIDGE_TOKEN: this.token,
          OPENGROVE_DESKTOP_BRIDGE_ALLOW_UNAUTHENTICATED: this.token ? "" : "1",
          OPENGROVE_BRIDGE_HOST: "127.0.0.1",
          OPENGROVE_BRIDGE_PORT: String(this.preferredPort),
          OPENGROVE_BRIDGE_ALLOWED_ORIGINS: APP_DESKTOP_UI_ORIGIN,
          OPENGROVE_DESKTOP_CHANNEL: this.channel,
          OPENGROVE_WEB_AUTH_MODE: env.OPENGROVE_WEB_AUTH_MODE || "session",
          OPENGROVE_WW_BASE_URL: env.OPENGROVE_WW_BASE_URL || APP_DEFAULT_WW_BASE_URL,
          OPENGROVE_RELEASE_CONTROL_URL: env.OPENGROVE_RELEASE_CONTROL_URL || APP_DEFAULT_RELEASE_CONTROL_URL,
          OPENGROVE_PROGRAMS_DIR: this.paths.programsDir,
          OPENGROVE_WORKSPACES_DIR: this.paths.workspacesDir,
          OPENGROVE_LEGACY_APPS_DIR: join(this.paths.userDataDir, "apps"),
          OPENGROVE_TARGET_APPS_DIR: this.paths.workspacesDir,
          OPENGROVE_UPDATER_CACHE_DIR: this.updaterCacheDir,
        },
        serialization: "json",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => this.writeBridgeLog(chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.writeCrashLog(chunk));
      child.on("message", (message: unknown) => {
        if (isDesktopBridgeStartupActivityMessage(message)) {
          this.notifyStartupActivity(message.activity);
          return;
        }
        if (!isReadyMessage(message)) return;
        const runtimeInfo: DesktopBridgeRuntimeInfo = {
          status: "running",
          mode: "owned",
          host: message.host,
          port: message.port,
          url: message.url,
          apiBase: message.apiBase,
          authMode: message.authMode,
          pid: message.pid,
          dataDir: message.dataDir,
          statePath: message.statePath,
          settingsPath: message.settingsPath,
          logDir: message.logDir,
        };
        this.runtimeInfo = runtimeInfo;
        this.status = "running";
        this.consecutiveCrashRestarts = 0;
        this.preferredPort = message.port;
        this.notifyStatus();
        if (!settled) {
          settled = true;
          resolve(runtimeInfo);
        }
      });
      child.once("error", (error) => {
        this.writeCrashLog(Buffer.from(`${error.stack || error.message}\n`));
        if (!settled) {
          settled = true;
          this.status = "failed";
          reject(error);
        }
      });
      child.once("exit", (code, signal) => {
        if (this.stopping) {
          return;
        }
        this.child = undefined;
        this.runtimeInfo = undefined;
        this.crashCount += 1;
        this.writeCrashLog(Buffer.from(`bridge exited code=${code ?? "null"} signal=${signal ?? "null"}\n`));
        if (!settled) {
          settled = true;
          this.status = "failed";
          this.notifyStatus();
          reject(new Error(`desktop_bridge_exited:${code ?? signal ?? "unknown"}`));
          return;
        }
        void this.scheduleRestart();
      });
    });
  }

  private async scheduleRestart(): Promise<void> {
    if (this.consecutiveCrashRestarts >= 3) {
      this.status = "failed";
      this.notifyStatus();
      return;
    }
    this.restartCount += 1;
    this.consecutiveCrashRestarts += 1;
    this.status = "restarting";
    this.notifyStatus();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      await this.start({ allowReuse: false });
    } catch {
      // start() already records status; repeated failures stop after the max restart count.
    }
  }

  private bridgeEntryPath(): string {
    return join(this.appRoot, "dist", "server", "desktop-bridge-entry.js");
  }

  private bridgeCwd(): string {
    return this.isPackaged ? this.resourcesPath : this.appRoot;
  }

  private writeBridgeLog(chunk: Buffer): void {
    this.bridgeLogWriter.append(redactText(chunk.toString("utf8"), [this.token]));
  }

  private writeCrashLog(chunk: Buffer): void {
    this.bridgeCrashLogWriter.append(redactText(chunk.toString("utf8"), [this.token]));
  }

  private async flushLogs(): Promise<void> {
    await Promise.all([this.bridgeLogWriter.flush(), this.bridgeCrashLogWriter.flush()]);
  }

  private warnBridgeLogWriteFailed(path: string, error: unknown): void {
    console.warn("desktop_bridge_log_write_failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private notifyStatus(): void {
    this.onStatus?.(this.diagnostics());
  }

  private notifyStartupActivity(activity: DesktopBridgeStartupActivity): void {
    try {
      this.onStartupActivity?.(activity);
    } catch {
      // Progress reporting is presentation-only and cannot own startup control.
    }
  }
}

export function createBridgePaths(
  userDataDir: string,
  overrides: { programsDir?: string; workspacesDir?: string } = {},
): DesktopBridgePaths {
  const dataDir = join(userDataDir, "data");
  const logDir = join(userDataDir, "logs");
  return {
    userDataDir,
    dataDir,
    programsDir: overrides.programsDir ?? join(userDataDir, "programs"),
    workspacesDir: overrides.workspacesDir ?? join(userDataDir, "workspaces"),
    logDir,
    cacheDir: join(userDataDir, "cache"),
    diagnosticsDir: join(userDataDir, "diagnostics"),
    statePath: join(dataDir, SQLITE_STATE_FILE_NAME),
    settingsPath: join(dataDir, "bridge-settings.json"),
    mainLogPath: join(logDir, "desktop-main.log"),
    bridgeLogPath: join(logDir, "bridge.log"),
    bridgeCrashLogPath: join(logDir, "bridge-crash.log"),
  };
}

function isReadyMessage(message: unknown): message is DesktopBridgeReadyMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as DesktopBridgeReadyMessage).type === "opengrove.desktop.bridge.ready" &&
      typeof (message as DesktopBridgeReadyMessage).port === "number" &&
      ((message as DesktopBridgeReadyMessage).authMode === "bridge-token" ||
        (message as DesktopBridgeReadyMessage).authMode === "session") &&
      typeof (message as DesktopBridgeReadyMessage).apiBase === "string",
  );
}

function readTail(path: string, token: string): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path);
  const tail = content.subarray(Math.max(0, content.length - 24_000)).toString("utf8");
  return redactText(tail, [token]);
}

async function fetchExternalBridgeProbe(): Promise<BridgeProbeResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch("http://127.0.0.1:37371/opengrove-probe", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as BridgeProbeResponse;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function desktopBridgeBlocker(
  code: BridgeBlockerCode,
  message: string,
  details: {
    actions?: DesktopBridgeStartupBlockerAction[];
    blockingPids?: number[];
  } = {},
): DesktopBridgeBlockerError {
  const error = new Error(message) as DesktopBridgeBlockerError;
  error.code = code;
  error.actions = details.actions ?? ["retry"];
  error.blockingPids = details.blockingPids ?? [];
  return error;
}

function runningBridgeBlockerDetails(pid: number | undefined): {
  actions: DesktopBridgeStartupBlockerAction[];
  blockingPids: number[];
} {
  const candidates = typeof pid === "number" ? [pid] : desktopBridgeListenerProcessIds(37_371);
  const blockingPids = ownedDesktopBridgeProcessIds(candidates);
  return {
    actions: [...(blockingPids.length > 0 ? ["stop_blocking_process" as const] : []), "retry"],
    blockingPids,
  };
}

export function desktopBridgeBlockerDetails(error: unknown): {
  actions: DesktopBridgeStartupBlockerAction[];
  blockingPids: number[];
} {
  if (!isDesktopBridgeBlocker(error)) return { actions: ["retry"], blockingPids: [] };
  const candidate = error as Partial<DesktopBridgeBlockerError>;
  return {
    actions: Array.isArray(candidate.actions) ? candidate.actions : ["retry"],
    blockingPids: Array.isArray(candidate.blockingPids) ? candidate.blockingPids : [],
  };
}

export function isDesktopBridgeBlocker(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return (
    code === "LEGACY_BRIDGE_RUNNING" ||
    code === "PROTECTED_BRIDGE_RUNNING" ||
    code === "STALE_BRIDGE_RUNNING" ||
    code === "LOCAL_STATE_LOCKED"
  );
}

function describeStateLockBlockers(blockers: DesktopStateLockBlocker[]): string {
  return blockers
    .map((blocked) => {
      if (blocked.reason === "holder_alive" && blocked.holder) {
        return `${blocked.statePath} is still held by pid ${blocked.holder.pid}. Close the other OpenGrove process and retry.`;
      }
      if (blocked.reason === "foreign_host" && blocked.holder) {
        return `${blocked.statePath} is owned by OpenGrove on ${blocked.holder.host}. Close that instance before retrying; the lock was preserved to prevent concurrent writes.`;
      }
      return `${blocked.statePath} could not be safely recovered (${blocked.detail}).`;
    })
    .join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
