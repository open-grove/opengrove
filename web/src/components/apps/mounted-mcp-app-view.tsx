import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionItemRecord } from "../../bridge";
import { apiUrl } from "../../api-base";
import { rawDiagnosticText, translate, useI18n } from "../../i18n";
import { getClientBootstrap } from "../../runtime/client-bootstrap";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import {
  bindHostCapabilityHandlers,
  declareHostCapabilities,
  type McpAppDownloadFile,
} from "./mcp-app-host-capabilities";
import { resolveMcpAppDisplayMode, type McpAppDisplayMode } from "./mcp-app-display-mode";
import { resolveMcpAppSandboxUrl as resolveSandboxBaseUrl } from "./mcp-app-sandbox-url";
import "./mounted-app-workbench.css";

interface McpAppContractResponse {
  ok: boolean;
  error?: string;
  contract?: McpAppContract;
}

const MCP_APP_EXIT_FULLSCREEN_MESSAGE = "opengrove/mcp-app-exit-fullscreen";
const MAX_EXTERNAL_LINK_DISPLAY_LENGTH = 180;
export const MCP_APP_LOAD_TIMEOUT_MS = 15_000;

interface PendingExternalLink {
  href: string;
  origin: string;
  displayUrl: string;
  resolve(result: { isError?: boolean }): void;
}

interface PendingFileDownload {
  files: McpAppDownloadFile[];
  resolve(result: { isError?: boolean }): void;
}

interface McpAppContract {
  protocol: "mcp-apps";
  resource: {
    uri: string;
    mimeType: string;
    text: string;
    _meta: {
      ui: {
        csp: {
          connectDomains?: string[];
          resourceDomains?: string[];
          frameDomains?: string[];
          baseUriDomains?: string[];
        };
        permissions: Record<string, Record<string, never>>;
        prefersBorder: boolean;
      };
    };
  };
  launcherTool: Tool;
  tools: Tool[];
}

export function MountedMcpAppView(props: {
  app: ExtensionItemRecord | undefined;
  viewId?: string;
  runtimeRevision?: string;
  deferUntilRuntimeRevision?: boolean;
  active?: boolean;
}) {
  const { language, t } = useI18n();
  const active = props.active !== false;
  const activeRef = useRef(active);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [contract, setContract] = useState<McpAppContract>();
  const [error, setError] = useState("");
  const [frameLoad, setFrameLoad] = useState(0);
  // 加载失败不该是死胡同：加一就重走一遍取契约 → 挂 iframe → 握手的整条流程。
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>("inline");
  const displayModeRef = useRef<McpAppDisplayMode>("inline");
  const bridgeRef = useRef<AppBridge | undefined>(undefined);
  const hostContextRef = useRef<McpUiHostContext | undefined>(undefined);
  const [stableRuntimeRevision, setStableRuntimeRevision] = useState(props.runtimeRevision);
  const [pendingExternalLink, setPendingExternalLink] = useState<PendingExternalLink | null>(null);
  const pendingExternalLinkRef = useRef<PendingExternalLink | null>(null);
  const [pendingFileDownload, setPendingFileDownload] = useState<PendingFileDownload | null>(null);
  const pendingFileDownloadRef = useRef<PendingFileDownload | null>(null);

  const settleExternalLink = useCallback((result: { isError?: boolean }) => {
    const pending = pendingExternalLinkRef.current;
    if (!pending) return;
    pendingExternalLinkRef.current = null;
    setPendingExternalLink(null);
    pending.resolve(result);
  }, []);

  const requestExternalLink = useCallback((externalUrl: URL) => {
    if (!activeRef.current) return Promise.resolve({ isError: true });
    if (pendingExternalLinkRef.current) return Promise.resolve({ isError: true });
    return new Promise<{ isError?: boolean }>((resolve) => {
      const pending: PendingExternalLink = {
        href: externalUrl.href,
        origin: externalUrl.origin,
        displayUrl: externalLinkDisplayUrl(externalUrl),
        resolve,
      };
      pendingExternalLinkRef.current = pending;
      setPendingExternalLink(pending);
    });
  }, []);

  const settleFileDownload = useCallback((result: { isError?: boolean }) => {
    const pending = pendingFileDownloadRef.current;
    if (!pending) return;
    pendingFileDownloadRef.current = null;
    setPendingFileDownload(null);
    pending.resolve(result);
  }, []);

  const requestFileDownload = useCallback((files: McpAppDownloadFile[]) => {
    if (!activeRef.current) return Promise.resolve({ isError: true });
    if (pendingFileDownloadRef.current) return Promise.resolve({ isError: true });
    return new Promise<{ isError?: boolean }>((resolve) => {
      const pending: PendingFileDownload = { files, resolve };
      pendingFileDownloadRef.current = pending;
      setPendingFileDownload(pending);
    });
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) return;
    settleExternalLink({ isError: true });
    settleFileDownload({ isError: true });
  }, [active, settleExternalLink, settleFileDownload]);

  useEffect(
    () => () => {
      const pendingLink = pendingExternalLinkRef.current;
      pendingExternalLinkRef.current = null;
      pendingLink?.resolve({ isError: true });
      const pendingDownload = pendingFileDownloadRef.current;
      pendingFileDownloadRef.current = null;
      pendingDownload?.resolve({ isError: true });
    },
    [],
  );

  useEffect(() => {
    if (!props.runtimeRevision || props.runtimeRevision === stableRuntimeRevision) return;
    if (!stableRuntimeRevision) {
      setStableRuntimeRevision(props.runtimeRevision);
      return;
    }
    const revisionTimeout = window.setTimeout(() => {
      setStableRuntimeRevision(props.runtimeRevision);
    }, 2_000);
    return () => window.clearTimeout(revisionTimeout);
  }, [props.runtimeRevision, stableRuntimeRevision]);

  const updateDisplayMode = useCallback((requestedMode: string) => {
    const nextMode = resolveMcpAppDisplayMode(requestedMode);
    displayModeRef.current = nextMode;
    setDisplayMode(nextMode);
    const currentHostContext = hostContextRef.current;
    if (currentHostContext) {
      const nextHostContext = { ...currentHostContext, displayMode: nextMode };
      hostContextRef.current = nextHostContext;
      bridgeRef.current?.setHostContext(nextHostContext);
    }
    return nextMode;
  }, []);

  useEffect(() => {
    const currentHostContext = hostContextRef.current;
    if (!currentHostContext) return;
    const locale = language;
    if (currentHostContext.locale === locale) return;
    const nextHostContext = { ...currentHostContext, locale };
    hostContextRef.current = nextHostContext;
    bridgeRef.current?.setHostContext(nextHostContext);
  }, [language]);

  useEffect(() => {
    const controller = new AbortController();
    setContract(undefined);
    setError("");
    setFrameLoad(0);
    displayModeRef.current = "inline";
    setDisplayMode("inline");
    const app = props.app;
    if (props.deferUntilRuntimeRevision && !stableRuntimeRevision) return () => controller.abort();
    if (!app) return () => controller.abort();
    void (async () => {
      try {
        const response = await fetch(mcpAppApiUrl(app.name, "contract", props.viewId), {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as McpAppContractResponse;
        if (!response.ok || !payload.ok || !payload.contract) {
          throw new Error(payload.error || `MCP App contract HTTP ${response.status}`);
        }
        setContract(payload.contract);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      }
    })();
    return () => controller.abort();
  }, [props.app?.name, props.deferUntilRuntimeRevision, props.viewId, reloadAttempt, stableRuntimeRevision]);

  useEffect(() => {
    if (displayMode !== "fullscreen") return;
    const exitFullscreen = () => updateDisplayMode("inline");
    const exitOnHostEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      exitFullscreen();
    };
    const exitOnViewEscape = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.type !== MCP_APP_EXIT_FULLSCREEN_MESSAGE)
        return;
      exitFullscreen();
    };
    window.addEventListener("keydown", exitOnHostEscape);
    window.addEventListener("message", exitOnViewEscape);
    return () => {
      window.removeEventListener("keydown", exitOnHostEscape);
      window.removeEventListener("message", exitOnViewEscape);
    };
  }, [displayMode, updateDisplayMode]);

  const sandbox = useMemo(() => {
    if (!contract) return { url: "", error: "" };
    try {
      return { url: resolveMcpAppSandboxUrl(contract.resource._meta.ui.csp), error: "" };
    } catch (cause) {
      return { url: "", error: errorMessage(cause) };
    }
  }, [contract]);

  useEffect(() => {
    if (!sandbox.url || frameLoad > 0 || error) return;
    const navigationTimeout = window.setTimeout(() => {
      setError("mcp_app_frame_load_timeout");
    }, MCP_APP_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(navigationTimeout);
  }, [error, frameLoad, sandbox.url]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (error || !props.app || !contract || !iframe?.contentWindow || frameLoad === 0) return;
    let disposed = false;
    let bridge: AppBridge | undefined;
    let client: Client | undefined;
    let server: Server | undefined;
    let viewTransport: PostMessageTransport | undefined;
    let resourceSent = false;
    const handshakeTimeout = window.setTimeout(() => {
      if (!disposed) setError("mcp_app_handshake_timeout");
    }, MCP_APP_LOAD_TIMEOUT_MS);

    void (async () => {
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        server = createContractServer(props.app!.name, contract, props.viewId);
        client = new Client(
          { name: "opengrove-mcp-app-host", version: "1.0.0" },
          {
            capabilities: {
              extensions: {
                "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
              },
            },
          },
        );
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        if (disposed || !iframe.contentWindow) return;

        const hostContext: McpUiHostContext = {
          toolInfo: { tool: contract.launcherTool },
          theme: document.documentElement.dataset.theme === "dark" ? ("dark" as const) : ("light" as const),
          locale: language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: "OpenGrove/0.5.4",
          platform: isDesktopHost() ? ("desktop" as const) : ("web" as const),
          displayMode: displayModeRef.current,
          availableDisplayModes: ["inline", "fullscreen"] as Array<"inline" | "fullscreen">,
        };
        hostContextRef.current = hostContext;
        const capabilityDeps = {
          sandboxPolicy: contract.resource._meta.ui,
          requestExternalLink,
          requestFileDownload,
          isViewActive: () => activeRef.current,
        };
        bridge = new AppBridge(
          client,
          { name: "OpenGrove", version: "0.5.4" },
          declareHostCapabilities(capabilityDeps),
          {
            hostContext,
          },
        );
        bridgeRef.current = bridge;
        bindHostCapabilityHandlers(bridge, capabilityDeps);
        bridge.onrequestdisplaymode = async ({ mode }) => {
          const nextMode = updateDisplayMode(mode);
          return { mode: nextMode };
        };
        bridge.onsandboxready = () => {
          if (disposed || resourceSent) return;
          resourceSent = true;
          void bridge
            ?.sendSandboxResourceReady({
              html: contract.resource.text,
              sandbox: "allow-scripts allow-forms",
              csp: contract.resource._meta.ui.csp,
              permissions: contract.resource._meta.ui.permissions,
            })
            .catch((cause) => {
              resourceSent = false;
              window.clearTimeout(handshakeTimeout);
              if (!disposed) setError(errorMessage(cause));
            });
        };
        bridge.oninitialized = () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimeout);
          const result = launcherToolResult(props.app!.name);
          void bridge
            ?.sendToolInput({ arguments: {} })
            .then(() => bridge?.sendToolResult(result))
            .catch((cause) => {
              if (!disposed) setError(errorMessage(cause));
            });
        };
        viewTransport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
        await bridge.connect(viewTransport);
      } catch (cause) {
        window.clearTimeout(handshakeTimeout);
        if (!disposed) setError(errorMessage(cause));
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(handshakeTimeout);
      if (bridgeRef.current === bridge) {
        bridgeRef.current = undefined;
        hostContextRef.current = undefined;
        settleExternalLink({ isError: true });
        settleFileDownload({ isError: true });
      }
      void bridge
        ?.teardownResource({})
        .catch(() => undefined)
        .finally(() => viewTransport?.close());
      void client?.close();
      void server?.close();
    };
  }, [
    contract,
    error,
    frameLoad,
    props.app?.name,
    props.viewId,
    requestExternalLink,
    requestFileDownload,
    settleExternalLink,
    settleFileDownload,
    updateDisplayMode,
  ]);

  if (!props.app) {
    return (
      <div className="mounted-app-empty">
        <strong>{t("mountedApp.emptyTitle")}</strong>
        <p>{t("mountedApp.emptyCopy")}</p>
      </div>
    );
  }
  const visibleError = error || sandbox.error;
  if (visibleError) {
    return (
      <div className="mounted-app-empty" role="alert">
        <strong>{t("mountedApp.mcpAppOpenFailed")}</strong>
        <p>{rawDiagnosticText(visibleError)}</p>
        {error ? (
          <Button
            onClick={() => {
              setContract(undefined);
              setError("");
              setReloadAttempt((attempt) => attempt + 1);
            }}
          >
            {t("mountedApp.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!contract || !sandbox.url) {
    return (
      <div className="mounted-app-empty">
        <p>{t("mountedApp.mcpAppConnecting")}</p>
      </div>
    );
  }

  return (
    <div className="mounted-app-web-view" data-mcp-app="true" data-display-mode={displayMode}>
      {displayMode === "fullscreen" ? (
        <button type="button" className="mounted-app-fullscreen-exit" onClick={() => updateDisplayMode("inline")}>
          {t("mountedApp.exitFullscreen")}
        </button>
      ) : null}
      <div className="mounted-app-web-frame-shell">
        <iframe
          ref={iframeRef}
          className="mounted-app-web-frame"
          src={sandbox.url}
          title={`${props.app.title} MCP App`}
          sandbox="allow-forms allow-scripts"
          allow={buildAllowAttribute(contract.resource._meta.ui.permissions)}
          referrerPolicy="no-referrer"
          onLoad={() => setFrameLoad((value) => value + 1)}
          onError={() => setError("mcp_app_frame_load_failed")}
        />
      </div>
      <Dialog
        open={active && pendingExternalLink !== null}
        onOpenChange={(open) => {
          if (!open) settleExternalLink({ isError: true });
        }}
      >
        <DialogContent
          className="mounted-app-external-link-dialog"
          aria-describedby="mounted-app-external-link-description"
        >
          <DialogTitle>{t("mountedApp.openExternalLinkTitle")}</DialogTitle>
          <p className="mounted-app-external-link-description" id="mounted-app-external-link-description">
            {t("mountedApp.openExternalLinkBody")}
          </p>
          <div className="mounted-app-external-link-target">
            <span>{t("mountedApp.openExternalLinkOrigin")}</span>
            <strong>{pendingExternalLink?.origin}</strong>
            <small>{pendingExternalLink?.displayUrl}</small>
          </div>
          <div className="modal-actions">
            <Button onClick={() => settleExternalLink({ isError: true })}>{t("common.cancel")}</Button>
            <Button asChild variant="primary">
              <a
                href={pendingExternalLink?.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  // Let the anchor's browser-default navigation run before the
                  // resolved MCP request unmounts this confirmation portal.
                  window.setTimeout(() => settleExternalLink({}), 0);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  window.setTimeout(() => settleExternalLink({}), 0);
                }}
              >
                {t("mountedApp.openExternalLinkOpen")}
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={active && pendingFileDownload !== null}
        onOpenChange={(open) => {
          if (!open) settleFileDownload({ isError: true });
        }}
      >
        <DialogContent className="mounted-app-external-link-dialog" aria-describedby="mounted-app-download-description">
          <DialogTitle>{t("mountedApp.downloadFilesTitle")}</DialogTitle>
          <p className="mounted-app-external-link-description" id="mounted-app-download-description">
            {t("mountedApp.downloadFilesBody")}
          </p>
          <ul className="mounted-app-download-list">
            {pendingFileDownload?.files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <strong>{file.name}</strong>
                <small>{file.href ?? file.mimeType}</small>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button onClick={() => settleFileDownload({ isError: true })}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const files = pendingFileDownloadRef.current?.files ?? [];
                // 保存必须发生在这次用户点击的手势里,否则浏览器会拦下批量下载。
                const saved = files.every((file) => saveDownloadFile(file));
                settleFileDownload(saved ? {} : { isError: true });
              }}
            >
              {t("mountedApp.downloadFilesSave")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function saveDownloadFile(file: McpAppDownloadFile): boolean {
  let objectUrl = "";
  try {
    const anchor = document.createElement("a");
    if (file.href) {
      anchor.href = file.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } else {
      objectUrl = URL.createObjectURL(downloadFileBlob(file));
      anchor.href = objectUrl;
    }
    anchor.download = file.name;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

function downloadFileBlob(file: McpAppDownloadFile): Blob {
  if (typeof file.text === "string") return new Blob([file.text], { type: file.mimeType });
  const binary = atob(file.base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: file.mimeType });
}

function externalLinkDisplayUrl(url: URL): string {
  if (url.href.length <= MAX_EXTERNAL_LINK_DISPLAY_LENGTH) return url.href;
  return `${url.href.slice(0, MAX_EXTERNAL_LINK_DISPLAY_LENGTH - 1)}…`;
}

function createContractServer(appId: string, contract: McpAppContract, viewId?: string): Server {
  const server = new Server(
    { name: `opengrove-${appId}`, version: "1.0.0" },
    { capabilities: { resources: {}, tools: {} } },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: contract.resource.uri,
        name: `${appId} UI`,
        mimeType: contract.resource.mimeType,
        _meta: contract.resource._meta,
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== contract.resource.uri) throw new Error("mcp_app_resource_not_found");
    return { contents: [contract.resource] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [contract.launcherTool, ...contract.tools],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === contract.launcherTool.name) return launcherToolResult(appId);
    const response = await fetch(mcpAppApiUrl(appId, "call-tool", viewId), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      }),
    });
    const payload = (await response.json()) as { ok?: boolean; result?: CallToolResult; error?: string };
    if (!response.ok || !payload.ok || !payload.result) {
      return {
        isError: true,
        content: [{ type: "text", text: payload.error || `MCP App tool HTTP ${response.status}` }],
      };
    }
    return payload.result;
  });
  return server;
}

function launcherToolResult(appId: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${appId} MCP App ready` }],
    structuredContent: { appId, ready: true },
  };
}

function resolveMcpAppSandboxUrl(csp: McpAppContract["resource"]["_meta"]["ui"]["csp"]): string {
  const configuredOrigin = getClientBootstrap().mcpApps.sandboxOrigin;
  const bridgeUrl = new URL(apiUrl("/bootstrap"), window.location.href);
  let sandbox: URL;
  try {
    sandbox = new URL(
      resolveSandboxBaseUrl({
        bridgeBootstrapUrl: bridgeUrl.toString(),
        sandboxOrigin: configuredOrigin,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "mcp_app_sandbox_origin_required") {
      throw new Error(translate("mountedApp.mcpAppSandboxOriginRequired"));
    }
    throw error;
  }
  sandbox.searchParams.set("csp", JSON.stringify(csp));
  sandbox.searchParams.set("hostOrigin", sandboxHostOrigin());
  return sandbox.toString();
}

function sandboxHostOrigin(): string {
  if (window.location.origin && window.location.origin !== "null") return window.location.origin;
  const location = new URL(window.location.href);
  const customOrigin = `${location.protocol}//${location.host}`;
  if (!location.host) throw new Error(translate("mountedApp.mcpAppNoMessageChannel"));
  return customOrigin;
}

function mcpAppApiUrl(appId: string, action: "contract" | "call-tool", viewId?: string): string {
  const path = `/apps/${encodeURIComponent(appId)}/mcp-app/${action}`;
  return apiUrl(viewId ? `${path}?${new URLSearchParams({ view: viewId }).toString()}` : path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDesktopHost(): boolean {
  return Boolean((globalThis as typeof globalThis & { openGroveDesktop?: unknown }).openGroveDesktop);
}
