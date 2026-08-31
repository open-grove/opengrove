import { autoUpdater } from "electron-updater";
import type { UpdateDownloadedEvent } from "electron-updater";
import { responseSetCookieHeaders } from "./auth-cookies.js";
import { DESKTOP_CLIENT_UPDATE_POLICY } from "./client-update-policy.js";

export type DesktopClientUpdateStage =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "installing"
  | "error";

export interface DesktopClientUpdateState {
  supported: boolean;
  stage: DesktopClientUpdateStage;
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
}

interface DesktopClientUpdateManagerOptions {
  enabled: boolean;
  currentVersion: string;
  autoDownload?: boolean;
  bridgeToken?: string;
  getApiBase(): string | undefined;
  getCookieHeader(): string | undefined;
  applySetCookieHeaders(headers: readonly string[] | undefined): void;
  prepareForInstall(): Promise<void>;
  log(message: string): void;
  onStateChange(state: DesktopClientUpdateState): void;
}

interface ClientUpdateResponse {
  ok?: boolean;
  current?: number | null;
  latest?: {
    version?: number;
    downloadUrl?: string;
    updaterBaseUrl?: string;
    updaterFeedUrl?: string;
    releasedAt?: string;
    releaseNotes?: string;
  } | null;
}

const MAX_LOG_LINES = 80;
const BRIDGE_TOKEN_HEADER = "x-opengrove-token";

export class DesktopClientUpdateManager {
  private readonly enabled: boolean;
  private readonly currentVersion: string;
  private readonly bridgeToken: string | undefined;
  private readonly getApiBase: DesktopClientUpdateManagerOptions["getApiBase"];
  private readonly getCookieHeader: DesktopClientUpdateManagerOptions["getCookieHeader"];
  private readonly applySetCookieHeaders: DesktopClientUpdateManagerOptions["applySetCookieHeaders"];
  private readonly prepareForInstall: DesktopClientUpdateManagerOptions["prepareForInstall"];
  private readonly logMain: DesktopClientUpdateManagerOptions["log"];
  private readonly onStateChange: DesktopClientUpdateManagerOptions["onStateChange"];
  private autoDownload: boolean;
  private state: DesktopClientUpdateState;
  private operation?: Promise<DesktopClientUpdateState>;
  private installing = false;

  constructor(options: DesktopClientUpdateManagerOptions) {
    this.enabled = options.enabled;
    this.currentVersion = options.currentVersion;
    this.autoDownload = options.autoDownload ?? DESKTOP_CLIENT_UPDATE_POLICY.autoDownload;
    this.bridgeToken = options.bridgeToken;
    this.getApiBase = options.getApiBase;
    this.getCookieHeader = options.getCookieHeader;
    this.applySetCookieHeaders = options.applySetCookieHeaders;
    this.prepareForInstall = options.prepareForInstall;
    this.logMain = options.log;
    this.onStateChange = options.onStateChange;
    this.state = {
      supported: this.enabled,
      stage: this.enabled ? "idle" : "unsupported",
      busy: false,
      updateAvailable: false,
      downloaded: false,
      canAutoInstall: false,
      autoDownload: this.autoDownload,
      currentVersion: this.currentVersion,
      message: this.enabled ? "准备检查安装版更新。" : "当前运行环境不是打包安装版。",
      log: [],
    };

    if (this.enabled) {
      this.configureAutoUpdater();
    }
  }

  snapshot(): DesktopClientUpdateState {
    return cloneState(this.state);
  }

  isInstalling(): boolean {
    return this.installing || this.state.stage === "installing";
  }

  checkForUpdates(): Promise<DesktopClientUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.stage === "downloading" || this.state.stage === "downloaded" || this.state.stage === "installing") {
      return Promise.resolve(this.snapshot());
    }
    this.operation = this.runCheck().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  downloadUpdate(): Promise<DesktopClientUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.stage === "downloading" || this.state.stage === "downloaded" || this.state.stage === "installing") {
      return Promise.resolve(this.snapshot());
    }
    if (!this.enabled || this.state.stage !== "available" || !this.state.updaterBaseUrl) {
      return Promise.reject(new Error("安装版更新当前不可自动下载。"));
    }
    this.operation = this.runDownload().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  setAutoDownload(autoDownload: boolean): DesktopClientUpdateState {
    this.autoDownload = autoDownload;
    autoUpdater.autoDownload = autoDownload;
    this.setState({ autoDownload });
    return this.snapshot();
  }

  async installUpdate(): Promise<DesktopClientUpdateState> {
    if (!this.enabled) {
      this.setState({
        stage: "unsupported",
        busy: false,
        updateAvailable: false,
        downloaded: false,
        canAutoInstall: false,
        message: "当前运行环境不是打包安装版。",
      });
      return this.snapshot();
    }
    if (this.state.stage !== "downloaded") {
      throw new Error("安装版更新尚未下载完成。");
    }
    this.installing = true;
    this.setState({
      stage: "installing",
      busy: true,
      updateAvailable: true,
      downloaded: true,
      canAutoInstall: true,
      message: "正在安装更新并重启 OpenGrove...",
      finishedAt: new Date().toISOString(),
    });

    try {
      await this.prepareForInstall();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.installing = false;
      this.setState({
        stage: "downloaded",
        busy: false,
        updateAvailable: true,
        downloaded: true,
        canAutoInstall: true,
        message: "更新已下载，但安装前准备失败。",
        details,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }

    // The user has already confirmed this destructive restart in the Host UI.
    // An assisted NSIS update still exposes an install-mode page even with
    // --updated, which leaves headless deployments and ordinary users waiting
    // after OpenGrove has exited. Run Windows updates silently and force the
    // installed candidate to restart; macOS keeps its native updater behavior.
    autoUpdater.quitAndInstall(process.platform === "win32", true);
    return this.snapshot();
  }

  private configureAutoUpdater(): void {
    autoUpdater.autoDownload = this.autoDownload;
    autoUpdater.autoInstallOnAppQuit = DESKTOP_CLIENT_UPDATE_POLICY.autoInstallOnAppQuit;
    autoUpdater.logger = {
      info: (message: unknown) => this.logMain(`[electron-updater] ${String(message)}`),
      warn: (message: unknown) => this.logMain(`[electron-updater:warn] ${String(message)}`),
      error: (message: unknown) => this.logMain(`[electron-updater:error] ${String(message)}`),
      debug: (message: unknown) => this.logMain(`[electron-updater:debug] ${String(message)}`),
    };

    autoUpdater.on("checking-for-update", () => {
      this.appendLog("electron-updater checking-for-update");
      this.setState({
        stage: "checking",
        busy: true,
        downloaded: false,
        canAutoInstall: false,
        message: "正在检查安装版更新...",
      });
    });
    autoUpdater.on("update-available", (info) => {
      this.appendLog(`electron-updater update-available ${info.version}`);
      this.setState({
        stage: this.autoDownload ? "downloading" : "available",
        busy: this.autoDownload,
        updateAvailable: true,
        downloaded: false,
        canAutoInstall: false,
        latestVersion: info.version,
        downloadProgress: this.autoDownload ? 0 : undefined,
        message: this.autoDownload ? `正在下载 OpenGrove ${info.version}...` : `OpenGrove ${info.version} 可以下载。`,
      });
    });
    autoUpdater.on("update-not-available", (info) => {
      this.appendLog(`electron-updater update-not-available ${info.version}`);
      this.setState({
        stage: "up-to-date",
        busy: false,
        updateAvailable: false,
        downloaded: false,
        canAutoInstall: false,
        latestVersion: info.version,
        message: "已经是最新安装版。",
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.setState({
        stage: "downloading",
        busy: true,
        updateAvailable: true,
        downloaded: false,
        canAutoInstall: false,
        downloadProgress: percent,
        message: `正在下载 OpenGrove 更新 (${percent}%)...`,
      });
    });
    autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
      this.appendLog(`electron-updater update-downloaded ${event.version}`);
      this.setState({
        stage: "downloaded",
        busy: false,
        updateAvailable: true,
        downloaded: true,
        canAutoInstall: true,
        latestVersion: event.version,
        downloadProgress: 100,
        message: `OpenGrove ${event.version} 已下载，点击重启安装。`,
        finishedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("error", (error) => {
      this.appendLog(`electron-updater error ${error.message}`);
      this.setState({
        stage: "error",
        busy: false,
        updateAvailable: this.state.updateAvailable,
        downloaded: false,
        canAutoInstall: false,
        message: "自动更新失败。",
        details: error.message,
        finishedAt: new Date().toISOString(),
      });
    });
  }

  private async runCheck(): Promise<DesktopClientUpdateState> {
    if (!this.enabled) {
      this.setState({
        stage: "unsupported",
        busy: false,
        updateAvailable: false,
        downloaded: false,
        canAutoInstall: false,
        message: "当前运行环境不是打包安装版。",
      });
      return this.snapshot();
    }

    this.setState({
      stage: "checking",
      busy: true,
      updateAvailable: this.state.updateAvailable,
      downloaded: this.state.downloaded,
      canAutoInstall: this.state.canAutoInstall,
      message: "正在查询安装版更新...",
      details: undefined,
      checkedAt: this.state.checkedAt,
      startedAt: new Date().toISOString(),
    });

    try {
      const response = await this.fetchClientUpdate();
      const latest = response.latest;
      const currentReleaseNumber = typeof response.current === "number" ? response.current : undefined;
      const latestReleaseNumber = typeof latest?.version === "number" ? latest.version : undefined;
      if (
        !latest ||
        latestReleaseNumber === undefined ||
        currentReleaseNumber === undefined ||
        latestReleaseNumber <= currentReleaseNumber
      ) {
        this.setState({
          stage: "up-to-date",
          busy: false,
          updateAvailable: false,
          downloaded: false,
          canAutoInstall: false,
          currentReleaseNumber,
          latestReleaseNumber,
          latestVersion: latestReleaseNumber === undefined ? undefined : String(latestReleaseNumber),
          downloadUrl: latest?.downloadUrl,
          updaterBaseUrl: latest?.updaterBaseUrl,
          updaterFeedUrl: latest?.updaterFeedUrl,
          message: "已经是最新安装版。",
          checkedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return this.snapshot();
      }

      const normalizedUpdaterFeedUrl = normalizeUpdaterFeedUrl(latest.updaterFeedUrl);
      const updaterBaseUrl =
        normalizeUpdaterBaseUrl(latest.updaterBaseUrl) ??
        updaterBaseFromFeedUrl(normalizedUpdaterFeedUrl) ??
        updaterBaseFromDownloadUrl(latest.downloadUrl);
      const updaterFeedUrl = normalizedUpdaterFeedUrl ?? updaterFeedUrlFromBase(updaterBaseUrl);
      this.setState({
        stage: "available",
        busy: false,
        updateAvailable: true,
        downloaded: false,
        canAutoInstall: Boolean(updaterBaseUrl),
        currentReleaseNumber,
        latestReleaseNumber,
        latestVersion: String(latestReleaseNumber),
        downloadUrl: latest.downloadUrl,
        updaterBaseUrl,
        updaterFeedUrl,
        downloadProgress: undefined,
        message: updaterBaseUrl ? `发现 OpenGrove 更新 ${latestReleaseNumber}。` : "发现新版本，可前往下载。",
        details: updaterBaseUrl ? undefined : "后端未返回可用的 updater feed，暂时保留下载入口。",
        checkedAt: new Date().toISOString(),
      });

      if (!updaterBaseUrl) {
        return this.snapshot();
      }

      this.appendLog(`electron-updater feed ${updaterBaseUrl}`);
      autoUpdater.setFeedURL({
        provider: "generic",
        url: updaterBaseUrl,
      });
      await autoUpdater.checkForUpdates();
      return this.snapshot();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const unauthenticated = /not_authenticated|HTTP 401/i.test(details);
      this.setState({
        stage: unauthenticated ? "idle" : "error",
        busy: false,
        updateAvailable: this.state.updateAvailable,
        downloaded: false,
        canAutoInstall: false,
        message: unauthenticated ? "登录后检查安装版更新。" : "检查安装版更新失败。",
        details: unauthenticated ? undefined : details,
        finishedAt: new Date().toISOString(),
      });
      if (!unauthenticated) {
        this.logMain(`client update error: ${details}`);
      }
      return this.snapshot();
    }
  }

  private async runDownload(): Promise<DesktopClientUpdateState> {
    this.setState({
      stage: "downloading",
      busy: true,
      updateAvailable: true,
      downloaded: false,
      canAutoInstall: false,
      downloadProgress: 0,
      message: `正在下载 OpenGrove ${this.state.latestVersion || this.state.latestReleaseNumber || ""}...`,
      details: undefined,
      startedAt: new Date().toISOString(),
    });
    try {
      await autoUpdater.downloadUpdate();
      return this.snapshot();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.setState({
        stage: "error",
        busy: false,
        updateAvailable: true,
        downloaded: false,
        canAutoInstall: false,
        message: "自动更新失败。",
        details,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async fetchClientUpdate(): Promise<ClientUpdateResponse> {
    const apiBase = this.getApiBase();
    if (!apiBase) throw new Error("desktop_bridge_not_started");
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    const cookie = this.getCookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.bridgeToken) headers[BRIDGE_TOKEN_HEADER] = this.bridgeToken;
    const response = await fetch(`${apiBase}/auth/client-update`, {
      cache: "no-store",
      headers,
    });
    this.applySetCookieHeaders(responseSetCookieHeaders(response.headers));
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        body && typeof body === "object" && "error" in body ? String((body as { error?: unknown }).error) : "";
      throw new Error(`client-update HTTP ${response.status}${code ? ` ${code}` : ""}`);
    }
    return normalizeClientUpdateResponse(body);
  }

  private appendLog(value: string): void {
    this.setState({
      log: [...this.state.log, value].slice(-MAX_LOG_LINES),
    });
  }

  private setState(patch: Partial<DesktopClientUpdateState>): void {
    this.state = {
      ...this.state,
      ...patch,
      log: patch.log ?? this.state.log,
    };
    this.onStateChange(this.snapshot());
  }
}

function normalizeClientUpdateResponse(value: unknown): ClientUpdateResponse {
  const object = recordValue(value);
  const latest = recordOrUndefined(object.latest);
  return {
    ok: object.ok === true,
    current: typeof object.current === "number" ? object.current : null,
    latest: latest
      ? {
          version: typeof latest.version === "number" ? latest.version : undefined,
          downloadUrl: stringValue(latest.downloadUrl),
          updaterBaseUrl: stringValue(latest.updaterBaseUrl),
          updaterFeedUrl: stringValue(latest.updaterFeedUrl),
          releasedAt: stringValue(latest.releasedAt),
          releaseNotes: stringValue(latest.releaseNotes),
        }
      : null,
  };
}

function normalizeUpdaterBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isTrustedUpdaterUrl(url)) return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function normalizeUpdaterFeedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isTrustedUpdaterUrl(url)) return undefined;
    if (!/latest(?:-[a-z]+)?\.ya?ml$/i.test(url.pathname.split("/").pop() ?? "")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function updaterBaseFromFeedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isTrustedUpdaterUrl(url)) return undefined;
    if (!/latest(?:-[a-z]+)?\.ya?ml$/i.test(url.pathname.split("/").pop() ?? "")) return undefined;
    url.pathname = url.pathname.replace(/\/[^/]*$/, "/");
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function updaterBaseFromDownloadUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isTrustedUpdaterUrl(url)) return undefined;
    url.pathname = url.pathname.replace(/\/[^/]*$/, "/");
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function updaterFeedUrlFromBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const file =
    process.platform === "darwin" ? "latest-mac.yml" : process.platform === "linux" ? "latest-linux.yml" : "latest.yml";
  return `${value.replace(/\/+$/, "")}/${file}`;
}

function isTrustedUpdaterUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return (
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
  );
}

function cloneState(state: DesktopClientUpdateState): DesktopClientUpdateState {
  return {
    ...state,
    log: [...state.log],
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
