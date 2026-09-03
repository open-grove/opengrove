import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { clientBootstrapContract } from "#agent-protocol";
import { DIAGNOSTIC_RUN_WINDOW, sanitizeDiagnosticProblemRef } from "../../diagnostics/problem-schema.js";
import { createDiagnosticBundle } from "../../diagnostics/diagnostic-bundle.js";
import { createRunDiagnosticBundle, RunDiagnosticBundleError } from "../../diagnostics/run-diagnostic-bundle.js";
import { safeDiagnosticIdentifier } from "../../diagnostics/redaction.js";
import { APP_LOCAL_BRIDGE_NAME, readAppEnv } from "../../identity.js";
import { getBridgeCapabilitiesSnapshot } from "../capabilities.js";
import { buildContextRecords } from "../trajectory.js";
import { scanExtensionInventory } from "../../extensions/scanner.js";
import { problemRecordsRoot } from "../problem-records.js";
import { bridgeDataDirectory } from "../storage-paths.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { route } from "./registry-utils.js";
import { getClientBootstrap } from "../client-bootstrap.js";
import { readClientReleaseNumber, readInstalledPackageVersion, readPackageVersion } from "../client-release.js";
import { presentArtifactSummaries } from "../artifact-presentation.js";
import { appStoreDataRoot, currentAppStoreProgramsRoot, defaultAppStoreRoot } from "../app-store.js";
import { inspectStoreAppLayoutV2Diagnostics } from "../migrations/store-app-layout-v2-diagnostics.js";
import { legacyAppStoreProgramsRoot, legacyAppStoreRoot } from "../migrations/store-app-layout-v2.js";
import {
  presentExecutionSummaries,
  presentRunSummaries,
  presentSessionSummaries,
  presentSkillSummaries,
  presentToolSummaries,
  presentWorkingState,
} from "../state-presentation.js";

export function createCoreRoutes(): BridgeRoute[] {
  return [...createHealthRoutes(), ...createInventoryRoutes()];
}

function handleBootstrapRoute(context: BridgeRouteContext): boolean {
  context.sendJson(context.response, 200, getClientBootstrap(context.state, context.security));
  return true;
}

export function createHealthRoutes(): BridgeRoute[] {
  return [
    route("bootstrap", "GET", "/bootstrap", handleBootstrapRoute, clientBootstrapContract),
    route("health", "GET", "/health", handleHealthRoute),
    route("capabilities", "GET", "/capabilities", handleCapabilitiesRoute),
  ];
}

export function createInventoryRoutes(): BridgeRoute[] {
  return [
    route("inventory", "GET", "/inventory", handleInventoryRoute),
    route("context-records", "GET", "/context-records", handleContextRecordsRoute),
    route("diagnostics-summary", "GET", "/diagnostics/summary", handleDiagnosticsSummaryRoute),
    route("diagnostics-bundle", "GET", "/diagnostics/bundle", handleDiagnosticsBundleRoute),
    route("run-diagnostics-bundle", "GET", "/diagnostics/run-bundle", handleRunDiagnosticsBundleRoute),
  ];
}

async function handleHealthRoute(context: BridgeRouteContext): Promise<boolean> {
  const { response, state, security, sendJson } = context;
  const capabilities = getBridgeCapabilitiesSnapshot(state);
  if (security.authMode === "session") {
    capabilities.auth = "session";
    capabilities.multiUser = true;
  }
  sendJson(response, 200, {
    ok: true,
    name: APP_LOCAL_BRIDGE_NAME,
    time: new Date().toISOString(),
    capabilities,
    appearance: {
      systemTheme: detectSystemTheme(),
    },
    tokenRequired: security.authMode === "bridge-token" && Boolean(security.bridgeToken),
    auth: {
      mode: security.authMode,
    },
  });
  return true;
}

function handleCapabilitiesRoute(context: BridgeRouteContext): boolean {
  const capabilities = getBridgeCapabilitiesSnapshot(context.state);
  if (context.security.authMode === "session") {
    capabilities.auth = "session";
    capabilities.multiUser = true;
  }
  context.sendJson(context.response, 200, {
    ok: true,
    capabilities,
  });
  return true;
}

function handleInventoryRoute(context: BridgeRouteContext): boolean {
  const { response, state, sendJson } = context;
  const extensionInventory = mountedAppInventory(state);
  sendJson(response, 200, {
    ok: true,
    kernel: state.kernel,
    artifacts: presentArtifactSummaries(state.app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(state.app.workingState.get()),
    sessions: presentSessionSummaries(state.app.sessions.list({ limit: 100 })),
    runs: presentRunSummaries(state.app.sessions.listRuns({ limit: 200 })),
    executions: presentExecutionSummaries(state.app.executions.list({ limit: 200 })),
    skills: presentSkillSummaries(state.app.skills.list().slice(0, 500)),
    tools: presentToolSummaries(state.app.tools.specs().slice(0, 1_000)),
    mountedApps: extensionInventory,
  });
  return true;
}

function mountedAppInventory(state: BridgeRouteContext["state"]): {
  scannedAt: string;
  workspaceRoot: string;
  items: ReturnType<typeof scanExtensionInventory>["items"];
  deployments: ReturnType<typeof scanExtensionInventory>["deployments"];
} {
  const inventory = scanExtensionInventory(state);
  const items = inventory.items.filter((item) => item.kind === "app").slice(0, 500);
  const itemIds = new Set(items.map((item) => item.id));
  const deployments = inventory.deployments.filter((deployment) => itemIds.has(deployment.itemId));
  return {
    scannedAt: inventory.scannedAt,
    workspaceRoot: inventory.workspaceRoot,
    items,
    deployments,
  };
}

function handleContextRecordsRoute(context: BridgeRouteContext): boolean {
  const runId = context.url.searchParams.get("runId")?.trim();
  const revision = context.state.app.events.revision(
    runId ? (event) => event.runId === runId : undefined,
    runId || "recent",
  );
  if (context.url.searchParams.get("afterRevision") === revision) {
    context.sendJson(context.response, 200, { ok: true, unchanged: true, revision });
    return true;
  }
  const events = runId
    ? context.state.app.events.list((event) => event.runId === runId).slice(-500)
    : context.state.app.events.latest(500).events;
  context.sendJson(context.response, 200, {
    ok: true,
    records: buildContextRecords(events),
    revision,
  });
  return true;
}

function handleDiagnosticsSummaryRoute(context: BridgeRouteContext): boolean {
  context.sendJson(context.response, 200, buildDiagnosticsSummary(context));
  return true;
}

export function buildDiagnosticsSummary(context: Pick<BridgeRouteContext, "state">): Record<string, unknown> {
  const now = Date.now();
  const recentRuns = context.state.app.sessions.listRuns({ limit: 100 });
  const counts = {
    total: recentRuns.length,
    succeeded: recentRuns.filter((run) => run.lifecycle.taskState === "TASK_STATE_COMPLETED").length,
    failed: recentRuns.filter((run) => run.lifecycle.taskState === "TASK_STATE_FAILED").length,
    running: recentRuns.filter((run) => run.lifecycle.taskState === "TASK_STATE_WORKING").length,
    waiting: recentRuns.filter(
      (run) =>
        run.lifecycle.taskState === "TASK_STATE_INPUT_REQUIRED" ||
        run.lifecycle.taskState === "TASK_STATE_AUTH_REQUIRED",
    ).length,
    stalled: 0,
  };
  const failures = recentRuns.flatMap((run) => {
    const lastActivityAt = run.updatedAt || run.endedAt || run.startedAt;
    const lastActivityMs = Date.parse(lastActivityAt);
    const possiblyStalled =
      run.lifecycle.taskState === "TASK_STATE_WORKING" &&
      Number.isFinite(lastActivityMs) &&
      now - lastActivityMs >= 5 * 60_000;
    if (possiblyStalled) counts.stalled += 1;
    if (run.lifecycle.taskState !== "TASK_STATE_FAILED" && !possiblyStalled) return [];
    const startedAtMs = Date.parse(run.startedAt);
    const endedAtMs = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
    const durationMs =
      Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : undefined;
    const problem = sanitizeDiagnosticProblemRef(run.problem);
    return [
      {
        runId: safeDiagnosticIdentifier(run.id) ?? "unknown",
        lifecycle: run.lifecycle,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        endedAt: run.endedAt,
        ...(durationMs !== undefined ? { durationMs } : {}),
        eventCount: run.eventCount,
        possiblyStalled,
        ...(problem ? { problem } : {}),
      },
    ];
  });
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    window: DIAGNOSTIC_RUN_WINDOW,
    counts,
    failures: failures.slice(0, 50),
  };
}

async function handleDiagnosticsBundleRoute(context: BridgeRouteContext): Promise<boolean> {
  const dataDir = bridgeDataDirectory(context.state);
  const storeRoot = appStoreDataRoot(context.state);
  const configuredLogDir = readAppEnv("LOG_DIR")?.trim();
  const bundle = await createDiagnosticBundle({
    diagnosticsDir: problemRecordsRoot(context.state),
    logDirs: configuredLogDir ? [resolve(configuredLogDir)] : [join(dataDir, "logs"), join(dirname(dataDir), "logs")],
    bridgeStatus: {
      status: "running",
      pid: process.pid,
      mode: context.state.profile,
    },
    versions: {
      app: readPackageVersion() ?? "unknown",
      clientReleaseNumber: readClientReleaseNumber() ?? undefined,
      claudeAgentSdk: readInstalledPackageVersion("@anthropic-ai/claude-agent-sdk") ?? undefined,
      node: process.versions.node,
    },
    runDiagnostics: buildDiagnosticsSummary(context),
    storeAppLayout: inspectStoreAppLayoutV2Diagnostics({
      roots: {
        programsRoot: currentAppStoreProgramsRoot(storeRoot),
        workspacesRoot: defaultAppStoreRoot(),
        legacyProgramsRoot: legacyAppStoreProgramsRoot(storeRoot),
        legacyWorkspacesRoot: legacyAppStoreRoot(),
      },
      mountedApps: context.state.settings.mountedApps,
    }),
    secrets: context.security.bridgeToken ? [context.security.bridgeToken] : [],
  });
  context.response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${bundle.fileName}"`,
    "content-length": String(bundle.sizeBytes),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-opengrove-sha256": bundle.sha256,
    "x-opengrove-size": String(bundle.sizeBytes),
    "x-opengrove-evidence-complete": String(bundle.evidenceComplete),
  });
  context.response.end(bundle.archive);
  return true;
}

async function handleRunDiagnosticsBundleRoute(context: BridgeRouteContext): Promise<boolean> {
  const roomId = context.url.searchParams.get("roomId")?.trim() ?? "";
  const messageId = context.url.searchParams.get("messageId")?.trim() ?? "";
  if (!roomId || !messageId) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: "run_diagnostic_scope_required",
    });
    return true;
  }
  try {
    const bundle = await createRunDiagnosticBundle({
      state: context.state,
      roomId,
      messageId,
      secrets: context.security.bridgeToken ? [context.security.bridgeToken] : [],
    });
    context.response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${bundle.fileName}"`,
      "content-length": String(bundle.sizeBytes),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-opengrove-sha256": bundle.sha256,
      "x-opengrove-size": String(bundle.sizeBytes),
      "x-opengrove-evidence-complete": String(bundle.evidenceComplete),
    });
    context.response.end(bundle.archive);
  } catch (error) {
    if (!(error instanceof RunDiagnosticBundleError)) throw error;
    context.sendJson(context.response, error.status, {
      ok: false,
      error: error.code,
      detail: error.message,
    });
  }
  return true;
}

function detectSystemTheme(): "light" | "dark" {
  if (process.platform === "darwin") {
    try {
      const value = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 750,
      })
        .trim()
        .toLowerCase();
      return value.includes("dark") ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  if (process.platform === "win32") {
    try {
      const value = execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 750,
        },
      ).toLowerCase();
      return /\b0x0\b/.test(value) ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  try {
    const colorScheme = execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 750,
    }).toLowerCase();
    if (colorScheme.includes("dark")) return "dark";
  } catch {
    // non-critical-fallback: Desktops without gsettings use the light theme default below.
  }

  return "light";
}
