import type { SupportedLocale } from "@opengrove/agent-protocol/locale-registry";
import type {
  DesktopBridgeStartupBlockerAction,
  DesktopBridgeStartupState,
} from "../../src/desktop-bridge-startup-state";
import type { DesktopStripeDeepLink } from "../../src/desktop-stripe-deep-link";

export interface OpenGroveDesktopDiagnostics {
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
}

export type OpenGroveDesktopDiagnosticExportResult =
  | { status: "cancelled" }
  | {
      status: "saved";
      path: string;
      fileName: string;
      sizeBytes: number;
      sha256: string;
      evidenceComplete: boolean;
    };

export type OpenGroveDesktopDirectoryPickerResult = { status: "cancelled" } | { status: "selected"; path: string };

export interface OpenGroveDesktopStartupTimeoutRecordResult {
  code: string;
  incidentId: string;
}

export interface OpenGroveDesktopWindowState {
  fullscreen: boolean;
}

export interface OpenGroveHostVersion {
  packageVersion: string;
  clientReleaseNumber: number | null;
}

export type OpenGroveDesktopChromeTheme = "light" | "dark";

export type OpenGroveDesktopSourceUpdateStage =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "blocked"
  | "updating"
  | "restarting"
  | "error";

export interface OpenGroveDesktopSourceUpdateState {
  supported: boolean;
  stage: OpenGroveDesktopSourceUpdateStage;
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
}

export type OpenGroveDesktopClientUpdateStage =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "installing"
  | "error";

export interface OpenGroveDesktopClientUpdateState {
  supported: boolean;
  stage: OpenGroveDesktopClientUpdateStage;
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

export interface OpenGroveDesktopApi {
  apiBase: string;
  bridgeStartupState?: DesktopBridgeStartupState;
  getBridgeStartupState?(): DesktopBridgeStartupState | undefined;
  platform?: string;
  isPackaged?: boolean;
  isOfficialRelease?: boolean;
  versions?: {
    app?: string;
    clientReleaseNumber?: number;
    electron?: string;
    chrome?: string;
    node?: string;
  };
  getHostVersion?(): Promise<OpenGroveHostVersion>;
  diagnostics?(): Promise<OpenGroveDesktopDiagnostics>;
  retryBridgeStartup?(): Promise<void>;
  resolveBridgeStartupBlocker?(action: DesktopBridgeStartupBlockerAction): Promise<void>;
  recordStartupTimeout?(): Promise<OpenGroveDesktopStartupTimeoutRecordResult>;
  exportDiagnostics?(): Promise<OpenGroveDesktopDiagnosticExportResult>;
  chooseDirectory?(): Promise<OpenGroveDesktopDirectoryPickerResult>;
  restartBridge?(): Promise<OpenGroveDesktopDiagnostics>;
  getSourceUpdateState?(): Promise<OpenGroveDesktopSourceUpdateState>;
  checkForSourceUpdate?(): Promise<OpenGroveDesktopSourceUpdateState>;
  installSourceUpdate?(): Promise<OpenGroveDesktopSourceUpdateState>;
  getClientUpdateState?(): Promise<OpenGroveDesktopClientUpdateState>;
  checkForClientUpdate?(): Promise<OpenGroveDesktopClientUpdateState>;
  downloadClientUpdate?(): Promise<OpenGroveDesktopClientUpdateState>;
  installClientUpdate?(): Promise<OpenGroveDesktopClientUpdateState>;
  setClientUpdateAutoDownload?(autoDownload: boolean): Promise<OpenGroveDesktopClientUpdateState>;
  openDataDir?(): Promise<void>;
  openLogDir?(): Promise<void>;
  resetData?(): Promise<void>;
  hasSavedAuthSession?(): Promise<boolean>;
  getWindowState?(): Promise<OpenGroveDesktopWindowState>;
  getSystemTheme?(): Promise<OpenGroveDesktopChromeTheme>;
  setWindowChromeTheme?(theme: OpenGroveDesktopChromeTheme): Promise<void>;
  setLanguage?(language: SupportedLocale): Promise<void>;
  onWindowStateChange?(callback: (state: OpenGroveDesktopWindowState) => void): () => void;
  onSystemThemeChange?(callback: (theme: OpenGroveDesktopChromeTheme) => void): () => void;
  onSourceUpdateStateChange?(callback: (state: OpenGroveDesktopSourceUpdateState) => void): () => void;
  onClientUpdateStateChange?(callback: (state: OpenGroveDesktopClientUpdateState) => void): () => void;
  onBridgeStartupStateChange?(callback: (state: DesktopBridgeStartupState) => void): () => void;
  onStripeDeepLink?(callback: (deepLink: DesktopStripeDeepLink) => void): () => void;
}

export function readDesktopBridgeStartupState(
  desktop: OpenGroveDesktopApi | undefined = readDesktopApi(),
): DesktopBridgeStartupState | undefined {
  return desktop?.getBridgeStartupState?.() ?? desktop?.bridgeStartupState;
}

declare global {
  interface Window {
    openGroveDesktop?: OpenGroveDesktopApi;
  }

  // eslint-disable-next-line no-var
  var openGroveDesktop: OpenGroveDesktopApi | undefined;
}

export function readDesktopApi(): OpenGroveDesktopApi | undefined {
  return globalThis.openGroveDesktop ?? (typeof window === "undefined" ? undefined : window.openGroveDesktop);
}
