import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { openLocalPath } from "../../local-path-actions.js";
import { scaffoldApp, validateAppRoot, ensureAppBuildContract } from "../../app-builder/cli.js";
import { findAppManifestPath, validateAppManifest } from "../../app-builder/manifest.js";
import { type AppUiSurface } from "../../app-builder/ui-runtime.js";
import { MCP_APP_MIGRATION_GUIDE, normalizeCompatibleAppUi } from "../../app-builder/compat/legacy-app-ui.compat.js";
import { normalizeAppIconValue } from "../../app-icons/icon-value.js";
import type { JsonObject } from "../../core.js";
import { hostMessage } from "../../localization/host-messages.js";
import type { SupportedLocale } from "../../localization/locale-registry.js";
import { importProjectAsApp } from "../../app-builder/importer.js";
import { listMountedAppFlows } from "../../app-builder/flow-discovery.js";
import { defaultAppStoreRoot } from "../app-store.js";
import { queueAppReadinessReport } from "../app-readiness.js";
import { findDefaultAppGroupRoom } from "../app-room-ids.js";
import { appBuilderMemberId } from "../bridge-mounted-app-employees.js";
import {
  mountedAppManifestIssue,
  mountedAppRuntimeFingerprint,
  readMountedAppManifest,
  resolveMountedAppTarget,
  type MountedAppTarget,
} from "../mounted-apps.js";
import { recreateBridgeApp } from "../bridge-state.js";
import { clearMountedAppUninstallMarkers, saveBridgeSettings } from "../bridge-settings-store.js";
import { APP_FILE_TEXT_SIZE_LIMIT, type BridgeState } from "../bridge-types.js";
import { AppReleaseValidationError, prepareMountedAppRelease } from "../app-release.js";
import { isRunnableRoomAssistantTarget, scheduleRoomAssistantRuns } from "../room-runs.js";
import {
  contentTypeForPath,
  LocalFilesystemWorkspaceStore,
  resolveExistingContainedPath,
  safeResolveInside,
  type WorkspaceStore,
} from "../workspace-store.js";
import { sendRawFileResponse } from "../raw-file-response.js";
import { readWwRuntimeAuth, type BridgeSecurity } from "../bridge-security.js";
import { migrateMountedAppManifestV1 } from "../migrations/app-manifest-v1.js";
import { callMountedMcpAppTool, createMountedMcpAppContract, McpAppToolError } from "../mcp-app-runtime.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { resolveAppManifestPresentation } from "../../app-builder/manifest-localization.js";
import { handleMountedAppVersionsRoute } from "./app-versions.js";
import { handleMountedAppReleaseRoute } from "./app-release.js";
import { localAppDraftStore, saveMountedAppDraft } from "../mounted-app-draft-service.js";

interface AppRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
  readJsonBody(request: IncomingMessage): Promise<unknown>;
}

const MAX_TREE_DEPTH = 8;
const MAX_TREE_ENTRIES = 1_200;
const MAX_FLOW_ENTRIES = 500;
const MAX_RAW_FILE_WRITE_BYTES = 2 * 1024 * 1024 * 1024;
const workspaceStore: WorkspaceStore = new LocalFilesystemWorkspaceStore();
type DashboardGrade = "good" | "warn" | "weak" | "unknown";
type NormalizedDashboardFunnelChapter = {
  chapter: number;
  label: string;
  uv?: number;
  reachPercent?: number;
  paid?: boolean;
  grade: DashboardGrade;
};

export async function handleAppsRoute(context: AppRouteContext): Promise<boolean> {
  if (context.url.pathname === "/apps/create") {
    await handleAppCreateRoute(context);
    return true;
  }
  const match = context.url.pathname.match(
    /^\/apps\/([^/]+)\/(runtime|identity|setup|employees|files|file|raw|mcp-app|file-system|flows|dashboard|draft|versions|publish)(?:\/(.*))?$/,
  );
  if (!match) return false;

  const appId = decodeURIComponent(match[1] || "");
  const action = match[2];
  const uiPath = match[3] || "";
  const target = resolveMountedAppTarget(context.state, appId);
  if (!target) {
    for (const mountedApp of context.state.settings.mountedApps ?? []) {
      if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
      const appRoot = resolve(mountedApp.path);
      const manifestRead = readMountedAppManifest(appRoot);
      const manifest = manifestRead.manifest ?? {};
      const manifestId = stringValue(manifest.id) || stringValue(manifest.name) || mountedApp.id;
      if (appId !== manifestId && appId !== `app:${manifestId}` && appId !== mountedApp.id) continue;
      const policyIssue = mountedAppManifestIssue(appRoot, manifestRead);
      if (!policyIssue) continue;
      context.sendJson(context.response, 409, {
        ok: false,
        error: policyIssue,
        issues: manifestRead.issues,
        message:
          "This App is isolated because its manifest is missing, invalid, unreadable, or still requires migration.",
        migrationGuide: MCP_APP_MIGRATION_GUIDE,
      });
      return true;
    }
    context.sendJson(context.response, 404, { ok: false, error: "app_not_found" });
    return true;
  }

  if (action === "runtime") {
    if (context.request.method === "GET") {
      context.sendJson(context.response, 200, mountedAppRuntimePayload(target));
      return true;
    }
    if (context.request.method === "PATCH") {
      try {
        const nextManifest = patchMountedAppRuntimeManifest(target, await context.readJsonBody(context.request));
        const nextTarget = { ...target, manifest: nextManifest };
        emitMountedAppRuntimeChanged(context.state, nextTarget);
        context.sendJson(context.response, 200, mountedAppRuntimePayload(nextTarget));
      } catch (error) {
        context.sendJson(context.response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  if (action === "draft") {
    await handleMountedAppDraftRoute(context, target, uiPath);
    return true;
  }

  if (action === "versions") {
    await handleMountedAppVersionsRoute(context, target, uiPath);
    return true;
  }

  if (action === "publish") {
    await handleMountedAppReleaseRoute(context, target, uiPath);
    return true;
  }

  if (action === "identity") {
    await handleMountedAppIdentityRoute(context, target);
    return true;
  }

  if (action === "setup") {
    await handleMountedAppSetupRoute(context, target);
    return true;
  }

  if (action === "employees") {
    await handleMountedAppEmployeeBindingRoute(context, target, uiPath);
    return true;
  }

  if (action === "mcp-app") {
    await handleMountedMcpAppRoute(context, target, uiPath);
    return true;
  }

  if (action === "dashboard") {
    await handleMountedAppDashboardRoute(context, target, uiPath);
    return true;
  }

  if (action === "flows") {
    if (context.request.method !== "GET") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    workspaceStore.ensureWorkspace(target.workspace);
    const flows = listMountedAppFlows(target.workspaceRoot, {
      maxEntries: MAX_FLOW_ENTRIES,
      maxDepth: MAX_TREE_DEPTH,
    });
    const revision = wireRevision(flows);
    if (context.url.searchParams.get("afterRevision") === revision) {
      context.sendJson(context.response, 200, {
        ok: true,
        app: publicAppTarget(target),
        revision,
        unchanged: true,
      });
      return true;
    }
    context.sendJson(context.response, 200, {
      ok: true,
      app: publicAppTarget(target),
      flows,
      revision,
      truncated: flows.length >= MAX_FLOW_ENTRIES,
    });
    return true;
  }

  if (action === "file-system") {
    if (context.request.method !== "POST") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (uiPath === "import-local-files") {
      await importMountedAppLocalFiles(context, target);
      return true;
    }
    if (uiPath === "open-local") {
      await openMountedAppLocalFile(context, target);
      return true;
    }
    try {
      const result = handleMountedAppFileSystemAction(
        target,
        uiPath,
        await context.readJsonBody(context.request),
        resolveHostLanguageSettings(context.state.settings),
      );
      const files = listMountedAppWorkspaceFiles(target);
      context.sendJson(context.response, 200, {
        ok: true,
        app: publicAppTarget(target),
        ...result,
        entries: files.entries,
        truncated: files.truncated,
      });
    } catch (error) {
      context.sendJson(context.response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const requestedPath = context.url.searchParams.get("path") ?? "";
  if (action === "raw" && context.request.method === "PUT") {
    await writeMountedAppRawFile(context, target, requestedPath);
    return true;
  }

  if (context.request.method !== "GET") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  if (action === "files") {
    workspaceStore.ensureWorkspace(target.workspace);
    const result = listMountedAppWorkspaceFiles(target);
    const revision = wireRevision(result.entries);
    if (context.url.searchParams.get("afterRevision") === revision) {
      context.sendJson(context.response, 200, {
        ok: true,
        app: publicAppTarget(target),
        path: "",
        revision,
        unchanged: true,
      });
      return true;
    }
    context.sendJson(context.response, 200, {
      ok: true,
      app: publicAppTarget(target),
      path: "",
      entries: result.entries,
      revision,
      truncated: result.truncated,
    });
    return true;
  }

  if (action === "raw") {
    const rawFile = workspaceStore.openRawFile(target.workspace, requestedPath);
    if (!rawFile) {
      context.sendJson(context.response, 404, { ok: false, error: "app_file_not_found" });
      return true;
    }
    sendRawFileResponse(context.request, context.response, rawFile, {
      download: context.url.searchParams.get("download") === "1",
    });
    return true;
  }

  const rawFile = workspaceStore.openRawFile(target.workspace, requestedPath);
  if (!rawFile) {
    context.sendJson(context.response, 404, { ok: false, error: "app_file_not_found" });
    return true;
  }
  const revision = wireRevision(rawFile.entry);
  if (context.url.searchParams.get("afterRevision") === revision) {
    context.sendJson(context.response, 200, {
      ok: true,
      app: publicAppTarget(target),
      revision,
      unchanged: true,
    });
    return true;
  }
  const file = workspaceStore.readFile(target.workspace, requestedPath, {
    textSizeLimit: APP_FILE_TEXT_SIZE_LIMIT,
  });
  if (!file) {
    context.sendJson(context.response, 404, { ok: false, error: "app_file_not_found" });
    return true;
  }
  context.sendJson(context.response, 200, {
    ok: true,
    app: publicAppTarget(target),
    file: {
      ...file.entry,
      content: file.content,
      contentTruncated: file.contentTruncated,
    },
    revision,
  });
  return true;
}

async function handleMountedAppDraftRoute(
  context: AppRouteContext,
  target: MountedAppTarget,
  routePath: string,
): Promise<void> {
  const store = localAppDraftStore(context.state);
  if (routePath === "prepare") {
    if (context.request.method !== "GET") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    try {
      const release = prepareMountedAppRelease({
        state: context.state,
        appId: target.id,
        registryPackages: [],
      });
      context.sendJson(context.response, 200, { ok: true, release });
    } catch (error) {
      context.sendJson(context.response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (routePath === "open") {
    if (context.request.method !== "POST") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    context.sendJson(context.response, 409, {
      ok: false,
      error: "local_app_draft_activation_requires_version_manager",
    });
    return;
  }
  if (routePath) {
    context.sendJson(context.response, 404, { ok: false, error: "local_app_draft_route_not_found" });
    return;
  }
  if (context.request.method === "GET") {
    try {
      const draft = store.read(target.localAppId);
      if (!draft) {
        context.sendJson(context.response, 404, { ok: false, error: "local_app_draft_not_found" });
        return;
      }
      context.sendJson(context.response, 200, { ok: true, draft });
    } catch (error) {
      context.sendJson(context.response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (context.request.method !== "PUT") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  try {
    const draft = saveMountedAppDraft({
      state: context.state,
      target,
      submission: await context.readJsonBody(context.request),
      store,
    });
    context.sendJson(context.response, 200, { ok: true, draft });
  } catch (error) {
    context.sendJson(context.response, error instanceof AppReleaseValidationError ? error.status : 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMountedAppEmployeeBindingRoute(
  context: AppRouteContext,
  target: MountedAppTarget,
  employeeId: string,
): Promise<void> {
  if (context.request.method !== "POST") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (employeeId !== "app-builder") {
    context.sendJson(context.response, 404, { ok: false, error: "employee_definition_not_found" });
    return;
  }
  const body = record(await context.readJsonBody(context.request));
  const roomId = stringValue(body.roomId);
  const room = context.state.app.rooms.getRoom(roomId);
  if (!room || room.kind !== "group" || room.archived || room.scope?.kind !== "app" || room.scope.appId !== target.id) {
    context.sendJson(context.response, 400, { ok: false, error: "app_group_room_required" });
    return;
  }

  const previousMountedApps = (context.state.settings.mountedApps ?? []).map((app) => ({ ...app }));
  const mountedApps = previousMountedApps.map((app) => ({ ...app }));
  const mountedAppIndex = mountedApps.findIndex((app) => app.id === target.id || resolve(app.path) === target.appRoot);
  if (mountedAppIndex < 0) {
    context.sendJson(context.response, 404, { ok: false, error: "app_not_found" });
    return;
  }
  mountedApps[mountedAppIndex] = {
    ...mountedApps[mountedAppIndex]!,
    appBuilderEnabled: true,
  };
  const rollbackBinding = () => {
    context.state.settings.mountedApps = previousMountedApps;
    try {
      recreateBridgeApp(context.state);
    } catch {
      // Preserve the original binding error; the next bridge reload will retry from saved settings.
    }
  };
  context.state.settings.mountedApps = mountedApps;
  try {
    recreateBridgeApp(context.state);
  } catch {
    rollbackBinding();
    context.sendJson(context.response, 500, { ok: false, error: "app_builder_binding_failed" });
    return;
  }

  const bindingId = appBuilderMemberId(target.id);
  const candidate = context.state.app.rooms.listMembers().find((member) => member.id === bindingId);
  const member = candidate?.disabled
    ? context.state.app.rooms.patchMember(bindingId, {
        disabled: false,
        status: "idle",
        lastActive: "已配置",
      })
    : candidate;
  if (!member) {
    rollbackBinding();
    context.sendJson(context.response, 500, { ok: false, error: "app_builder_binding_failed" });
    return;
  }
  context.state.app.rooms.addMember(roomId, member);
  saveBridgeSettings(context.state);
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, {
    ok: true,
    member,
    currentEventSeq: context.state.app.rooms.snapshot().currentEventSeq,
  });
}

async function handleMountedMcpAppRoute(
  context: AppRouteContext,
  target: MountedAppTarget,
  routePath: string,
): Promise<void> {
  const viewId = context.url.searchParams.get("view")?.trim() || undefined;
  if (routePath === "contract" && context.request.method === "GET") {
    try {
      const requestOrigin = requestPublicOrigin(context.request, context.url);
      const sandboxOrigin = context.security?.mcpAppSandboxOrigin;
      const wwOrigin = context.security?.wwBaseUrl;
      context.sendJson(context.response, 200, {
        ok: true,
        contract: createMountedMcpAppContract(
          target,
          [requestOrigin, sandboxOrigin ?? "", wwOrigin ?? ""].filter(Boolean),
          viewId,
        ),
      });
    } catch (error) {
      context.sendJson(context.response, 422, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (routePath === "call-tool" && context.request.method === "POST") {
    const payload = record(await context.readJsonBody(context.request));
    try {
      const toolName = stringValue(payload.name);
      // Reading the signed-in WW session is limited to declared command execution.
      // resolveMountedAppRuntimeEnv applies the second, manifest-level wwAuth gate.
      const wwAuth =
        toolName === "opengrove.app.command.run" && context.security
          ? (await readWwRuntimeAuth(context.request, context.response, context.security))?.auth
          : undefined;
      const result = await callMountedMcpAppTool(context.state, target, toolName, payload.arguments, {
        wwAuth,
        viewId,
      });
      context.sendJson(context.response, 200, { ok: true, result });
    } catch (error) {
      context.sendJson(context.response, error instanceof McpAppToolError ? error.status : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  context.sendJson(context.response, 404, { ok: false, error: "mcp_app_route_not_found" });
}

function requestPublicOrigin(request: IncomingMessage, url: URL): string {
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const host = forwardedHost || request.headers.host || url.host;
  const protocol = forwardedProto || url.protocol.replace(/:$/u, "") || "http";
  if (protocol !== "http" && protocol !== "https") return url.origin;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || "";
}

async function handleMountedAppDashboardRoute(
  context: AppRouteContext,
  target: MountedAppTarget,
  routePath = "",
): Promise<void> {
  const normalizedRoutePath = routePath.replace(/^\/+|\/+$/g, "");
  if (normalizedRoutePath === "refresh") {
    await handleMountedAppDashboardRefreshRoute(context, target);
    return;
  }
  if (normalizedRoutePath) {
    context.sendJson(context.response, 404, { ok: false, error: "dashboard_route_not_found" });
    return;
  }
  if (context.request.method !== "GET") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    context.sendJson(context.response, 200, await readMountedAppDashboard(context, target));
  } catch (error) {
    sendMountedAppDashboardProxyError(context, target, error);
  }
}

async function handleMountedAppDashboardRefreshRoute(
  context: AppRouteContext,
  target: MountedAppTarget,
): Promise<void> {
  if (context.request.method !== "POST") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const dashboardIndex = requestedDashboardIndex(context);
  const sourceType = stringValue(mountedAppDashboardSource(target, dashboardIndex).type);
  if (sourceType === "local_json") {
    context.sendJson(context.response, 200, await readMountedAppDashboard(context, target));
    return;
  }
  const refreshEndpoint = mountedAppDashboardRefreshEndpoint(target, dashboardIndex);
  if (!isAbsoluteHttpUrl(refreshEndpoint)) {
    context.sendJson(context.response, 409, { ok: false, error: "dashboard_refresh_not_configured" });
    return;
  }
  try {
    await fetchMountedAppJsonEndpoint(refreshEndpoint, "POST");
    context.sendJson(context.response, 200, await readMountedAppDashboard(context, target));
  } catch (error) {
    sendMountedAppDashboardProxyError(context, target, error);
  }
}

async function readMountedAppDashboard(context: AppRouteContext, target: MountedAppTarget) {
  const dashboardIndex = requestedDashboardIndex(context);
  const sourceConfig = mountedAppDashboardSource(target, dashboardIndex);
  if (stringValue(sourceConfig.type) === "local_json") {
    const dashboard = normalizeDashboardPayload(
      readMountedAppLocalDashboardJson(target, sourceConfig),
      target,
      "cloud",
      resolveHostLanguageSettings(context.state.settings),
    );
    return dashboard ?? emptyMountedAppDashboard(target);
  }
  const endpoint = mountedAppDashboardEndpoint(target, dashboardIndex);
  if (!isAbsoluteHttpUrl(endpoint)) {
    return emptyMountedAppDashboard(target);
  }
  const rawPayload = await fetchMountedAppJsonEndpoint(endpoint, "GET");
  const dashboard = normalizeDashboardPayload(
    rawPayload,
    target,
    "cloud",
    resolveHostLanguageSettings(context.state.settings),
  );
  return dashboard ?? emptyMountedAppDashboard(target);
}

// App commands can refresh dashboards written as workspace files; those tabs
// read locally instead of through an HTTP endpoint.
function readMountedAppLocalDashboardJson(target: MountedAppTarget, sourceConfig: Record<string, unknown>): unknown {
  const relativePath = stringValue(sourceConfig.path);
  if (!relativePath) return undefined;
  const file = resolveExistingContainedPath(target.workspaceRoot, relativePath);
  if (!file) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeMountedAppRawFile(
  context: AppRouteContext,
  target: MountedAppTarget,
  rawRequestedPath: string,
): Promise<void> {
  workspaceStore.ensureWorkspace(target.workspace);
  const requestedPath = safeAppRelativePath(rawRequestedPath);
  if (!requestedPath) {
    context.sendJson(context.response, 400, { ok: false, error: "app_file_path_required" });
    return;
  }

  const declaredLength = Number.parseInt(String(context.request.headers["content-length"] ?? "0"), 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RAW_FILE_WRITE_BYTES) {
    context.sendJson(context.response, 413, { ok: false, error: "app_file_too_large" });
    return;
  }

  let destination = safeResolveInside(target.workspaceRoot, requestedPath);
  if (!destination) {
    context.sendJson(context.response, 400, { ok: false, error: "app_file_path_invalid" });
    return;
  }

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  if (!statSync(parent).isDirectory()) {
    context.sendJson(context.response, 400, { ok: false, error: "app_file_parent_not_directory" });
    return;
  }

  if (context.url.searchParams.get("unique") === "1") {
    destination = uniqueUploadedFilePath(parent, basename(destination));
  }

  try {
    if (existsSync(destination) && statSync(destination).isDirectory()) {
      context.sendJson(context.response, 400, { ok: false, error: "app_file_target_is_directory" });
      return;
    }
  } catch {
    context.sendJson(context.response, 400, { ok: false, error: "app_file_target_invalid" });
    return;
  }

  const tempPath = `${destination}.upload-${process.pid}-${Date.now()}.tmp`;
  try {
    await pipeline(context.request, createWriteStream(tempPath, { flags: "wx" }));
    renameSync(tempPath, destination);
    const files = listMountedAppWorkspaceFiles(target);
    context.sendJson(context.response, 200, {
      ok: true,
      app: publicAppTarget(target),
      entry: publicEntry(target.workspaceRoot, destination),
      entries: files.entries,
      truncated: files.truncated,
    });
  } catch (error) {
    rmSync(tempPath, { force: true });
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function importMountedAppLocalFiles(context: AppRouteContext, target: MountedAppTarget): Promise<void> {
  workspaceStore.ensureWorkspace(target.workspace);
  const payload = record(await context.readJsonBody(context.request));
  const parentPath = safeAppRelativePath(payload.parentPath);
  const parent = safeResolveInside(target.workspaceRoot, parentPath) ?? target.workspaceRoot;
  mkdirSync(parent, { recursive: true });
  if (!statSync(parent).isDirectory()) {
    context.sendJson(context.response, 400, { ok: false, error: "app_file_parent_not_directory" });
    return;
  }

  let selectedPaths: string[];
  try {
    selectedPaths = await chooseImportFiles(resolveHostLanguageSettings(context.state.settings));
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let latestEntry: ReturnType<typeof publicEntry> | undefined;
  for (const sourcePath of selectedPaths) {
    let sourceStat: ReturnType<typeof statSync>;
    try {
      sourceStat = statSync(sourcePath);
    } catch (error) {
      context.sendJson(context.response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!sourceStat.isFile()) continue;
    if (sourceStat.size > MAX_RAW_FILE_WRITE_BYTES) {
      context.sendJson(context.response, 413, { ok: false, error: "app_file_too_large" });
      return;
    }

    const destination = uniqueUploadedFilePath(parent, safeFileName(basename(sourcePath)));
    const tempPath = `${destination}.import-${process.pid}-${Date.now()}.tmp`;
    try {
      copyFileSync(sourcePath, tempPath);
      renameSync(tempPath, destination);
      latestEntry = publicEntry(target.workspaceRoot, destination);
    } catch (error) {
      rmSync(tempPath, { force: true });
      context.sendJson(context.response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const files = listMountedAppWorkspaceFiles(target);
  context.sendJson(context.response, 200, {
    ok: true,
    app: publicAppTarget(target),
    entry: latestEntry,
    entries: files.entries,
    truncated: files.truncated,
  });
}

async function openMountedAppLocalFile(context: AppRouteContext, target: MountedAppTarget): Promise<void> {
  try {
    const payload = record(await context.readJsonBody(context.request));
    const requestedPath = safeAppRelativePath(payload.path);
    if (!requestedPath) {
      context.sendJson(context.response, 400, { ok: false, error: "app_file_path_required" });
      return;
    }
    const filePath = resolveExistingContainedPath(target.workspaceRoot, requestedPath);
    if (!filePath) {
      context.sendJson(context.response, 404, { ok: false, error: "app_file_not_found" });
      return;
    }
    const targetMode = stringValue(payload.target) || "finder";
    await openLocalPath(filePath, targetMode === "system" ? "system" : "reveal");
    context.sendJson(context.response, 200, { ok: true, target: targetMode });
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleMountedAppFileSystemAction(
  target: MountedAppTarget,
  rawAction: string,
  body: unknown,
  language: SupportedLocale = "en",
) {
  workspaceStore.ensureWorkspace(target.workspace);
  const payload = record(body);
  const action = rawAction || "create";
  if (action === "create") {
    return createMountedAppEntry(target, payload, language);
  }
  if (action === "move") {
    return moveMountedAppEntry(target, payload);
  }
  if (action === "rename") {
    return renameMountedAppEntry(target, payload);
  }
  if (action === "delete") {
    return deleteMountedAppEntry(target, payload);
  }
  throw new Error("app_file_system_action_unknown");
}

function listMountedAppWorkspaceFiles(target: MountedAppTarget) {
  return workspaceStore.listFiles(target.workspace, {
    maxDepth: MAX_TREE_DEPTH,
    maxEntries: MAX_TREE_ENTRIES,
    ignoredNames: mountedAppWorkspaceIgnoredNames(target),
  });
}

function wireRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function mountedAppWorkspaceIgnoredNames(target: MountedAppTarget): string[] {
  const workspace = record(target.manifest.workspace);
  const ui = record(target.manifest.ui);
  const workspaceFileTree = record(workspace.fileTree);
  const uiFileTree = record(ui.fileTree);
  const names = [
    ...stringArray(workspace.ignoredNames),
    ...stringArray(workspace.ignoreNames),
    ...stringArray(workspaceFileTree.ignoredNames),
    ...stringArray(workspaceFileTree.ignoreNames),
    ...stringArray(workspaceFileTree.ignore),
    ...stringArray(workspaceFileTree.hiddenNames),
    ...stringArray(uiFileTree.ignoredNames),
    ...stringArray(uiFileTree.ignoreNames),
    ...stringArray(uiFileTree.ignore),
    ...stringArray(uiFileTree.hiddenNames),
  ];
  return Array.from(new Set(names));
}

function createMountedAppEntry(target: MountedAppTarget, payload: Record<string, unknown>, language: SupportedLocale) {
  const kind = stringValue(payload.kind) === "folder" ? "folder" : "file";
  const parentPath = safeAppRelativePath(payload.parentPath);
  const parent = safeResolveInside(target.workspaceRoot, parentPath);
  if (!parent) throw new Error("app_file_parent_path_invalid");
  mkdirSync(parent, { recursive: true });
  if (!statSync(parent).isDirectory()) throw new Error("app_file_parent_not_directory");

  const requestedName = safeFileName(
    stringValue(payload.name) ||
      (kind === "folder"
        ? hostMessage(language, "workspace.new_folder")
        : hostMessage(language, "workspace.untitled_markdown")),
  );
  const nextName = kind === "folder" ? requestedName : ensureFileExtension(requestedName, ".md");
  const destination = kind === "folder" ? uniqueDirectoryPath(parent, nextName) : uniqueFilePath(parent, nextName);
  if (kind === "folder") {
    mkdirSync(destination, { recursive: true });
  } else {
    writeFileSync(destination, stringValue(payload.content), "utf8");
  }
  return { entry: publicEntry(target.workspaceRoot, destination) };
}

function moveMountedAppEntry(target: MountedAppTarget, payload: Record<string, unknown>) {
  const sourcePath = safeAppRelativePath(payload.sourcePath);
  const targetParentPath = safeAppRelativePath(payload.targetParentPath);
  if (!sourcePath || !targetParentPath || sourcePath === targetParentPath)
    throw new Error("app_file_move_path_invalid");
  if (targetParentPath === sourcePath || targetParentPath.startsWith(`${sourcePath}/`)) {
    throw new Error("app_file_move_into_self_not_allowed");
  }
  const source = existingAppPath(target.workspaceRoot, sourcePath);
  const targetParent = safeResolveInside(target.workspaceRoot, targetParentPath);
  if (!targetParent) throw new Error("app_file_target_path_invalid");
  mkdirSync(targetParent, { recursive: true });
  if (!statSync(targetParent).isDirectory()) throw new Error("app_file_target_not_directory");
  const sourceStat = statSync(source);
  const destination = sourceStat.isDirectory()
    ? uniqueDirectoryPath(targetParent, basename(source))
    : uniqueFilePath(targetParent, basename(source));
  if (resolve(dirname(source)) !== resolve(targetParent)) {
    renameSync(source, destination);
  }
  return { entry: publicEntry(target.workspaceRoot, destination) };
}

function renameMountedAppEntry(target: MountedAppTarget, payload: Record<string, unknown>) {
  const sourcePath = safeAppRelativePath(payload.sourcePath);
  if (!sourcePath) throw new Error("app_file_source_path_required");
  const source = existingAppPath(target.workspaceRoot, sourcePath);
  const sourceStat = statSync(source);
  const requestedName = safeFileName(stringValue(payload.name) || basename(source));
  const nextName = sourceStat.isDirectory()
    ? requestedName
    : ensureFileExtension(requestedName, extname(source) || ".md");
  const parent = dirname(source);
  const destination = sourceStat.isDirectory()
    ? uniqueDirectoryPath(parent, nextName, source)
    : uniqueFilePath(parent, nextName, source);
  if (resolve(source) !== resolve(destination)) {
    renameSync(source, destination);
  }
  return { entry: publicEntry(target.workspaceRoot, destination) };
}

function deleteMountedAppEntry(target: MountedAppTarget, payload: Record<string, unknown>) {
  const sourcePath = safeAppRelativePath(payload.sourcePath);
  if (!sourcePath) throw new Error("app_file_delete_path_required");
  const source = existingAppPath(target.workspaceRoot, sourcePath);
  rmSync(source, { recursive: true, force: false });
  return { deletedPath: sourcePath };
}

export function publicAppTarget(target: MountedAppTarget) {
  return {
    id: target.id,
    title: target.title,
    appRoot: target.appRoot,
    workspaceRoot: target.workspaceRoot,
    workspaceKind: target.workspace.kind,
  };
}

function mountedAppRuntimePayload(target: MountedAppTarget) {
  const setup = record(record(target.manifest.ui).setup);
  const setupChoice = stringValue(setup.choice);
  return {
    ok: true,
    app: publicAppTarget(target),
    ui: normalizeCompatibleAppUi(target.manifest),
    revision: mountedAppRuntimeFingerprint(target),
    setup: {
      choice: setupChoice === "file-workbench" || setupChoice === "view" ? setupChoice : undefined,
      selectedAt: stringValue(setup.selectedAt) || undefined,
    },
  };
}

async function handleMountedAppSetupRoute(context: AppRouteContext, target: MountedAppTarget): Promise<void> {
  if (context.request.method !== "POST") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (normalizeCompatibleAppUi(target.manifest).surface !== "setup") {
    context.sendJson(context.response, 409, { ok: false, error: "app_not_in_setup" });
    return;
  }
  const body = record(await context.readJsonBody(context.request));
  const choice = stringValue(body.choice);
  if (choice !== "file-workbench" && choice !== "view") {
    context.sendJson(context.response, 400, { ok: false, error: "app_setup_choice_invalid" });
    return;
  }

  try {
    const selectedAt = new Date().toISOString();
    if (choice === "file-workbench") {
      // Leaving setup must complete the deterministic build contract so the
      // App is trusted-publishable without any extra authoring step.
      ensureAppBuildContract(target.appRoot);
    }
    const nextManifest =
      choice === "file-workbench"
        ? writeMountedAppManifestUpdate(target, (manifest) => setManifestUiSurface(manifest, "file-workbench"))
        : writeMountedAppManifestUpdate(target, (manifest) => {
            const ui = record(manifest.ui);
            manifest.ui = {
              ...ui,
              surface: "setup",
              setup: { choice: "view", selectedAt },
            } as JsonObject;
          });
    const nextTarget = { ...target, manifest: nextManifest };
    emitMountedAppRuntimeChanged(context.state, nextTarget);
    const scheduled = recordSetupChoiceInRoom(context.state, target, choice);
    context.sendJson(context.response, 200, {
      ...mountedAppRuntimePayload(nextTarget),
      builderScheduled: scheduled,
    });
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMountedAppIdentityRoute(context: AppRouteContext, target: MountedAppTarget): Promise<void> {
  if (context.request.method === "GET") {
    context.sendJson(
      context.response,
      200,
      mountedAppIdentityPayload(target, resolveHostLanguageSettings(context.state.settings)),
    );
    return;
  }
  if (context.request.method !== "PATCH") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  const body = record(await context.readJsonBody(context.request));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title || title.length > 200 || description.length > 40_000) {
    context.sendJson(context.response, 400, { ok: false, error: "app_identity_invalid" });
    return;
  }
  const hasIcon = Object.prototype.hasOwnProperty.call(body, "icon");
  const requestedIcon =
    hasIcon && body.icon !== null && body.icon !== "" ? normalizeAppIconValue(body.icon) : undefined;
  if (hasIcon && body.icon !== null && body.icon !== "" && !requestedIcon) {
    context.sendJson(context.response, 400, { ok: false, error: "app_icon_invalid" });
    return;
  }
  try {
    const nextManifest = writeMountedAppManifestUpdate(target, (manifest) => {
      manifest.title = title;
      manifest.description = description;
      if (hasIcon) {
        if (requestedIcon) manifest.icon = requestedIcon;
        else delete manifest.icon;
      }
    });
    const nextTarget = { ...target, title, manifest: nextManifest };
    emitMountedAppRuntimeChanged(context.state, nextTarget);
    context.sendJson(
      context.response,
      200,
      mountedAppIdentityPayload(nextTarget, resolveHostLanguageSettings(context.state.settings)),
    );
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function mountedAppIdentityPayload(target: MountedAppTarget, language: SupportedLocale): Record<string, unknown> {
  const presentation = resolveAppManifestPresentation(target.manifest, language);
  return {
    ok: true,
    app: {
      id: target.id,
      title: presentation.title || target.title,
      description: presentation.description,
      ...(stringValue(target.manifest.icon) ? { icon: stringValue(target.manifest.icon) } : {}),
    },
  };
}

function emitMountedAppRuntimeChanged(state: BridgeState, target: MountedAppTarget): void {
  const normalized = normalizeCompatibleAppUi(target.manifest);
  state.app.events.append({
    type: "runtime.diagnostic",
    runId: `app-runtime:${target.id}`,
    at: new Date().toISOString(),
    name: "app.runtime-changed",
    data: {
      appId: target.id,
      surface: normalized.surface,
      revision: mountedAppRuntimeFingerprint(target),
    },
  });
  state.store.saveFrom(state.app);
}

function patchMountedAppRuntimeManifest(target: MountedAppTarget, rawPatch: unknown): JsonObject {
  const patch = record(rawPatch);
  const surface = stringValue(patch.surface);
  if (surface !== "file-workbench" && surface !== "view" && surface !== "none") {
    throw new Error("app_ui_surface_patch_invalid");
  }
  return writeMountedAppManifestUpdate(target, (manifest) => {
    setManifestUiSurface(manifest, surface, patch.view);
  });
}

function setManifestUiSurface(manifest: JsonObject, surface: Exclude<AppUiSurface, "setup">, rawView?: unknown): void {
  const ui = record(manifest.ui);
  delete ui.entry;
  delete ui.tools;
  delete ui.csp;
  delete ui.permissions;
  delete ui.setup;
  manifest.ui = {
    ...ui,
    surface,
    ...(surface === "view" ? { view: record(rawView) as JsonObject } : {}),
  } as JsonObject;
  if (surface !== "view") delete record(manifest.ui).view;
}

function writeMountedAppManifestUpdate(target: MountedAppTarget, update: (manifest: JsonObject) => void): JsonObject {
  const manifestPath = findAppManifestPath(target.appRoot);
  if (!manifestPath) throw new Error("app_manifest_missing");
  const manifest = structuredClone(target.manifest);
  update(manifest);
  const validation = validateAppManifest(manifest);
  if (!validation.ok || !validation.manifest) {
    throw new Error(`app_manifest_patch_invalid:${validation.issues.join(";")}`);
  }

  const tempPath = join(dirname(manifestPath), `.${basename(manifestPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    chmodSync(tempPath, statSync(manifestPath).mode & 0o777);
    renameSync(tempPath, manifestPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return manifest;
}

function recordSetupChoiceInRoom(
  state: BridgeState,
  target: MountedAppTarget,
  choice: "file-workbench" | "view",
): boolean {
  const room = findDefaultAppGroupRoom(state.app.rooms.listRooms(), target.id);
  if (!room) return false;
  const roomId = room.id;
  const builder = state.app.rooms
    .listMembers()
    .find((member) => member.id === appBuilderMemberId(target.id) && !member.disabled);
  const originalDescription = stringValue(target.manifest.description);
  const language = resolveHostLanguageSettings(state.settings);
  const prompt = hostMessage(
    language,
    choice === "file-workbench"
      ? "app.setup.file_workbench_choice"
      : originalDescription
        ? "app.setup.custom_choice_with_description"
        : "app.setup.custom_choice",
    {
      title: target.title,
      description: originalDescription,
    },
  );
  const runnableBuilder = builder && isRunnableRoomAssistantTarget(builder) ? builder : undefined;
  const posted = state.app.rooms.postUserMessage({
    roomId,
    text: prompt,
    targetIds: builder ? [builder.id] : [],
    assistantTargets: choice === "view" && runnableBuilder ? [runnableBuilder] : [],
    deliveryKind: "user_direct",
  });
  if (choice === "view" && !runnableBuilder) {
    state.app.rooms.postSystemMessage({
      roomId,
      text: hostMessage(language, "app.setup.builder_unavailable"),
    });
    state.store.saveFrom(state.app);
    return false;
  }
  if (choice === "view" && runnableBuilder) {
    const scheduled = scheduleRoomAssistantRuns(state, {
      roomId,
      triggerMessageId: posted.userMessage.id,
      targets: [runnableBuilder],
      assistantMessages: posted.assistantMessages,
    });
    state.store.saveFrom(state.app);
    return Boolean(scheduled[0]?.runId);
  }
  state.store.saveFrom(state.app);
  return false;
}

async function handleAppCreateRoute(context: AppRouteContext): Promise<void> {
  if (context.request.method !== "POST") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  const body = record(await context.readJsonBody(context.request));
  const title = stringValue(body.title);
  const description = stringValue(body.description);
  const source = stringValue(body.source);
  const requestedIcon = body.icon === undefined ? undefined : normalizeAppIconValue(body.icon);
  if (body.icon !== undefined && !requestedIcon) {
    context.sendJson(context.response, 400, { ok: false, error: "app_icon_invalid" });
    return;
  }
  if (!title && !source) {
    context.sendJson(context.response, 400, { ok: false, error: "app_title_or_source_required" });
    return;
  }

  let appRoot: string;
  try {
    if (source) {
      // Import path: only local directories are handled inline; URL staging stays with the agent flow.
      const sourceRoot = resolve(source);
      if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        context.sendJson(context.response, 400, { ok: false, error: "app_source_must_be_local_directory" });
        return;
      }
      let existingManifestRead = readMountedAppManifest(sourceRoot);
      if (existingManifestRead.status !== "valid" && existingManifestRead.status !== "missing") {
        context.sendJson(context.response, 422, {
          ok: false,
          error: mountedAppManifestIssue(sourceRoot, existingManifestRead),
          issues: existingManifestRead.issues,
          appRoot: sourceRoot,
        });
        return;
      }
      if (existingManifestRead.manifest) {
        const migration = migrateMountedAppManifestV1(sourceRoot);
        if (migration.status === "failed" || migration.status === "invalid" || migration.status === "missing") {
          context.sendJson(context.response, 422, {
            ok: false,
            error: "app_manifest_migration_failed",
            issues: migration.issues ?? [],
            appRoot: sourceRoot,
          });
          return;
        }
        existingManifestRead = readMountedAppManifest(sourceRoot);
      }
      const existingManifest = existingManifestRead.manifest;
      if (existingManifest && (stringValue(existingManifest.id) || stringValue(existingManifest.name))) {
        // Already an OpenGrove App: mount it in place.
        appRoot = sourceRoot;
      } else {
        const imported = importProjectAsApp(sourceRoot, {
          // Profile-aware target directory resolved by the running bridge
          // (OPENGROVE_APP_STORE_APPS_DIR), never a fresh default guess.
          appsDir: defaultAppStoreRoot(),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
        });
        appRoot = imported.appRoot;
      }
    } else {
      const id = appIdFromTitle(title);
      appRoot = join(defaultAppStoreRoot(), id);
      if (existsSync(appRoot) && readdirSync(appRoot).length > 0) {
        context.sendJson(context.response, 409, { ok: false, error: "app_directory_already_exists", appRoot });
        return;
      }
      scaffoldApp(appRoot, {
        id,
        title,
        ...(requestedIcon ? { icon: requestedIcon } : {}),
        ...(description ? { description } : {}),
      });
    }
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const validation = validateAppRoot(appRoot);
  if (!validation.ok) {
    context.sendJson(context.response, 422, { ok: false, error: "app_not_valid", issues: validation.issues, appRoot });
    return;
  }

  const manifestRead = readMountedAppManifest(appRoot);
  const manifestIssue = mountedAppManifestIssue(appRoot, manifestRead);
  if (manifestIssue || !manifestRead.manifest) {
    context.sendJson(context.response, 422, {
      ok: false,
      error: manifestIssue ?? "app_manifest_invalid",
      issues: manifestRead.issues,
      appRoot,
    });
    return;
  }
  const manifest = manifestRead.manifest;
  const appId = stringValue(manifest.id) || stringValue(manifest.name) || basename(appRoot);
  const appTitle = stringValue(manifest.title) || title || appId;
  const mountedApps = (context.state.settings.mountedApps ?? []).map((app) => ({ ...app }));
  const existingIndex = mountedApps.findIndex((app) => app.id === appId || resolve(app.path) === appRoot);
  const appBuilderEnabled = existingIndex >= 0 ? mountedApps[existingIndex]?.appBuilderEnabled === true : !source;
  if (existingIndex >= 0) {
    mountedApps[existingIndex] = {
      ...mountedApps[existingIndex],
      id: appId,
      path: appRoot,
      title: appTitle,
      enabled: true,
      appBuilderEnabled,
    };
  } else {
    mountedApps.push({ id: appId, path: appRoot, title: appTitle, enabled: true, appBuilderEnabled });
  }
  context.state.settings.mountedApps = mountedApps;
  clearMountedAppUninstallMarkers(context.state.settings, [appId]);
  recreateBridgeApp(context.state);
  saveBridgeSettings(context.state);
  queueAppReadinessReport({ state: context.state, appId, notifyPm: true });
  postAppCreatedWelcome(context.state, appId, appTitle, description, Boolean(source));

  context.sendJson(context.response, 200, {
    ok: true,
    appId,
    title: appTitle,
    appRoot,
    mode: source ? "imported" : "scaffolded",
  });
}

function appIdFromTitle(title: string): string {
  const normalized = title.normalize("NFKC").trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug && /^[\x00-\x7f]*$/u.test(normalized)) return slug.slice(0, 64);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `${slug || "app"}-${digest}`.slice(0, 64);
}

function postAppCreatedWelcome(
  state: BridgeState,
  appId: string,
  title: string,
  description: string,
  imported: boolean,
): void {
  const room = findDefaultAppGroupRoom(state.app.rooms.listRooms(), appId);
  if (!room) return;
  const roomId = room.id;
  const language = resolveHostLanguageSettings(state.settings);
  if (imported) {
    state.app.rooms.postSystemMessage({
      roomId,
      text: hostMessage(language, "app.setup.imported", { title }),
    });
    state.store.saveFrom(state.app);
    return;
  }
  const operator = state.app.rooms
    .listMembers()
    .find((member) => member.id === appBuilderMemberId(appId) && !member.disabled);
  const text = hostMessage(language, description ? "app.setup.created_with_goal" : "app.setup.created", {
    title,
    description,
  });
  if (operator) {
    state.app.rooms.postAgentMessage({
      roomId,
      senderId: operator.id,
      senderName: operator.displayName || operator.name,
      text,
    });
  } else {
    state.app.rooms.postSystemMessage({ roomId, text });
  }
  state.store.saveFrom(state.app);
}

function mountedAppDashboardEndpoint(target: MountedAppTarget, dashboardIndex = 0): string {
  return mountedAppDashboardHttpEndpoint(mountedAppDashboardSource(target, dashboardIndex));
}

function mountedAppDashboardSource(target: MountedAppTarget, dashboardIndex = 0): Record<string, unknown> {
  const ui = record(target.manifest.ui);
  const tabs = Array.isArray(ui.tabs) ? ui.tabs : [];
  let seen = 0;
  for (const rawTab of tabs) {
    const tab = record(rawTab);
    if (stringValue(tab.component) !== "dashboard") continue;
    if (seen === dashboardIndex) return record(tab.source);
    seen += 1;
  }
  return {};
}

function requestedDashboardIndex(context: AppRouteContext): number {
  const raw = context.url.searchParams.get("tab")?.trim() ?? "";
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function mountedAppDashboardHttpEndpoint(sourceConfig: Record<string, unknown>): string {
  const configuredEndpoint = stringValue(sourceConfig.endpoint);
  return isAbsoluteHttpUrl(configuredEndpoint) ? configuredEndpoint : "";
}

function mountedAppDashboardRefreshEndpoint(target: MountedAppTarget, dashboardIndex = 0): string {
  const sourceConfig = mountedAppDashboardSource(target, dashboardIndex);
  const configuredEndpoint = stringValue(sourceConfig.refreshEndpoint);
  return isAbsoluteHttpUrl(configuredEndpoint) ? configuredEndpoint : "";
}

async function fetchMountedAppJsonEndpoint(endpoint: string, method: "GET" | "POST"): Promise<unknown> {
  const url = new URL(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    if (response.ok) throw new CloudProxyError(502, { error: "upstream_response_invalid" });
    body = { error: text };
  }
  if (!response.ok) throw new CloudProxyError(response.status, body);
  return body;
}

// ===== Generic dashboard normalization =====

function normalizeDashboardPayload(
  payload: unknown,
  target: MountedAppTarget,
  source: "cloud",
  language: SupportedLocale,
) {
  const data = record(payload);
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) return undefined;
  const items = rawItems.map((item) => normalizeDashboardItem(item, language)).filter(Boolean);
  if (!items.length) return undefined;
  return {
    ok: true,
    app: publicAppTarget(target),
    overview: normalizeDashboardOverview(data.overview, items),
    items,
    source,
  };
}

function emptyMountedAppDashboard(target: MountedAppTarget) {
  return {
    ok: true,
    app: publicAppTarget(target),
    overview: {
      activeCount: 0,
      overallGrade: "unknown" as const,
    },
    items: [],
    source: "cloud" as const,
  };
}

function sendMountedAppDashboardProxyError(context: AppRouteContext, target: MountedAppTarget, error: unknown): void {
  const failure = dashboardProxyFailure(error);
  context.sendJson(context.response, failure.status, {
    ok: false,
    app: publicAppTarget(target),
    error: failure.error,
    ...(failure.details ? { details: failure.details } : {}),
  });
}

function dashboardProxyFailure(error: unknown): { status: number; error: string; details?: Record<string, unknown> } {
  if (error instanceof CloudProxyError) {
    const errorBody = record(record(error.body).error);
    const message = stringValue(errorBody.message) || stringValue(record(error.body).message);
    const details = {
      upstreamStatus: error.status,
      ...(message ? { upstreamMessage: message } : {}),
    };
    if (error.status === 401 || error.status === 403) {
      return { status: error.status, error: "auth_required", details };
    }
    return {
      status: error.status >= 500 ? 502 : error.status,
      error: "dashboard_unavailable",
      details,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { status: 504, error: "dashboard_timeout" };
  }
  return { status: 502, error: "dashboard_unavailable" };
}

function normalizeDashboardOverview(value: unknown, items: Array<ReturnType<typeof normalizeDashboardItem>>) {
  const overview = record(value);
  return {
    activeCount: numberValue(overview.activeCount) || items.length,
    overallGrade: dashboardGrade(overview.overallGrade || strongestDashboardGrade(items.map((item) => item?.grade))),
  };
}

function normalizeDashboardItem(value: unknown, language: SupportedLocale = "en") {
  const item = record(value);
  const id = stringValue(item.id);
  const title = stringValue(item.title) || id;
  if (!id || !title) return undefined;
  const grade = dashboardGrade(item.grade);
  return {
    id,
    title,
    grade,
    topAlert: stringValue(item.topAlert),
    commission: normalizeDashboardCommission(item.commission, id, grade),
    sections: normalizeDashboardSections(item.sections, language),
  };
}

function normalizeDashboardSections(value: unknown, language: SupportedLocale) {
  const sections = record(value);
  const retention = record(sections.retention);
  const diagnosis = record(sections.diagnosis);
  return {
    acquisition: {
      metrics: normalizeDashboardMetrics(record(sections.acquisition).metrics),
    },
    retention: {
      metrics: normalizeDashboardMetrics(retention.metrics),
      funnel: normalizeDashboardFunnel(
        retention.funnel,
        retention.dropoff,
        retention.chapters || retention.chapterFunnel || retention.chapter_funnel,
        language,
      ),
    },
    revenue: {
      metrics: normalizeDashboardMetrics(record(sections.revenue).metrics),
    },
    diagnosis: {
      strengths: stringArray(diagnosis.strengths),
      suggestions: stringArray(diagnosis.suggestions),
    },
  };
}

function normalizeDashboardMetrics(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((metric) => {
      const recordMetric = record(metric);
      const label = stringValue(recordMetric.label);
      if (!label) return undefined;
      return {
        label,
        grade: dashboardGrade(recordMetric.grade),
      };
    })
    .filter(Boolean);
}

function normalizeDashboardFunnel(
  value: unknown,
  dropoffValue: unknown,
  chapterValue: unknown,
  language: SupportedLocale,
) {
  const funnel = record(value);
  const dropoff = record(dropoffValue);
  const maxDropChapter = record(funnel.maxDropChapter);
  const chapters = normalizeDashboardFunnelChapters(
    language,
    chapterValue,
    funnel.chapters,
    funnel.chapterFunnel,
    funnel.chapter_funnel,
    funnel.episodes,
    funnel.episodeFunnel,
    funnel.episode_funnel,
  );
  const freeChapters =
    firstNumberValue(funnel.freeChapters, funnel.free_chapters, funnel.freeChapterCount, funnel.free_chapter_count) ??
    inferChapterFunnelFree(chapters);
  const totalChapters =
    firstNumberValue(
      funnel.totalChapters,
      funnel.total_chapters,
      funnel.chapterCount,
      funnel.chapter_count,
      funnel.episodeCount,
      funnel.episode_count,
    ) ?? inferChapterFunnelTotal(chapters);
  const from = numberValue(maxDropChapter.from) || numberValue(dropoff.from);
  const to = numberValue(maxDropChapter.to) || numberValue(dropoff.to);
  const label = stringValue(maxDropChapter.label) || stringValue(funnel.label) || stringValue(dropoff.label);
  const hasSplitData = Boolean(totalChapters && totalChapters > 0);
  const hasDropoffData = Boolean(from && to && from > 0 && to > 0);
  if (!hasSplitData && !hasDropoffData && !chapters.length) return undefined;
  return {
    freeChapters: hasSplitData ? freeChapters : undefined,
    totalChapters: hasSplitData ? totalChapters : inferDropoffFunnelTotal(from, to),
    mode: hasSplitData || chapters.length ? "split" : "dropoff",
    maxDropChapter: hasDropoffData ? { from, to, label } : undefined,
    chapters: chapters.length ? chapters : undefined,
  };
}

function inferDropoffFunnelTotal(from: number | undefined, to: number | undefined): number | undefined {
  const largestKnownChapter = Math.max(from || 0, to || 0);
  return largestKnownChapter > 0 ? Math.max(30, largestKnownChapter) : undefined;
}

function normalizeDashboardFunnelChapters(
  language: SupportedLocale,
  ...values: unknown[]
): NormalizedDashboardFunnelChapter[] {
  const source =
    values.find((value) => Array.isArray(value) && value.length) ?? values.find((value) => Array.isArray(value));
  const chapters = Array.isArray(source) ? source : [];
  return chapters
    .map((chapter) => {
      const item = record(chapter);
      const chapterNumber = firstNumberValue(
        item.chapter,
        item.orderNum,
        item.order_num,
        item.episode,
        item.episodeNo,
        item.episode_no,
        item.chapterNo,
        item.chapter_no,
        item.ep,
      );
      if (!chapterNumber || chapterNumber <= 0) return undefined;
      const ratio = retentionRatioValue(
        item.reachPercent,
        item.reach_percent,
        item.reachRate,
        item.reach_rate,
        item.retention,
        item.retentionRate,
        item.retention_rate,
        item.retentionPercent,
        item.retention_percent,
        item.percent,
        item.rate,
        item.value,
      );
      const explicitGrade = dashboardGrade(item.grade);
      const normalized: NormalizedDashboardFunnelChapter = {
        chapter: chapterNumber,
        label:
          stringValue(item.label) ||
          stringValue(item.title) ||
          stringValue(item.name) ||
          hostMessage(language, "dashboard.chapter", { chapter: chapterNumber }),
        grade: explicitGrade !== "unknown" ? explicitGrade : ratio === undefined ? "unknown" : retentionGrade(ratio),
      };
      const uv = firstNumberValue(
        item.uv,
        item.users,
        item.userCount,
        item.user_count,
        item.playUv,
        item.play_uv,
        item.readUv,
        item.read_uv,
      );
      const paid = booleanValue(item.paid ?? item.isPaid ?? item.is_paid ?? item.isPay ?? item.is_pay);
      if (uv !== undefined) normalized.uv = uv;
      if (ratio !== undefined) normalized.reachPercent = Math.round(ratio * 1000) / 10;
      if (paid !== undefined) normalized.paid = paid;
      return normalized;
    })
    .filter((chapter): chapter is NormalizedDashboardFunnelChapter => Boolean(chapter))
    .sort((left, right) => left.chapter - right.chapter);
}

function inferChapterFunnelTotal(chapters: NormalizedDashboardFunnelChapter[]): number | undefined {
  const total = chapters.reduce((largest, chapter) => Math.max(largest, chapter.chapter), 0);
  return total > 0 ? total : undefined;
}

function inferChapterFunnelFree(chapters: NormalizedDashboardFunnelChapter[]): number | undefined {
  const paidStart = chapters
    .filter((chapter) => chapter.paid === true)
    .reduce(
      (first, chapter) => (first === undefined ? chapter.chapter : Math.min(first, chapter.chapter)),
      undefined as number | undefined,
    );
  if (paidStart && paidStart > 1) return paidStart - 1;
  const freeEnd = chapters
    .filter((chapter) => chapter.paid === false)
    .reduce((last, chapter) => Math.max(last, chapter.chapter), 0);
  return freeEnd > 0 ? freeEnd : undefined;
}

function normalizeDashboardCommission(value: unknown, _seriesId: string, _grade: DashboardGrade) {
  const commission = record(value);
  const estimate = stringValue(commission.estimate);
  const state = stringValue(commission.state);
  const source = stringValue(commission.source);
  const parts = normalizeDashboardCommissionParts(commission.parts);
  if (estimate && (state === "pending" || state === "paid") && source === "cloud") {
    return {
      label: stringValue(commission.label),
      estimate,
      parts: parts.length ? parts : undefined,
      state,
      source,
      mock: Boolean(commission.mock),
    };
  }
  return undefined;
}

function normalizeDashboardCommissionParts(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((part) => {
      const recordPart = record(part);
      const label = stringValue(recordPart.label);
      const estimate = stringValue(recordPart.estimate);
      if (!label || !estimate) return undefined;
      return { label, estimate };
    })
    .filter(Boolean);
}

function retentionRatioValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const text = typeof value === "number" ? "" : String(value).trim();
    const hasPercentSuffix = /%\s*$/.test(text);
    const raw = typeof value === "number" ? value : Number.parseFloat(text.replace("%", ""));
    if (!Number.isFinite(raw)) continue;
    if (hasPercentSuffix) return Math.max(0, Math.min(raw / 100, 1));
    if (raw > 1) return Math.max(0, Math.min(raw / 100, 1));
    return Math.max(0, Math.min(raw, 1));
  }
  return undefined;
}

function retentionGrade(value: number): DashboardGrade {
  if (value >= 0.6) return "good";
  if (value >= 0.35) return "warn";
  return "weak";
}

function dashboardGrade(value: unknown): DashboardGrade {
  if (value === "good" || value === "warn" || value === "weak" || value === "unknown") return value;
  return "unknown";
}

function strongestDashboardGrade(grades: Array<DashboardGrade | undefined>): DashboardGrade {
  if (grades.includes("weak")) return "weak";
  if (grades.includes("warn")) return "warn";
  if (grades.includes("good")) return "good";
  return "unknown";
}

function stringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(stringValue).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = numberValue(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  const text = stringValue(value).toLowerCase();
  if (!text) return undefined;
  if (text === "true" || text === "1" || text === "yes" || text === "paid") return true;
  if (text === "false" || text === "0" || text === "no" || text === "free") return false;
  return undefined;
}

function publicEntry(root: string, absolutePath: string) {
  const stat = statSync(absolutePath);
  const normalizedPath = normalizeRelativePath(relative(root, absolutePath));
  if (stat.isDirectory()) {
    return {
      name: basename(absolutePath),
      path: normalizedPath,
      kind: "directory",
      updatedAt: stat.mtime.toISOString(),
    };
  }
  return {
    name: basename(absolutePath),
    path: normalizedPath,
    kind: "file",
    size: stat.size,
    mimeType: contentTypeForPath(absolutePath),
    updatedAt: stat.mtime.toISOString(),
  };
}

function existingAppPath(root: string, requestedPath: string): string {
  const resolved = safeResolveInside(root, requestedPath);
  if (!resolved || !existsSync(resolved)) throw new Error("app_file_not_found");
  return resolved;
}

function safeAppRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeRelativePath(value)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function safeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"\\|?*\x00-\x1f]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 160);
  return sanitized || "untitled";
}

function ensureFileExtension(name: string, fallbackExtension: string): string {
  if (extname(name)) return name;
  return `${name}${fallbackExtension || ".md"}`;
}

function uniqueFilePath(parentPath: string, fileName: string, currentPath?: string): string {
  const extension = extname(fileName) || ".md";
  const stem = fileName.slice(0, fileName.length - extension.length) || "untitled";
  let candidate = resolve(parentPath, `${stem}${extension}`);
  let index = 2;
  while (existsSync(candidate) && (!currentPath || resolve(candidate) !== resolve(currentPath))) {
    candidate = resolve(parentPath, `${stem} ${index}${extension}`);
    index += 1;
  }
  return candidate;
}

function uniqueDirectoryPath(parentPath: string, folderName: string, currentPath?: string): string {
  const base = folderName || "New folder";
  let candidate = resolve(parentPath, base);
  let index = 2;
  while (existsSync(candidate) && (!currentPath || resolve(candidate) !== resolve(currentPath))) {
    candidate = resolve(parentPath, `${base} ${index}`);
    index += 1;
  }
  return candidate;
}

function uniqueUploadedFilePath(parentPath: string, fileName: string): string {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, fileName.length - extension.length) : fileName;
  const base = stem || "upload";
  let candidate = resolve(parentPath, `${base}${extension}`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = resolve(parentPath, `${base} ${index}${extension}`);
    index += 1;
  }
  return candidate;
}

function chooseImportFiles(language: SupportedLocale): Promise<string[]> {
  const prompt = hostMessage(language, "dialog.import_app_files");
  return new Promise((resolve, reject) => {
    const script = [
      `set chosenFiles to choose file with prompt "${prompt}" with multiple selections allowed`,
      'set output to ""',
      "repeat with chosenFile in chosenFiles",
      "  set output to output & POSIX path of chosenFile & linefeed",
      "end repeat",
      "output",
    ].join("\n");
    execFile("osascript", ["-e", script], { timeout: 120_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
        return;
      }
      const message = `${stderr || ""}\n${error.message}`;
      if (message.includes("User canceled") || message.includes("-128")) {
        resolve([]);
        return;
      }
      reject(new Error((stderr || "").trim() || error.message));
    });
  });
}

class CloudProxyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`cloud_request_failed:${status}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
