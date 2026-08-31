import type { AppBridge, McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { EmbeddedResource, ResourceLink } from "@modelcontextprotocol/sdk/types.js";

// ADR 0048:宿主 UI 能力唯一注册表。能力的对外声明(declare)与处理器绑定(bind)
// 必须在同一个 entry 里成对出现,并且对所有平台一致——平台差异只允许出现在
// handler 的实现内部(通过 deps 注入),不允许出现在能力面上。
// 新增能力 = 新增一个 entry;禁止在渲染组件里单独声明能力或按 platform 分支。

export const MAX_EXTERNAL_LINK_LENGTH = 4_096;
export const MAX_DOWNLOAD_FILE_COUNT = 5;
export const MAX_DOWNLOAD_FILE_LENGTH = 8 * 1024 * 1024;
export const MAX_DOWNLOAD_FILE_NAME_LENGTH = 120;

export interface McpAppSandboxPolicy {
  csp: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions: Record<string, Record<string, never>>;
}

/** 已通过宿主校验、可直接交给用户确认与保存的下载条目。 */
export interface McpAppDownloadFile {
  name: string;
  mimeType: string;
  /** 内联资源:文本或 base64 二进制,二者只会出现一个。 */
  text?: string;
  base64?: string;
  /** 链接资源:已校验为 http(s) 的绝对地址。 */
  href?: string;
}

export interface HostCapabilityDeps {
  sandboxPolicy: McpAppSandboxPolicy;
  /** 弹出用户确认并在用户选择后 settle;平台差异(浏览器/Electron 外链路径)在实现内部。 */
  requestExternalLink(externalUrl: URL): Promise<{ isError?: boolean }>;
  /** 弹出用户确认并在同意后落盘;宿主永不静默写文件。 */
  requestFileDownload(files: McpAppDownloadFile[]): Promise<{ isError?: boolean }>;
  isViewActive(): boolean;
}

interface HostCapabilityEntry {
  name: keyof McpUiHostCapabilities;
  declare(deps: HostCapabilityDeps): Partial<McpUiHostCapabilities>;
  bind?(bridge: AppBridge, deps: HostCapabilityDeps): void;
}

const HOST_UI_CAPABILITY_ENTRIES: HostCapabilityEntry[] = [
  {
    name: "openLinks",
    declare: () => ({ openLinks: {} }),
    bind: (bridge, deps) => {
      bridge.onopenlink = async ({ url }) => {
        if (!deps.isViewActive()) return { isError: true };
        if (typeof url !== "string" || url.length > MAX_EXTERNAL_LINK_LENGTH) {
          return { isError: true };
        }
        const externalUrl = safeExternalUrl(url);
        if (!externalUrl) return { isError: true };
        return deps.requestExternalLink(externalUrl);
      };
    },
  },
  {
    name: "downloadFile",
    declare: () => ({ downloadFile: {} }),
    bind: (bridge, deps) => {
      bridge.ondownloadfile = async ({ contents }) => {
        if (!deps.isViewActive()) return { isError: true };
        if (!Array.isArray(contents) || !contents.length || contents.length > MAX_DOWNLOAD_FILE_COUNT) {
          return { isError: true };
        }
        const files: McpAppDownloadFile[] = [];
        for (const item of contents) {
          const file = downloadFileFromContent(item);
          if (!file) return { isError: true };
          files.push(file);
        }
        return deps.requestFileDownload(files);
      };
    },
  },
  {
    // 工具/资源代理与日志由 AppBridge 内建路由到 contract server,无需额外 handler。
    name: "serverTools",
    declare: () => ({ serverTools: {} }),
  },
  {
    name: "serverResources",
    declare: () => ({ serverResources: {} }),
  },
  {
    name: "logging",
    declare: () => ({ logging: {} }),
  },
  {
    name: "sandbox",
    declare: (deps) => ({
      sandbox: {
        csp: deps.sandboxPolicy.csp,
        permissions: deps.sandboxPolicy.permissions,
      },
    }),
  },
];

export const HOST_UI_CAPABILITY_NAMES = HOST_UI_CAPABILITY_ENTRIES.map((entry) => entry.name);

export function declareHostCapabilities(deps: HostCapabilityDeps): McpUiHostCapabilities {
  return HOST_UI_CAPABILITY_ENTRIES.reduce<McpUiHostCapabilities>(
    (capabilities, entry) => ({ ...capabilities, ...entry.declare(deps) }),
    {},
  );
}

export function bindHostCapabilityHandlers(bridge: AppBridge, deps: HostCapabilityDeps): void {
  for (const entry of HOST_UI_CAPABILITY_ENTRIES) entry.bind?.(bridge, deps);
}

function safeExternalUrl(value: string): URL | undefined {
  let externalUrl: URL;
  try {
    externalUrl = new URL(value);
  } catch {
    return undefined;
  }
  if (externalUrl.protocol !== "http:" && externalUrl.protocol !== "https:") return undefined;
  return externalUrl;
}

function downloadFileFromContent(item: EmbeddedResource | ResourceLink): McpAppDownloadFile | undefined {
  if (item.type === "resource_link") {
    const href = safeExternalUrl(item.uri);
    if (!href) return undefined;
    return {
      name: downloadFileName(item.name || href.pathname),
      mimeType: downloadMimeType(item.mimeType),
      href: href.href,
    };
  }
  if (item.type !== "resource") return undefined;
  const resource = item.resource;
  const name = downloadFileName(resourceUriName(resource.uri));
  const mimeType = downloadMimeType(resource.mimeType);
  if ("text" in resource && typeof resource.text === "string") {
    if (resource.text.length > MAX_DOWNLOAD_FILE_LENGTH) return undefined;
    return { name, mimeType, text: resource.text };
  }
  if ("blob" in resource && typeof resource.blob === "string") {
    if (resource.blob.length > MAX_DOWNLOAD_FILE_LENGTH) return undefined;
    return { name, mimeType, base64: resource.blob };
  }
  return undefined;
}

function resourceUriName(uri: unknown): string {
  if (typeof uri !== "string") return "";
  const withoutQuery = uri.split(/[?#]/u)[0] ?? "";
  return withoutQuery.split("/").filter(Boolean).pop() ?? "";
}

function downloadFileName(value: string): string {
  const decoded = safeDecodeName(value.trim());
  const sanitized = decoded
    // 目录穿越与控制字符必须在文件名成型前就消失,宿主不依赖下游 API 兜底。
    .replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, "")
    .replace(/^[.\s]+/u, "")
    .trim();
  return sanitized.slice(0, MAX_DOWNLOAD_FILE_NAME_LENGTH) || "download";
}

function safeDecodeName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function downloadMimeType(value: unknown): string {
  return typeof value === "string" && /^[\w.+-]+\/[\w.+-]+$/u.test(value) ? value : "application/octet-stream";
}
