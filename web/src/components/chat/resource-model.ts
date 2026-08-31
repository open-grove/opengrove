import type { ActivityArtifactCard } from "./message-activity-model";
import { isImageArtifactKind } from "./message-activity-model";

export type ChatResourceKind = "file" | "url" | "artifact" | "image" | "memory-citation" | "diff-file";
export type ChatResourceOrigin =
  | "workspace"
  | "mounted-app"
  | "local"
  | "knowledge"
  | "artifact"
  | "artifact-asset"
  | "vault"
  | "generated"
  | "http";
export type ChatResourceSource = "markdown" | "tool" | "artifact" | "citation" | "diff" | "attachment";
export type ChatResourceAction = "open" | "preview" | "copy-path" | "copy-contents" | "reveal";

export interface ChatResourceContext {
  origin?: Extract<ChatResourceOrigin, "workspace" | "mounted-app">;
  appId?: string;
  workspaceRoot?: string;
}

export interface ChatResourceRef {
  id: string;
  kind: ChatResourceKind;
  origin: ChatResourceOrigin;
  title: string;
  subtitle?: string;
  path?: string;
  uri?: string;
  imageUri?: string;
  mimeType?: string;
  appId?: string;
  line?: number;
  column?: number;
  endLine?: number;
  source?: ChatResourceSource;
  /** 显式声明该资源支持的 UI 动作(§9.2)。未声明时由消费方按 kind 兜底。 */
  actions?: ChatResourceAction[];
  raw?: unknown;
}

// ===== resolver:Markdown link 静态路径校验(§14 决策 — 不存在/越界降级为普通 link)=====

/**
 * 校验 Markdown 文件引用是否可安全升级为 ResourceRef。
 *
 * 渲染期为纯静态校验:确认来源可信(http/generated/vault)或 workspace 路径合法且不越界。
 * 真实文件存在性在打开时由消费方异步校验 —— SSR 无法同步探文件系统。
 *
 * 返回 ChatResourceRef 表示可升级;返回 null 表示降级为普通 link。
 */
export function resolveMarkdownFileResource(input: {
  key: string;
  label: string;
  href: string;
  context?: ChatResourceContext;
}): ChatResourceRef | null {
  const rawHref = input.href.trim().replace(/^<(.+)>$/, "$1");
  const decodedHref = decodeSafe(rawHref);
  if (isNonFileMarkdownHref(decodedHref)) {
    return null;
  }
  // 提取 line 后缀(#L12 或 :12),剩余为纯路径,用于边界校验。
  const lineMatch = decodedHref.match(/(?:#L|:)(\d+)(?::\d+)?$/);
  const line = lineMatch ? Number(lineMatch[1]) || undefined : undefined;
  const hrefPath = decodedHref.replace(/#L\d+(?::\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  const resourcePath = normalizeContextResourcePath(hrefPath, input.context);
  const staticOrigin = staticRouteOrigin(resourcePath);
  // 已知可信来源(generated/vault artifact)一定可升级。
  if (staticOrigin === "generated" || staticOrigin === "vault") {
    return resourceFromMarkdownFile({
      key: input.key,
      name: input.label,
      path: resourcePath,
      line,
      source: "markdown",
      context: input.context,
    });
  }
  if (!line && isRootRelativeApplicationRoute(resourcePath)) {
    return null;
  }
  // 工作区外的本机绝对路径只能交给文件管理器定位，不升级为可读取资源。
  if (isAbsoluteLocalPath(resourcePath)) {
    return resourceFromLocalPath({
      key: input.key,
      name: input.label,
      path: resourcePath,
      line,
      source: "markdown",
    });
  }
  // workspace 路径:校验合法且不越界。不合法 → 降级为普通文本。
  if (!looksLikeMarkdownFilePath(resourcePath) || !isSafeWorkspacePath(resourcePath)) {
    return null;
  }
  return resourceFromMarkdownFile({
    key: input.key,
    name: input.label,
    path: resourcePath,
    line,
    source: "markdown",
    context: input.context,
  });
}

function isNonFileMarkdownHref(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("#") || normalized.startsWith("?")) return true;
  // Reject every URI scheme form, not only scheme://. This covers mailto:, data:, javascript:, etc.
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return true;
  return false;
}

function looksLikeMarkdownFilePath(path: string): boolean {
  const pathOnly = path.trim().replace(/\\/g, "/").split(/[?#]/)[0] || "";
  if (!pathOnly) return false;
  if (fileExtension(pathOnly)) return true;
  return pathOnly.includes("/");
}

/**
 * workspace 路径静态合法性:禁止绝对/父级穿越/协议 URI。
 * 允许相对路径(含 ./(同目录)但不允许 ../ 跨界)。
 */
function isSafeWorkspacePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return false;
  if (/^([a-zA-Z]:)?[\\/]/.test(normalized)) return false;
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) return false;
  return true;
}

function isAbsoluteLocalPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function isRootRelativeApplicationRoute(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/").split(/[?#]/)[0] || "";
  if (normalized === "/") return true;
  if (fileExtension(normalized)) return false;
  return ["/api", "/auth", "/docs", "/settings"].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileExtension(name: string): string {
  const match = name.match(/\.([A-Za-z][A-Za-z0-9]{0,7})$/);
  return match?.[1]?.toLowerCase() || "";
}

export function chatResourceId(prefix: string, value: string): string {
  return `${prefix}:${value}`.replace(/\s+/g, " ").slice(0, 220);
}

export function resourceFromMarkdownFile(input: {
  key: string;
  name: string;
  path: string;
  line?: number;
  source?: ChatResourceSource;
  context?: ChatResourceContext;
}): ChatResourceRef {
  const origin =
    staticRouteOrigin(input.path) ??
    (input.context?.origin === "mounted-app" && input.context.appId ? "mounted-app" : "workspace");
  return {
    id: chatResourceId("markdown-file", `${input.path}:${input.line ?? ""}:${input.key}`),
    kind: origin === "generated" || origin === "vault" ? "artifact" : "file",
    origin,
    title: input.name,
    subtitle: input.line ? `line ${input.line}` : input.path,
    path: origin === "workspace" || origin === "mounted-app" ? input.path : undefined,
    appId: origin === "mounted-app" ? input.context?.appId : undefined,
    uri: origin === "generated" || origin === "vault" ? input.path : undefined,
    line: input.line,
    source: input.source ?? "markdown",
    actions: fileResourceActions(origin),
  };
}

/** 按 origin 显式声明文件类资源可用动作(§9.2)。 */
function fileResourceActions(origin: ChatResourceOrigin): ChatResourceAction[] {
  if (origin === "http") return ["open", "copy-contents"];
  if (origin === "knowledge") return ["preview", "copy-contents"];
  if (origin === "local") return ["reveal", "copy-path"];
  if (origin === "generated" || origin === "vault") return ["preview", "open", "reveal"];
  return ["preview", "open", "reveal", "copy-path", "copy-contents"];
}

export function resourceFromUrl(input: {
  key: string;
  title: string;
  uri: string;
  source?: ChatResourceSource;
}): ChatResourceRef {
  return {
    id: chatResourceId("url", `${input.uri}:${input.key}`),
    kind: "url",
    origin: "http",
    title: input.title || input.uri,
    subtitle: input.uri,
    uri: input.uri,
    source: input.source ?? "markdown",
    actions: ["open", "copy-contents"],
  };
}

function resourceFromLocalPath(input: {
  key: string;
  name: string;
  path: string;
  line?: number;
  source: ChatResourceSource;
  raw?: unknown;
}): ChatResourceRef {
  return {
    id: chatResourceId("local-path", `${input.path}:${input.line ?? ""}:${input.key}`),
    kind: "file",
    origin: "local",
    title: input.name,
    subtitle: input.line ? `line ${input.line}` : input.path,
    path: input.path,
    line: input.line,
    source: input.source,
    actions: fileResourceActions("local"),
    raw: input.raw,
  };
}

export function artifactCardToResource(
  card: ActivityArtifactCard,
  context?: ChatResourceContext,
): ChatResourceRef | null {
  const knowledgeId = card.knowledgeId?.trim();
  if (knowledgeId) {
    return {
      id: chatResourceId("artifact-knowledge", `${card.id}:${knowledgeId}`),
      kind: "artifact",
      origin: "knowledge",
      title: card.title,
      subtitle: card.summary || knowledgeId,
      path: knowledgeId,
      source: "artifact",
      actions: ["preview", "copy-contents"],
      raw: card,
    };
  }
  const imageUri = card.imageUri.trim();
  const uri = card.uri.trim();
  const rawPath = card.path.trim();
  const path = normalizeContextResourcePath(rawPath, context);
  const staticOrigin = staticRouteOrigin(uri || imageUri || path);
  const httpTarget = [uri, imageUri].find((value) => /^https?:\/\//i.test(value));
  if (httpTarget) {
    return {
      id: chatResourceId("artifact-url", `${card.id}:${httpTarget}`),
      kind: imageUri ? "image" : "artifact",
      origin: "http",
      title: card.title,
      subtitle: card.summary || httpTarget,
      uri: httpTarget,
      imageUri: imageUri || undefined,
      source: "artifact",
      raw: card,
    };
  }
  if (staticOrigin) {
    const target = uri || imageUri || path;
    return {
      id: chatResourceId("artifact-static", `${card.id}:${target}`),
      kind: imageUri || isImageArtifactKind(card.kind) ? "image" : "artifact",
      origin: staticOrigin,
      title: card.title,
      subtitle: card.summary || target,
      uri: target,
      imageUri: imageUri || undefined,
      source: "artifact",
      raw: card,
    };
  }
  if (path && isAbsoluteLocalPath(path)) {
    return resourceFromLocalPath({
      key: card.id,
      name: card.title,
      path,
      source: "artifact",
      raw: card,
    });
  }
  if (path && looksLikeActionablePath(path)) {
    const origin = context?.origin === "mounted-app" && context.appId ? "mounted-app" : "workspace";
    const subtitle = card.summary && card.summary !== rawPath ? card.summary : path;
    return {
      id: chatResourceId("artifact-path", `${card.id}:${path}`),
      kind: isImageArtifactKind(card.kind) ? "image" : "artifact",
      origin,
      title: card.title,
      subtitle,
      path,
      appId: origin === "mounted-app" ? context?.appId : undefined,
      source: "artifact",
      raw: card,
    };
  }
  if (card.id) {
    return {
      id: chatResourceId("artifact", card.id),
      kind: imageUri || isImageArtifactKind(card.kind) ? "image" : "artifact",
      origin: "artifact",
      title: card.title,
      subtitle: card.summary || card.id,
      path: card.id,
      imageUri: imageUri || undefined,
      mimeType: card.mimeType || undefined,
      source: "artifact",
      actions: ["preview", "copy-contents"],
      raw: card,
    };
  }
  return null;
}

export function staticRouteOrigin(value: string): Extract<ChatResourceOrigin, "generated" | "vault"> | undefined {
  if (value.startsWith("/generated/")) return "generated";
  if (value.startsWith("/vault-file/")) return "vault";
  return undefined;
}

export function resourceDisplayPath(resource: ChatResourceRef): string {
  return resource.path || resource.uri || resource.imageUri || resource.title;
}

export function resourceFileName(resource: ChatResourceRef): string {
  const value = resource.path || resource.uri || resource.imageUri || resource.title;
  return value.split(/[\\/]/).filter(Boolean).at(-1)?.split(/[?#]/)[0] || resource.title || "resource";
}

export function looksLikeActionablePath(value: string): boolean {
  return Boolean(value && !/^[a-z][a-z0-9+.-]*:/i.test(value));
}

function normalizeContextResourcePath(path: string, context?: ChatResourceContext): string {
  const normalizedPath = path.trim().replace(/\\/g, "/");
  const contextRoot = context?.workspaceRoot?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedPath || !contextRoot) return normalizedPath;
  const workspaceRoot = mountedAppResourceRoot(contextRoot, context);
  if (normalizedPath === workspaceRoot) return "";
  const prefix = `${workspaceRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return normalizedPath;
  return normalizedPath.slice(prefix.length).replace(/^\/+/, "");
}

function mountedAppResourceRoot(root: string, context?: ChatResourceContext): string {
  if (context?.origin !== "mounted-app") return root;
  const workspaceSegment = "/workspace/";
  const workspaceIndex = root.lastIndexOf(workspaceSegment);
  if (workspaceIndex >= 0) {
    return root.slice(0, workspaceIndex + "/workspace".length);
  }
  return root;
}

export function resolveRoomMessageResourceContext(
  member: Pick<ChatResourceContext, "appId" | "workspaceRoot"> | undefined,
  fallbackWorkspaceRoot?: string,
): ChatResourceContext | undefined {
  const appId = member?.appId?.trim();
  const workspaceRoot = member?.workspaceRoot?.trim() || fallbackWorkspaceRoot?.trim();
  if (appId) {
    return {
      origin: "mounted-app",
      appId,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    };
  }
  return workspaceRoot ? { origin: "workspace", workspaceRoot } : undefined;
}
