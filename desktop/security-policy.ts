import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MediaAccessPermissionRequest,
  Session,
  WebContents,
} from "electron";
import {
  APP_DESKTOP_MCP_APP_SANDBOX_ORIGIN,
  APP_DESKTOP_PROXY_TOKEN_HEADER,
  APP_DESKTOP_UI_ORIGIN,
  normalizeHttpOrigin,
} from "../src/identity.js";

export function installDesktopProtocolRequestAuthentication(
  targetSession: Pick<Session, "webRequest">,
  readProxyToken: () => string,
): void {
  // Custom-protocol Requests do not expose a dependable initiator Origin to
  // protocol.handle. Stamp provenance here, where Electron still exposes the
  // requesting frame, and require the launch-scoped value at the proxy boundary.
  targetSession.webRequest.onBeforeSendHeaders({ urls: [`${APP_DESKTOP_UI_ORIGIN}/*`] }, (details, callback) => {
    const requestHeaders = withoutHeader(details.requestHeaders, APP_DESKTOP_PROXY_TOKEN_HEADER);
    const token = readProxyToken();
    if (token && isTrustedDesktopDocumentUrl(details.frame?.url ?? "")) {
      requestHeaders[APP_DESKTOP_PROXY_TOKEN_HEADER] = token;
    }
    callback({ requestHeaders });
  });
}

export function createDesktopContentSecurityPolicy(configuredMcpAppSandboxOrigin?: string): string {
  const configuredSandboxOrigin = normalizeHttpOrigin(configuredMcpAppSandboxOrigin);
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "script-src 'self'",
    // Radix positioning and the pre-React theme bootstrap apply inline styles.
    // Keep this exception scoped to styles; scripts remain self-only.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    // HTTPS remains available for user-authored media. Desktop Bridge data is
    // served through the trusted custom origin and therefore remains 'self'.
    cspDirective("img-src", "'self'", "data:", "blob:", "https:"),
    "font-src 'self' data:",
    cspDirective("media-src", "'self'", "blob:", "https:"),
    cspDirective("frame-src", "'self'", APP_DESKTOP_MCP_APP_SANDBOX_ORIGIN, configuredSandboxOrigin, "https:"),
    "worker-src 'self' blob:",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function cspDirective(name: string, ...sources: Array<string | undefined>): string {
  return `${name} ${[...new Set(sources.filter((source): source is string => Boolean(source)))].join(" ")}`;
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const lowerName = name.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([headerName]) => headerName.toLowerCase() !== lowerName));
}

export type TrustedDesktopIpcRegistrar = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export function createTrustedDesktopIpcRegistrar(targetIpcMain: Pick<IpcMain, "handle">): TrustedDesktopIpcRegistrar {
  return (channel, listener) => {
    targetIpcMain.handle(channel, (event, ...args) => {
      assertTrustedDesktopIpcSender(event);
      return listener(event, ...args);
    });
  };
}

export type TrustedDesktopSyncIpcRegistrar = (
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => unknown,
) => void;

export function createTrustedDesktopSyncIpcRegistrar(
  targetIpcMain: Pick<IpcMain, "on">,
  onRejected?: (channel: string, error: unknown) => void,
): TrustedDesktopSyncIpcRegistrar {
  return (channel, listener) => {
    targetIpcMain.on(channel, (event, ...args) => {
      try {
        assertTrustedDesktopIpcSender(event);
      } catch (error) {
        event.returnValue = null;
        onRejected?.(channel, error);
        return;
      }
      event.returnValue = listener(event, ...args);
    });
  };
}

export function assertTrustedDesktopIpcSender(event: Pick<IpcMainInvokeEvent, "senderFrame">): void {
  if (!isTrustedDesktopDocumentUrl(event.senderFrame?.url ?? "")) {
    throw new Error("desktop_ipc_sender_not_trusted");
  }
}

export function isTrustedDesktopDocumentUrl(value: string): boolean {
  try {
    const expected = new URL(APP_DESKTOP_UI_ORIGIN);
    const candidate = new URL(value);
    return (
      candidate.protocol === expected.protocol &&
      candidate.hostname === expected.hostname &&
      candidate.port === expected.port &&
      (candidate.pathname === "/ui" || candidate.pathname.startsWith("/ui/"))
    );
  } catch {
    return false;
  }
}

export function installDesktopExternalNavigationPolicy(
  targetWebContents: Pick<WebContents, "on" | "setWindowOpenHandler">,
  openExternal: (url: string) => unknown,
): void {
  targetWebContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void openExternal(url);
    }
    return { action: "deny" };
  });
  targetWebContents.on("will-navigate", (event, url) => {
    if (isTrustedDesktopDocumentUrl(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) {
      void openExternal(url);
    }
  });
}

export function installDesktopPermissionPolicy(
  targetSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
): void {
  targetSession.setPermissionCheckHandler(
    (_webContents, permission, _requestingOrigin, details) =>
      permission === "media" &&
      details.isMainFrame &&
      details.mediaType === "audio" &&
      isTrustedDesktopDocumentUrl(details.requestingUrl ?? ""),
  );
  targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(permission === "media" && isAllowedDesktopAudioRequest(details));
  });
}

function isAllowedDesktopAudioRequest(details: MediaAccessPermissionRequest | Electron.PermissionRequest): boolean {
  const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
  return (
    details.isMainFrame &&
    isTrustedDesktopDocumentUrl(details.requestingUrl) &&
    Array.isArray(mediaTypes) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
