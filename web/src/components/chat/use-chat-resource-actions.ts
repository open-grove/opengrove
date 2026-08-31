import { useCallback, useState } from "react";
import { apiUrl } from "../../api-base";
import { getJson, postJson, type ArtifactRecord } from "../../bridge";
import { rawDiagnosticText, useI18n } from "../../i18n";
import type { PreviewableFile } from "../shared/file-preview-panel";
import { useOptionalToast } from "../ui/toast";
import { resourceDisplayPath, resourceFileName, type ChatResourceAction, type ChatResourceRef } from "./resource-model";
import { openLocalChatResource } from "./resource-local-actions";

export interface ChatResourcePreviewState {
  resource: ChatResourceRef;
  selectedPath: string;
  rawUrl?: string;
  file?: PreviewableFile;
  loading: boolean;
  error?: string;
}

interface WorkspaceResourceReadResponse {
  ok: boolean;
  file?: PreviewableFile;
  error?: string;
}

interface MountedAppFileResponse {
  ok: boolean;
  file?: PreviewableFile;
  error?: string;
}

interface KnowledgeFileResponse {
  ok: boolean;
  file?: KnowledgePreviewableFile;
  error?: string;
}

interface ArtifactResponse {
  ok: boolean;
  artifact?: ArtifactRecord;
  error?: string;
}

type KnowledgePreviewableFile = PreviewableFile & {
  vaultPath?: string;
  format?: string;
};

export function useChatResourceActions() {
  const { t } = useI18n();
  const toast = useOptionalToast()?.toast;
  const [preview, setPreview] = useState<ChatResourcePreviewState | null>(null);

  const closePreview = useCallback(() => setPreview(null), []);

  const openResource = useCallback(
    async (resource: ChatResourceRef, action: ChatResourceAction = "preview") => {
      try {
        if (action === "copy-path") {
          if (await copyWorkspaceResource(resource, "path")) return;
          await copyTextToClipboard(resourceDisplayPath(resource));
          return;
        }
        if (action === "copy-contents") {
          if (await copyWorkspaceResource(resource, "contents")) return;
          const file = await readResourceFile(resource);
          await copyTextToClipboard(file?.content ?? "");
          return;
        }
        if (action === "reveal") {
          await revealResource(resource);
          return;
        }
        if (action === "open") {
          if (resource.origin === "knowledge") {
            await previewResource(resource, setPreview);
            return;
          }
          await openResourceExternally(resource);
          return;
        }
        await previewResource(resource, setPreview);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (action === "reveal" && toast) {
          toast({
            kind: "error",
            title: t("system.openLocalFolderFailed", { message: rawDiagnosticText(message) }),
          });
          return;
        }
        setPreview({
          resource,
          selectedPath: resourceDisplayPath(resource),
          loading: false,
          error: message,
        });
      }
    },
    [t, toast],
  );

  return {
    preview,
    closePreview,
    openResource,
  };
}

async function previewResource(
  resource: ChatResourceRef,
  setPreview: (preview: ChatResourcePreviewState | null) => void,
): Promise<void> {
  if (resource.origin === "http") {
    await openResourceExternally(resource);
    return;
  }
  const selectedPath = resourceDisplayPath(resource);
  const rawUrl = rawUrlForResource(resource);
  setPreview({ resource, selectedPath, rawUrl, loading: true });
  if (resource.origin === "generated" || resource.origin === "vault") {
    setPreview({
      resource,
      selectedPath,
      rawUrl,
      loading: false,
      file: {
        name: resourceFileName(resource),
        path: selectedPath,
        mimeType: mimeTypeFromName(resourceFileName(resource)),
      },
    });
    return;
  }
  const file = await readResourceFile(resource);
  const loadedSelectedPath = file?.path || selectedPath;
  setPreview({
    resource,
    selectedPath: loadedSelectedPath,
    rawUrl,
    file,
    loading: false,
  });
}

async function readResourceFile(resource: ChatResourceRef): Promise<PreviewableFile | undefined> {
  if (resource.origin === "workspace" && resource.path) {
    const response = await postJson<WorkspaceResourceReadResponse>("/workspace/resource/read", {
      path: resource.path,
      maxBytes: 2_000_000,
    });
    return response.file;
  }
  if (resource.origin === "mounted-app" && resource.appId && resource.path) {
    const params = new URLSearchParams({ path: resource.path });
    const response = await getJson<MountedAppFileResponse>(
      `/apps/${encodeURIComponent(resource.appId)}/file?${params.toString()}`,
    );
    return response.file;
  }
  if (resource.origin === "knowledge" && resource.path) {
    const response = await getJson<KnowledgeFileResponse>(`/knowledge/${encodeURIComponent(resource.path)}/file`);
    return normalizeKnowledgeFile(resource, response.file);
  }
  if (resource.origin === "artifact" && resource.path) {
    const response = await getJson<ArtifactResponse>(`/artifacts/${encodeURIComponent(resource.path)}`);
    return normalizeArtifactFile(resource, response.artifact);
  }
  return undefined;
}

function normalizeArtifactFile(
  resource: ChatResourceRef,
  artifact: ArtifactRecord | undefined,
): PreviewableFile | undefined {
  if (!artifact) return undefined;
  const data = artifact.data ?? {};
  const contentValue: unknown = [data.content, data.body, data.text, data.markdown, data.value].find(
    (value) => typeof value === "string",
  );
  const content = typeof contentValue === "string" ? contentValue : JSON.stringify(data, null, 2);
  const name = artifact.title || resource.title || artifact.id || "artifact";
  return {
    name,
    path: artifact.id || resource.path || name,
    mimeType:
      typeof data.mimeType === "string"
        ? data.mimeType
        : typeof artifact.preview?.mimeType === "string"
          ? artifact.preview.mimeType
          : mimeTypeFromName(name) || "text/plain; charset=utf-8",
    content,
  };
}

function normalizeKnowledgeFile(
  resource: ChatResourceRef,
  file: KnowledgePreviewableFile | undefined,
): PreviewableFile | undefined {
  if (!file) return undefined;
  const path = file.vaultPath || file.path || resource.path || resource.title;
  const name = file.name || fileNameFromPath(path) || resource.title;
  const mimeType =
    file.mimeType ||
    (file.format === "markdown" || /\.md(?:$|[?#])/i.test(path)
      ? "text/markdown; charset=utf-8"
      : mimeTypeFromName(name));
  return {
    name,
    path,
    mimeType,
    content: file.content,
    contentTruncated: file.contentTruncated,
  };
}

async function copyWorkspaceResource(resource: ChatResourceRef, mode: "path" | "contents"): Promise<boolean> {
  if (resource.origin !== "workspace" || !resource.path) return false;
  await postJson("/workspace/resource/copy", {
    path: resource.path,
    mode,
    ...(mode === "contents" ? { maxBytes: 2_000_000 } : {}),
  });
  return true;
}

async function revealResource(resource: ChatResourceRef): Promise<void> {
  if (await openLocalChatResource(resource, "finder")) return;
  await openResourceExternally(resource);
}

async function openResourceExternally(resource: ChatResourceRef): Promise<void> {
  if (await openLocalChatResource(resource, "system")) return;
  const target = rawUrlForResource(resource) || resource.uri || resource.imageUri || resource.path;
  if (target && typeof window !== "undefined") {
    window.open(apiUrl(target), "_blank", "noopener,noreferrer");
  }
}

function rawUrlForResource(resource: ChatResourceRef): string | undefined {
  if (resource.origin === "workspace" && resource.path) {
    return apiUrl(`/workspace/resource/raw?${new URLSearchParams({ path: resource.path }).toString()}`);
  }
  if (resource.origin === "mounted-app" && resource.appId && resource.path) {
    return apiUrl(
      `/apps/${encodeURIComponent(resource.appId)}/raw?${new URLSearchParams({ path: resource.path }).toString()}`,
    );
  }
  if (resource.origin === "generated" || resource.origin === "vault") {
    return apiUrl(resource.uri || resource.imageUri || "");
  }
  if (resource.origin === "artifact" && resource.imageUri) {
    return resource.imageUri;
  }
  if (resource.origin === "http") {
    return resource.uri || resource.imageUri;
  }
  return resource.uri || resource.imageUri;
}

function mimeTypeFromName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "md" || extension === "markdown") return "text/markdown; charset=utf-8";
  if (["txt", "log"].includes(extension)) return "text/plain; charset=utf-8";
  if (extension === "pdf") return "application/pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(extension)) {
    return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  }
  if (["mp4", "webm", "mov"].includes(extension)) return extension === "mov" ? "video/quicktime" : `video/${extension}`;
  if (["mp3", "wav", "m4a", "ogg"].includes(extension))
    return extension === "mp3" ? "audio/mpeg" : `audio/${extension}`;
  return undefined;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.split(/[?#]/)[0] || "";
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // non-critical-fallback: Some embedded browser contexts expose the Clipboard API but deny writes.
      // Keep the user gesture alive and fall back to the older textarea copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  textarea.style.top = "0";
  textarea.setAttribute("readonly", "true");
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Copy is not available in this browser context.");
  }
}
