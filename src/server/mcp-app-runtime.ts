import { readFileSync, statSync } from "node:fs";
import { listMountedAppFlows } from "../app-builder/flow-discovery.js";
import { MCP_APP_BRIDGE_TOOL_IDS } from "../app-builder/manifest.js";
import { normalizeAppUi, normalizeMcpAppView, type McpAppViewConfig } from "../app-builder/ui-runtime.js";
import { buildAppCommandOutput, formatAppCommandFailure, runAppCommandProcess } from "../tools/app-command.js";
import {
  AppCliCommandResolutionError,
  ensureMountedAppCliReady,
  resolveMountedAppDeclaredCliExecution,
} from "./app-cli-env.js";
import { resolveMountedAppRuntimeEnv } from "./app-runtime-env.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { mcpAppMediaCache } from "./mcp-app-media-cache.js";
import type { BridgeState } from "./bridge-types.js";
import type { MountedAppTarget } from "./mounted-apps.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";
import { LocalFilesystemWorkspaceStore, resolveExistingContainedPath } from "./workspace-store.js";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_MCP_APP_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_MCP_APP_TOOL_ARGUMENT_BYTES = 256 * 1024;
const workspaceStore = new LocalFilesystemWorkspaceStore();

export interface McpAppContract {
  protocol: "mcp-apps";
  resource: {
    uri: string;
    mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
    text: string;
    _meta: {
      ui: {
        csp: Record<string, string[]>;
        permissions: Record<string, Record<string, never>>;
        prefersBorder: boolean;
      };
    };
  };
  launcherTool: McpAppToolDefinition;
  tools: McpAppToolDefinition[];
}

export interface McpAppToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export function createMountedMcpAppContract(
  target: MountedAppTarget,
  forbiddenOrigins: string[] = [],
  viewId?: string,
): McpAppContract {
  const view = resolveMountedMcpAppView(target, viewId);
  const entry = view.entry;
  const entryPath = entry ? resolveExistingContainedPath(target.appRoot, entry) : undefined;
  if (!entryPath) throw new Error("mcp_app_entry_invalid");
  const entryStat = statSync(entryPath);
  if (!entryStat.isFile()) throw new Error("mcp_app_entry_not_file");
  if (entryStat.size > MAX_MCP_APP_RESOURCE_BYTES) throw new Error("mcp_app_entry_too_large");

  const resourceUri = `ui://opengrove/${encodeURIComponent(target.id)}/${viewId ? `${encodeURIComponent(viewId)}/` : ""}${entry.replace(/^\/+/, "")}`;
  const allowedToolIds = view.tools;
  const tools = allowedToolIds
    .map((toolId) => MCP_APP_TOOL_DEFINITIONS[toolId])
    .filter((tool): tool is McpAppToolDefinition => Boolean(tool));
  return {
    protocol: "mcp-apps",
    resource: {
      uri: resourceUri,
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      text: readFileSync(entryPath, "utf8"),
      _meta: {
        ui: {
          csp: approvedCsp(record(view.csp), forbiddenOrigins),
          permissions: approvedPermissions(record(view.permissions)),
          prefersBorder: true,
        },
      },
    },
    launcherTool: {
      name: `opengrove.app.${target.id}${viewId ? `.${viewId}` : ""}.launch`,
      title: `Open ${target.title}`,
      description: `Render the ${target.title} MCP App view${viewId ? ` (${viewId})` : ""}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { ui: { resourceUri } },
    },
    tools,
  };
}

export async function callMountedMcpAppTool(
  state: BridgeState,
  target: MountedAppTarget,
  name: string,
  rawArguments: unknown,
  context: { wwAuth?: BridgeWwRuntimeAuth; viewId?: string } = {},
): Promise<Record<string, unknown>> {
  let view: McpAppViewConfig;
  try {
    view = resolveMountedMcpAppView(target, context.viewId);
  } catch (error) {
    throw new McpAppToolError(409, error instanceof Error ? error.message : String(error));
  }
  const allowedTools = new Set(view.tools);
  if (!allowedTools.has(name) || !MCP_APP_BRIDGE_TOOL_IDS.some((toolId) => toolId === name)) {
    throw new McpAppToolError(403, "mcp_app_tool_not_allowed");
  }
  if (Buffer.byteLength(JSON.stringify(rawArguments ?? {}), "utf8") > MAX_MCP_APP_TOOL_ARGUMENT_BYTES) {
    throw new McpAppToolError(413, "mcp_app_tool_arguments_too_large");
  }
  const args = record(rawArguments);
  let value: unknown;
  switch (name) {
    case "opengrove.app.workspace.list": {
      workspaceStore.ensureWorkspace(target.workspace);
      value = workspaceStore.listFiles(target.workspace, {
        path: stringValue(args.path),
        maxDepth: boundedInteger(args.maxDepth, 1, 8, 4),
        maxEntries: boundedInteger(args.maxEntries, 1, 1_200, 500),
      });
      break;
    }
    case "opengrove.app.workspace.read": {
      workspaceStore.ensureWorkspace(target.workspace);
      const path = requiredString(args.path, "path_required");
      const file = workspaceStore.readFile(target.workspace, path, { textSizeLimit: 2_000_000 });
      if (!file) throw new McpAppToolError(404, "workspace_file_not_found");
      value = file;
      break;
    }
    case "opengrove.app.workspace.write": {
      workspaceStore.ensureWorkspace(target.workspace);
      const path = requiredString(args.path, "path_required");
      const content = typeof args.content === "string" ? args.content : undefined;
      if (content === undefined) throw new McpAppToolError(400, "content_required");
      if (Buffer.byteLength(content, "utf8") > 2_000_000) {
        throw new McpAppToolError(413, "workspace_file_too_large");
      }
      const file = workspaceStore.writeFile(target.workspace, path, content);
      if (!file) throw new McpAppToolError(400, "workspace_path_invalid");
      value = file;
      break;
    }
    case "opengrove.app.media.cache": {
      try {
        value = await mcpAppMediaCache.prepare(target, {
          sourceUrl: requiredString(args.sourceUrl, "media_source_required"),
          cacheKey: requiredString(args.cacheKey, "media_cache_key_required"),
          expectedSize: requiredSafeInteger(args.expectedSize, "media_expected_size_invalid"),
          contentType: requiredString(args.contentType, "media_content_type_required"),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message === "media_source_not_allowed" ? 403 : message.includes("capacity") ? 507 : 400;
        throw new McpAppToolError(status, message);
      }
      break;
    }
    case "opengrove.app.flows.list": {
      workspaceStore.ensureWorkspace(target.workspace);
      value = {
        flows: listMountedAppFlows(target.workspaceRoot, { maxEntries: 500, maxDepth: 8 }),
      };
      break;
    }
    case "opengrove.app.command.run": {
      value = await runDeclaredAppCommand(state, target, args, context.wwAuth);
      break;
    }
    default:
      throw new McpAppToolError(404, "mcp_app_tool_unknown");
  }
  return toolResult(value);
}

function resolveMountedMcpAppView(target: MountedAppTarget, viewId?: string): McpAppViewConfig {
  if (!viewId) {
    const view = normalizeAppUi(target.manifest).view;
    if (!view) throw new Error("app_ui_not_mcp_app");
    return view;
  }
  if (normalizeAppUi(target.manifest).surface !== "file-workbench") {
    throw new Error("mcp_app_view_tab_requires_file_workbench");
  }
  if (!isSafeMcpAppViewId(viewId)) throw new Error("mcp_app_view_id_invalid");
  const ui = record(target.manifest.ui);
  const tabs = Array.isArray(ui.tabs) ? ui.tabs : [];
  const seenViewIds = new Set<string>();
  let resolvedView: McpAppViewConfig | undefined;
  for (const value of tabs) {
    const tab = record(value);
    if (tab.component !== "view") continue;
    const id = stringValue(tab.id);
    if (!isSafeMcpAppViewId(id)) throw new Error("mcp_app_view_id_invalid");
    if (seenViewIds.has(id)) throw new Error("mcp_app_view_id_duplicate");
    seenViewIds.add(id);
    if (id === viewId) resolvedView = normalizeMcpAppView(tab.view);
  }
  if (resolvedView) return resolvedView;
  throw new Error("mcp_app_view_not_found");
}

function isSafeMcpAppViewId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
}

export class McpAppToolError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function runDeclaredAppCommand(
  state: BridgeState,
  target: MountedAppTarget,
  args: Record<string, unknown>,
  wwAuth?: BridgeWwRuntimeAuth,
): Promise<Record<string, unknown>> {
  const commandId = requiredString(args.commandId, "command_id_required");
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (commandArgs.length > 100 || commandArgs.some((arg) => Buffer.byteLength(arg) > 16_384)) {
    throw new McpAppToolError(413, "command_arguments_too_large");
  }
  const runtimeEnv = resolveMountedAppRuntimeEnv(state, target.id, undefined, wwAuth)?.env ?? {};
  let commandExecution;
  try {
    commandExecution = resolveMountedAppDeclaredCliExecution(state, target.id, commandId, commandArgs, runtimeEnv);
  } catch (error) {
    if (error instanceof AppCliCommandResolutionError) {
      throw new McpAppToolError(409, error.code);
    }
    throw error;
  }
  if (!commandExecution) throw new McpAppToolError(403, "app_command_not_declared");
  const { invocation, appCliEnv, commandCliEnv } = commandExecution;
  const readiness = await ensureMountedAppCliReady(commandCliEnv, resolveHostLanguageSettings(state.settings));
  if (!readiness.ok) throw new McpAppToolError(409, readiness.message ?? "app_command_not_ready");
  const result = await runAppCommandProcess(invocation.command, invocation.args, target.appRoot, {
    ...runtimeEnv,
    ...(appCliEnv?.env ?? {}),
    ...(invocation.env ?? {}),
  });
  if (result.exitCode !== 0) {
    throw new McpAppToolError(422, formatAppCommandFailure(result));
  }
  const output = buildAppCommandOutput(result, args.parseJson !== false);
  if (!output.ok) {
    throw new McpAppToolError(output.error === "structured_output_too_large" ? 413 : 422, output.error);
  }
  return {
    commandId,
    ...output.value,
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const structuredContent = recordOrWrapped(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent,
  };
}

function approvedCsp(csp: Record<string, unknown>, forbiddenOrigins: string[]): Record<string, string[]> {
  const forbidden = forbiddenOrigins.map(parseOrigin).filter((origin): origin is URL => Boolean(origin));
  const filter = (value: unknown) =>
    stringArray(value).filter((source) => {
      const parsed = parseCspSource(source);
      if (!parsed) return false;
      return !forbidden.some((origin) => cspSourceAllowsOrigin(parsed, origin));
    });
  return {
    connectDomains: filter(csp.connectDomains),
    resourceDomains: filter(csp.resourceDomains),
    frameDomains: filter(csp.frameDomains),
    baseUriDomains: filter(csp.baseUriDomains),
  };
}

function approvedPermissions(value: Record<string, unknown>): Record<string, Record<string, never>> {
  const output: Record<string, Record<string, never>> = {};
  for (const key of ["camera", "microphone", "geolocation", "clipboardWrite"]) {
    if (value[key] && typeof value[key] === "object") output[key] = {};
  }
  return output;
}

function parseOrigin(value: string): URL | undefined {
  try {
    return new URL(new URL(value).origin);
  } catch {
    return undefined;
  }
}

function parseCspSource(value: string): { url: URL; wildcard: boolean } | undefined {
  if (/[;\r\n'"\s]/u.test(value)) return undefined;
  const wildcard = value.startsWith("https://*.");
  if (value.includes("*") && !wildcard) return undefined;
  try {
    const url = new URL(wildcard ? value.replace("https://*.", "https://wildcard.") : value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      return undefined;
    return { url, wildcard };
  } catch {
    return undefined;
  }
}

function cspSourceAllowsOrigin(source: { url: URL; wildcard: boolean }, origin: URL): boolean {
  if (source.url.protocol !== origin.protocol || source.url.port !== origin.port) return false;
  if (!source.wildcard) return source.url.hostname === origin.hostname;
  const suffix = source.url.hostname.replace(/^wildcard\./u, "");
  return origin.hostname === suffix || origin.hostname.endsWith(`.${suffix}`);
}

function requiredString(value: unknown, error: string): string {
  const output = stringValue(value);
  if (!output) throw new McpAppToolError(400, error);
  return output;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function requiredSafeInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value)) throw new McpAppToolError(400, error);
  return Number(value);
}

function recordOrWrapped(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim())
    : [];
}

const MCP_APP_TOOL_DEFINITIONS: Record<string, McpAppToolDefinition> = {
  "opengrove.app.workspace.list": {
    name: "opengrove.app.workspace.list",
    title: "List App workspace files",
    description: "List files inside this App's scoped workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxDepth: { type: "integer", minimum: 1, maximum: 8 },
        maxEntries: { type: "integer", minimum: 1, maximum: 1200 },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  "opengrove.app.workspace.read": {
    name: "opengrove.app.workspace.read",
    title: "Read App workspace file",
    description: "Read a text file from this App's scoped workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  "opengrove.app.workspace.write": {
    name: "opengrove.app.workspace.write",
    title: "Write App workspace file",
    description: "Write a text file inside this App's scoped workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  "opengrove.app.media.cache": {
    name: "opengrove.app.media.cache",
    title: "Cache App media locally",
    description:
      "Cache one CSP-approved media resource and return an isolated Range URL plus, when ready, a workspacePath relative to OPENGROVE_APP_WORKSPACE_ROOT (not the command working directory).",
    inputSchema: {
      type: "object",
      properties: {
        sourceUrl: { type: "string", format: "uri", maxLength: 16_384 },
        cacheKey: { type: "string", minLength: 1, maxLength: 1_024 },
        expectedSize: { type: "integer", minimum: 1, maximum: 5 * 1024 * 1024 * 1024 },
        contentType: { type: "string", pattern: "^(video|audio)/[A-Za-z0-9.+-]+$" },
      },
      required: ["sourceUrl", "cacheKey", "expectedSize", "contentType"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["downloading", "ready", "error"] },
        cachedBytes: { type: "integer", minimum: 0 },
        expectedSize: { type: "integer", minimum: 1 },
        mediaUrl: { type: "string" },
        workspacePath: {
          type: "string",
          pattern: "^\\.cache/opengrove-media/[A-Za-z0-9._-]+$",
        },
        error: { type: "string" },
      },
      required: ["status", "cachedBytes", "expectedSize"],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  "opengrove.app.flows.list": {
    name: "opengrove.app.flows.list",
    title: "List App flows",
    description: "List workflow definitions in this App's scoped workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  "opengrove.app.command.run": {
    name: "opengrove.app.command.run",
    title: "Run declared App command",
    description: "Run one CLI declaration from this App manifest; arbitrary executables are not accepted.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string" },
        args: { type: "array", items: { type: "string" }, maxItems: 100 },
        parseJson: { type: "boolean" },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string" },
        exitCode: { type: "integer" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        json: {},
        stdoutBytes: { type: "integer", minimum: 0 },
        stderrBytes: { type: "integer", minimum: 0 },
        capturedStdoutBytes: { type: "integer", minimum: 0 },
        capturedStderrBytes: { type: "integer", minimum: 0 },
        stdoutTruncated: { type: "boolean" },
        stderrTruncated: { type: "boolean" },
      },
      required: [
        "commandId",
        "exitCode",
        "stderr",
        "stdoutBytes",
        "stderrBytes",
        "capturedStdoutBytes",
        "capturedStderrBytes",
        "stdoutTruncated",
        "stderrTruncated",
      ],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
};
