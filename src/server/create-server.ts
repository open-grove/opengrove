import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { APP_LOCAL_BRIDGE_NAME, readAppEnv } from "../identity.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateIdFor } from "../storage/state-identity.js";
import { type BridgeState, type LocalBridgeServerOptions } from "./bridge-types.js";
import { createBridgeState } from "./bridge-state.js";
import { isPublicBridgeRoute, normalizeBridgeApiUrl } from "./api-paths.js";
import { serveProtectedStaticRoute, servePublicStaticRoute } from "./routes/static.js";
import { startRoutineScheduler } from "./routine-scheduler.js";
import { createBridgeRoutes } from "./routes/bridge-registry.js";
import {
  applyCors,
  createBridgeSecurity,
  isLocalProbeRequest,
  isAllowedOrigin,
  authorizeBridgeRequest,
  loadLocalEnvFile,
} from "./bridge-security.js";
import { readJsonBody, sendJson } from "./http-utils.js";
import { BridgeContractViolation, dispatchBridgeRoutes } from "./router.js";
import { createTraceId, recordProblem } from "./problem-records.js";
import { isMcpAppSandboxRequest, serveMcpAppSandbox } from "./mcp-app-sandbox.js";
import { getAllBridgeProviderProfiles } from "./provider-profiles.js";
import { refreshProviderModelDiscovery } from "./provider-model-discovery.js";
import { refreshOpenClawGatewayProviders } from "./openclaw-provider-discovery.js";
import { closeImportedNativeFolderWatchers } from "./knowledge-imported-folders.js";
import { readClientReleaseNumber, readPackageVersion } from "./client-release.js";
import { internalBridgeBaseUrl } from "./internal-bridge-url.js";
import { cleanupStaleKernelLoginSessions } from "./kernel-login.js";
import { writeBridgeDiscoveryFile } from "./bridge-discovery.js";

export function startOpenGroveServer(options: LocalBridgeServerOptions = {}) {
  loadLocalEnvFile();
  cleanupStaleKernelLoginSessions();
  const host = options.host ?? readAppEnv("BRIDGE_HOST") ?? "127.0.0.1";
  const port = options.port ?? Number(readAppEnv("BRIDGE_PORT") ?? 37371);
  const security = createBridgeSecurity(options);
  if (options.runtimeEnvironment === "web-single" && !security.wwBaseUrl) {
    throw new Error("web-single requires OPENGROVE_WW_BASE_URL to use WW session authentication.");
  }
  const state = createBridgeState(options, security.authMode);
  void refreshOpenClawGatewayProviders(state);
  void refreshProviderModelDiscovery({
    profiles: getAllBridgeProviderProfiles(state.settings.customProviders),
  });
  // 发现缓存 12h 过期后读取端立即回落静态名单;长驻进程必须在过期前续期,
  // 否则名单会在运行中静默切换。6h 强刷一次,留足重试余量。
  const providerModelRefreshTimer = setInterval(
    () => {
      void refreshOpenClawGatewayProviders(state);
      void refreshProviderModelDiscovery({
        profiles: getAllBridgeProviderProfiles(state.settings.customProviders),
        force: true,
      });
    },
    6 * 60 * 60 * 1000,
  );
  providerModelRefreshTimer.unref();
  const stopRoutineScheduler = startRoutineScheduler(state);
  const bridgeRoutes = createBridgeRoutes();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (isMcpAppSandboxRequest(request, security)) {
      serveMcpAppSandbox(request, response, url, security);
      return;
    }
    applyCors(response, request, security);

    if (request.method === "OPTIONS") {
      response.writeHead(isLocalProbeRequest(request) || isAllowedOrigin(request.headers.origin, security) ? 204 : 403);
      response.end();
      return;
    }

    const routeUrl = normalizeBridgeApiUrl(url);
    const traceId = createTraceId(request.headers["x-opengrove-trace-id"]);
    response.setHeader("x-opengrove-trace-id", traceId);

    try {
      if (request.method === "GET" && routeUrl.pathname === "/opengrove-probe") {
        const desktopDevProfile = readAppEnv("DESKTOP_DEV_PROFILE")?.trim();
        sendJson(response, 200, {
          ok: true,
          product: "OpenGrove",
          name: APP_LOCAL_BRIDGE_NAME,
          profile: state.profile,
          authMode: security.authMode,
          requiresToken:
            security.authMode === "session" || (security.authMode === "bridge-token" && Boolean(security.bridgeToken)),
          stateId: state.store.kind === "json" || state.store.kind === "sqlite" ? stateIdFor(state.store.path) : null,
          ...(desktopDevProfile
            ? {
                desktopDevProfile: {
                  name: desktopDevProfile,
                  appStoreRegistryUrl: state.settings.appStore?.registryUrl,
                  releaseControlUrl: state.settings.appStore?.releaseControlUrl,
                },
              }
            : {}),
          ...bridgeProbeRuntimeMetadata(),
        });
        return;
      }

      if (!isAllowedOrigin(request.headers.origin, security)) {
        sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
        return;
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        servePublicStaticRoute(url, response, request.method === "HEAD")
      ) {
        return;
      }

      if (!isPublicBridgeRoute(routeUrl.pathname)) {
        const authorization = await authorizeBridgeRequest(request, response, security, state);
        if (!authorization.authorized) {
          const temporarilyUnavailable = authorization.status === "temporarily_unavailable";
          sendJson(response, temporarilyUnavailable ? 503 : 401, {
            ok: false,
            error:
              security.authMode === "session"
                ? temporarilyUnavailable
                  ? "session_temporarily_unavailable"
                  : "session_required"
                : "bridge_token_required",
          });
          return;
        }
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        serveProtectedStaticRoute(url, response, request.method === "HEAD")
      ) {
        return;
      }

      if (
        await dispatchBridgeRoutes(bridgeRoutes, {
          request,
          response,
          url: routeUrl,
          traceId,
          state,
          security,
          sendJson,
          readJsonBody,
          reportContractViolation: (violation) => {
            recordProblem(state, {
              traceId,
              category: "bridge",
              phase: "response_contract",
              code: violation.code,
              error: violation,
              context: {
                method: request.method ?? "GET",
                path: routeUrl.pathname,
                contractId: violation.contractId,
                issues: JSON.stringify(violation.issues),
              },
            });
          },
        })
      ) {
        return;
      }

      sendJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      if (error instanceof BridgeContractViolation && error.direction === "request") {
        sendJson(response, 400, {
          ok: false,
          error: error.code,
          contractId: error.contractId,
          issues: error.issues,
          traceId,
        });
        return;
      }
      const problem = recordProblem(state, {
        traceId,
        category: "bridge",
        phase: "request",
        code: "bridge_request_failed",
        error,
        context: {
          method: request.method ?? "GET",
          path: routeUrl.pathname,
        },
      });
      sendJson(response, 500, {
        ok: false,
        error:
          error instanceof BridgeContractViolation
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
        ...(error instanceof BridgeContractViolation
          ? {
              contractId: error.contractId,
              issues: error.issues,
            }
          : {}),
        incidentId: problem.incidentId,
        traceId,
      });
    }
  });
  server.on("close", stopRoutineScheduler);
  server.on("close", () => clearInterval(providerModelRefreshTimer));
  server.on("close", () => closeImportedNativeFolderWatchers(state));

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    state.internalBridgeBaseUrl = internalBridgeBaseUrl(host, boundPort);
    writeBridgeDiscoveryFile(state, { host, port: boundPort, startedAt: BRIDGE_PROCESS_STARTED_AT });
    console.log(
      `OpenGrove ${state.profile === "test" ? "test" : "local bridge"} listening on http://${host}:${boundPort}`,
    );
    options.onListening?.({
      host,
      port: boundPort,
      url: `http://${host}:${boundPort}`,
      statePath: state.store.path,
    });
  });
  attachStoreLifecycle(server, state);

  return server;
}

function attachStoreLifecycle(server: ReturnType<typeof createServer>, state: BridgeState): void {
  let storeClosing: Promise<void> | undefined;
  const closeStore = () => {
    storeClosing ??= (async () => {
      const { cancelAllActiveBridgeRuns, reconcileActiveBridgeRunsAsProducerLost, waitForActiveBridgeRuns } =
        await import("./active-runs.js");
      const { disposeBridgeKernelWorkers } = await import("./kernel-lifecycle.js");
      cancelAllActiveBridgeRuns(state);
      const remaining = await waitForActiveBridgeRuns(state, shutdownGraceMs());
      if (remaining.size > 0) {
        console.warn("bridge_shutdown_runs_outcome_unknown", { runIds: [...remaining] });
        reconcileActiveBridgeRunsAsProducerLost(state, remaining, "host_shutdown");
      }
      state.store.saveFrom(state.app);
      await state.store.flush?.();
      await disposeBridgeKernelWorkers(state);
      state.store.saveFrom(state.app);
      if (state.store.close) {
        await state.store.close();
      } else {
        await state.store.flush?.();
      }
    })();
    return storeClosing;
  };

  server.once("close", () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    void closeStore();
  });

  const closeHttpServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) =>
    closeHttpServer((error?: Error) => {
      void closeStore().then(
        () => callback?.(error),
        (closeError) => callback?.(closeError instanceof Error ? closeError : new Error(String(closeError))),
      );
    })) as typeof server.close;

  const shutdown = () => {
    server.close(() => {
      void (async () => {
        await closeStore();
        process.exit(0);
      })();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function shutdownGraceMs(): number {
  const value = Number(process.env.OPENGROVE_SHUTDOWN_GRACE_MS ?? 5_000);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 60_000) : 5_000;
}

const BRIDGE_PROCESS_STARTED_AT = new Date().toISOString();

function bridgeProbeRuntimeMetadata() {
  return {
    pid: process.pid,
    startedAt: BRIDGE_PROCESS_STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    build: {
      packageVersion: readPackageVersion(),
      clientReleaseNumber: readClientReleaseNumber(),
      gitSha: readGitSha(),
      modules: {
        createServer: fileMetadataForModule("./create-server.js"),
        roomDelegation: fileMetadataForModule("./room-delegation.js"),
        desktopBridgeEntry: fileMetadata(process.argv[1]),
      },
    },
  };
}

function readGitSha(): string | null {
  try {
    return (
      execFileSync("git", ["-C", process.cwd(), "rev-parse", "--short=12", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function fileMetadataForModule(relativePath: string) {
  const compiledPath = fileURLToPath(new URL(relativePath, import.meta.url));
  const sourcePath = compiledPath.endsWith(".js") ? compiledPath.slice(0, -3) + ".ts" : "";
  return fileMetadata(compiledPath) ?? fileMetadata(sourcePath);
}

function fileMetadata(path: string | undefined) {
  if (!path || !existsSync(path)) return null;
  try {
    const stat = statSync(path);
    return {
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startOpenGroveServer();
}
