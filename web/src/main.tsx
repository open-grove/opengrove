import React, { type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { App } from "./app";
import { CloudAuthLoadingScreen } from "./components/app-shell/app-gates";
import { ConfirmProvider } from "./components/ui/confirm-dialog";
import { ToastProvider } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyDocumentIconStyle } from "./appearance";
import { applyDocumentLanguage, rawDiagnosticText, translate } from "./i18n";
import { startDocumentThemeSync } from "./theme";
import { loadClientBootstrapForRuntime } from "./runtime/client-bootstrap";
import { readDesktopApi, readDesktopBridgeStartupState, type OpenGroveDesktopApi } from "./desktop-api";
import { desktopBridgeReadyForBootstrap } from "./runtime/desktop-bootstrap-policy";

declare const __OPENGROVE_BUILD_ID__: string | undefined;

applyDocumentLanguage();
startDocumentThemeSync();
applyDocumentIconStyle();
installGlobalErrorLogging();
startBuildVersionWatcher();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 3_000,
    },
  },
});

class RootErrorBoundary extends React.Component<{ children: ReactNode }, { error: Error | undefined }> {
  state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[opengrove-ui] root render failed", {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className="app-fatal-error" role="alert">
        <div>
          <strong>{translate("shell.rootRenderFailedTitle")}</strong>
          <p>{translate("shell.rootRenderFailedCopy")}</p>
          <code>{rawDiagnosticText(this.state.error.message)}</code>
        </div>
      </main>
    );
  }
}

void renderApplication();

async function renderApplication() {
  const appWindow = window as typeof window & {
    __opengroveAppRoot?: Root;
  };
  const root = appWindow.__opengroveAppRoot ?? ReactDOM.createRoot(document.getElementById("root")!);
  appWindow.__opengroveAppRoot = root;
  try {
    const desktop = readDesktopApi();
    if (!desktopBridgeReadyForBootstrap(desktop)) {
      renderWithProviders(root, <DesktopBootstrapGate desktop={desktop!} />);
    }
    await loadClientBootstrapForRuntime(desktop);
    renderWithProviders(root, <App />);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <main className="app-fatal-error" role="alert">
        <div>
          <strong>{translate("shell.hostUnreachableTitle")}</strong>
          <p>{rawDiagnosticText(message)}</p>
        </div>
      </main>,
    );
  }
}

function renderWithProviders(root: Root, content: ReactNode) {
  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ToastProvider>
              <ConfirmProvider>{content}</ConfirmProvider>
            </ToastProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

function DesktopBootstrapGate({ desktop }: { desktop: OpenGroveDesktopApi }) {
  const [startupState, setStartupState] = React.useState(readDesktopBridgeStartupState(desktop));
  React.useEffect(() => desktop.onBridgeStartupStateChange?.(setStartupState), [desktop]);
  const blocker =
    startupState?.stage === "blocked"
      ? {
          code: startupState.code,
          message: startupState.message,
          actions: startupState.actions,
        }
      : undefined;
  return (
    <CloudAuthLoadingScreen
      blocker={blocker}
      recoveringLocalService
      migratingLocalData={startupState?.stage === "migrating"}
      onRetry={() => {
        void desktop.retryBridgeStartup?.();
      }}
    />
  );
}

function installGlobalErrorLogging() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    console.error("[opengrove-ui] uncaught error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: serializeErrorForConsole(event.error),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[opengrove-ui] unhandled rejection", serializeErrorForConsole(event.reason));
  });
}

function serializeErrorForConsole(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

function startBuildVersionWatcher() {
  if (typeof window === "undefined") return;
  const currentBuildId =
    typeof __OPENGROVE_BUILD_ID__ === "string"
      ? __OPENGROVE_BUILD_ID__
      : (document.querySelector<HTMLMetaElement>('meta[name="opengrove-build-id"]')?.content ?? "");
  if (!currentBuildId || currentBuildId === "dev") return;
  const versionUrl = new URL(/* @vite-ignore */ "../version.json", import.meta.url);
  const reloadAttemptKey = "opengrove-build-reload-target";
  const getReloadTarget = () => {
    try {
      return window.sessionStorage.getItem(reloadAttemptKey) ?? "";
    } catch {
      return "";
    }
  };
  const setReloadTarget = (buildId: string) => {
    try {
      window.sessionStorage.setItem(reloadAttemptKey, buildId);
      return true;
    } catch {
      return false;
    }
  };
  const clearReloadTarget = () => {
    try {
      window.sessionStorage.removeItem(reloadAttemptKey);
    } catch {
      // Session storage can be unavailable in locked-down browsers.
    }
  };
  let reloading = false;
  const checkVersion = async () => {
    if (reloading || document.hidden) return;
    try {
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { buildId?: unknown };
      const latestBuildId = typeof payload.buildId === "string" ? payload.buildId : "";
      if (latestBuildId && latestBuildId !== currentBuildId) {
        if (getReloadTarget() === latestBuildId) return;
        if (!setReloadTarget(latestBuildId)) return;
        reloading = true;
        window.location.reload();
        return;
      }
      if (latestBuildId === currentBuildId) clearReloadTarget();
    } catch {
      // Ignore transient network errors; the next tick will retry.
    }
  };
  window.setInterval(checkVersion, 20_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void checkVersion();
  });
}
