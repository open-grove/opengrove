import { spawn } from "node:child_process";
import { basename, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { openLocalPath } from "../../local-path-actions.js";
import { APP_FILE_TEXT_SIZE_LIMIT } from "../bridge-types.js";
import type { BridgeRouteContext } from "../router.js";
import {
  contentTypeForPath,
  isTextMimeType,
  LocalFilesystemWorkspaceStore,
  normalizeRelativePath,
  resolveExistingContainedPath,
  safeResolveInside,
  type WorkspaceScope,
} from "../workspace-store.js";
import { resolveConfiguredBridgeWorkspaceRoot } from "../workspace-root.js";
import { record, numberValue, stringValue } from "../http-utils.js";
import { sendRawFileResponse } from "../raw-file-response.js";

const workspaceStore = new LocalFilesystemWorkspaceStore();
const DEFAULT_READ_LIMIT_BYTES = APP_FILE_TEXT_SIZE_LIMIT;
const MAX_READ_LIMIT_BYTES = 5_000_000;

export async function handleWorkspaceResourceRoute(context: BridgeRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  if (!url.pathname.startsWith("/workspace/resource")) return false;

  if (state.profile !== "local") {
    sendJson(response, 501, { ok: false, error: "workspace_resource_unsupported_for_profile" });
    return true;
  }

  const root = resolveConfiguredBridgeWorkspaceRoot(state.settings);
  if (!root) {
    sendJson(response, 400, { ok: false, error: "workspace_root_not_configured" });
    return true;
  }
  const scope: WorkspaceScope = { kind: "local", appId: "workspace", root };

  try {
    if (request.method === "GET" && url.pathname === "/workspace/resource/raw") {
      const requestedPath = url.searchParams.get("path") ?? "";
      assertWorkspacePath(root, requestedPath);
      const rawFile = workspaceStore.openRawFile(scope, requestedPath);
      if (!rawFile) {
        sendJson(response, 404, { ok: false, error: "workspace_resource_not_found" });
        return true;
      }
      sendRawFileResponse(request, response, rawFile, {
        download: url.searchParams.get("download") === "1",
      });
      return true;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }

    const body = record(await context.readJsonBody(request));
    const requestedPath = stringValue(body.path);
    const action = url.pathname.slice("/workspace/resource/".length);

    if (action === "metadata") {
      const metadata = metadataResponse(root, requestedPath);
      sendJson(response, metadata.ok ? 200 : 403, metadata);
      return true;
    }
    if (action === "read") {
      assertWorkspacePath(root, requestedPath);
      const maxBytes = readLimit(numberValue(body.maxBytes));
      const file = workspaceStore.readFile(scope, requestedPath, { textSizeLimit: maxBytes });
      if (!file) {
        sendJson(response, 404, { ok: false, error: "workspace_resource_not_found" });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        file: {
          ...file.entry,
          content: file.content,
          contentTruncated: file.contentTruncated,
        },
      });
      return true;
    }
    if (action === "copy") {
      const mode = stringValue(body.mode) || "path";
      assertWorkspacePath(root, requestedPath);
      if (mode === "contents") {
        const maxBytes = readLimit(numberValue(body.maxBytes));
        const file = workspaceStore.readFile(scope, requestedPath, { textSizeLimit: maxBytes });
        if (!file) {
          sendJson(response, 404, { ok: false, error: "workspace_resource_not_found" });
          return true;
        }
        await copyTextToSystemClipboard(file.content ?? "");
        sendJson(response, 200, { ok: true, mode, contentTruncated: file.contentTruncated });
        return true;
      }
      if (mode !== "path") {
        sendJson(response, 400, { ok: false, error: "workspace_resource_copy_mode_unsupported" });
        return true;
      }
      await copyTextToSystemClipboard(normalizeRelativePath(requestedPath));
      sendJson(response, 200, { ok: true, mode });
      return true;
    }
    if (action === "open-targets") {
      const metadata = metadataResponse(root, requestedPath);
      if (!metadata.ok || !metadata.exists) {
        sendJson(
          response,
          metadata.ok ? 404 : 403,
          metadata.ok ? { ok: false, error: "workspace_resource_not_found" } : metadata,
        );
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        preferredTarget: "system",
        targets: [
          { id: "system", label: "Open with system default" },
          {
            id: "finder",
            label:
              process.platform === "darwin"
                ? "Reveal in Finder"
                : process.platform === "win32"
                  ? "Show in File Explorer"
                  : "Show in file manager",
          },
        ],
      });
      return true;
    }
    if (action === "open") {
      const target = stringValue(body.target) || "system";
      assertWorkspacePath(root, requestedPath);
      const filePath = resolveExistingContainedPath(root, requestedPath);
      if (!filePath) {
        sendJson(response, 404, { ok: false, error: "workspace_resource_not_found" });
        return true;
      }
      await openLocalPath(filePath, target === "finder" ? "reveal" : "system");
      sendJson(response, 200, { ok: true, target });
      return true;
    }

    sendJson(response, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "workspace_resource_outside_root" ? 403 : 400;
    sendJson(response, status, { ok: false, error: message });
  }
  return true;
}

function assertWorkspacePath(root: string, requestedPath: string): void {
  if (!safeResolveInside(root, requestedPath)) {
    throw new Error("workspace_resource_outside_root");
  }
}

function metadataResponse(root: string, requestedPath: string) {
  const lexicalPath = safeResolveInside(root, requestedPath);
  if (!lexicalPath) {
    return { ok: false, error: "workspace_resource_outside_root" };
  }
  if (!existsSync(lexicalPath)) {
    return {
      ok: true,
      exists: false,
      path: normalizeRelativePath(requestedPath),
      name: basename(requestedPath) || "",
    };
  }
  const containedPath = resolveExistingContainedPath(root, requestedPath);
  if (!containedPath) {
    return { ok: false, error: "workspace_resource_outside_root" };
  }
  const stat = statSync(containedPath);
  const mimeType = stat.isFile() ? contentTypeForPath(containedPath) : undefined;
  return {
    ok: true,
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    name: basename(containedPath),
    path: normalizeRelativePath(relative(root, containedPath)),
    mimeType,
    size: stat.isFile() ? stat.size : undefined,
    contentKind: contentKindFor(mimeType, stat.isDirectory()),
    previewKind: previewKindFor(mimeType, stat.isDirectory()),
  };
}

function readLimit(value: number | undefined): number {
  if (!value || value <= 0) return DEFAULT_READ_LIMIT_BYTES;
  return Math.min(Math.floor(value), MAX_READ_LIMIT_BYTES);
}

function contentKindFor(mimeType: string | undefined, directory: boolean): string {
  if (directory) return "directory";
  if (!mimeType) return "unknown";
  if (isTextMimeType(mimeType)) return "text";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "binary";
}

function previewKindFor(mimeType: string | undefined, directory: boolean): string {
  if (directory) return "unsupported";
  if (!mimeType) return "unsupported";
  if (mimeType.includes("markdown")) return "markdown";
  if (isTextMimeType(mimeType)) return "source";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "unsupported";
}

async function copyTextToSystemClipboard(text: string): Promise<void> {
  const command = clipboardCommand();
  if (!command) {
    throw new Error("clipboard_unsupported");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("clipboard_timeout"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || "clipboard_failed"));
    });
    child.stdin.end(text);
  });
}

function clipboardCommand(): { file: string; args: string[] } | undefined {
  if (process.platform === "darwin") return { file: "pbcopy", args: [] };
  if (process.platform === "win32") return { file: "clip", args: [] };
  return { file: "xclip", args: ["-selection", "clipboard"] };
}
