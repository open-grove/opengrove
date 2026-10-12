import type { ReactNode } from "react";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { SharedChatProvider } from "./shared-chat-provider";
import { apiUrl } from "../../api-base";
import { BridgeDownloadError, downloadBridgeFile } from "../../bridge-client";
import { useI18n } from "../../i18n";
import type { ChatImagePayload } from "./message-types";
import { ResourceLink } from "./resource-link";
import {
  resourceFromUrl,
  resolveMarkdownFileResource,
  type ChatResourceAction,
  type ChatResourceContext,
  type ChatResourceRef,
} from "./resource-model";

export type ChatMarkdownRenderOptions = {
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
};

export function ChatMarkdownRenderer(props: { markdown: string } & ChatMarkdownRenderOptions) {
  const { t } = useI18n();
  return (
    <SharedChatProvider>
      <ChatMarkdown
        markdown={props.markdown}
        onPreviewImage={props.onPreviewImage}
        onSaveImageArtifact={props.onSaveImageArtifact}
        renderLink={(label, href) => renderChatMarkdownLink(label, href, props)}
        resolveImageUrl={(src) => (isSafeRenderableImageSrc(src) ? renderableImageSrc(src) : undefined)}
        onDownloadImage={async (image, name) => {
          await downloadBridgeFile(image.src, name);
        }}
        downloadErrorMessage={(error) => markdownImageDownloadErrorMessage(error, t)}
      />
    </SharedChatProvider>
  );
}
function markdownImageDownloadErrorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof BridgeDownloadError) {
    if (error.kind === "auth") return t("filePreview.downloadAuthError");
    if (error.kind === "network") return t("filePreview.downloadNetworkError");
    if (error.kind === "timeout") return t("filePreview.downloadTimeoutError");
  }
  return t("filePreview.downloadFailed");
}

function renderChatMarkdownLink(label: string, href: string, options: ChatMarkdownRenderOptions): ReactNode {
  // http 外链 → url 资源
  if (/^https?:\/\//i.test(href)) {
    return (
      <ResourceLink
        className="thread-md-link"
        resource={resourceFromUrl({ key: href, title: label, uri: href, source: "markdown" })}
        onOpenResource={options.onOpenResource}
      >
        {label}
      </ResourceLink>
    );
  }
  // shell 命令 → inline code(§14 决策)
  if (looksLikeShellCommand(href) || looksLikeShellCommand(label)) {
    return <code className="thread-md-inline-code">{label}</code>;
  }
  // 文件引用 → resolver 根据消息上下文归一化路径并校验边界。
  const resource = resolveMarkdownFileResource({ key: href, label, href, context: options.resourceContext });
  if (resource) {
    return (
      <ResourceLink
        resource={resource}
        title={resource.subtitle || resource.title}
        onOpenResource={options.onOpenResource}
      >
        <span className="thread-md-file-name">{label}</span>
        {resource.line ? <span className="thread-md-file-line">(line {resource.line})</span> : null}
      </ResourceLink>
    );
  }
  // 无法归属到受信资源的路径不应伪装成可点链接。
  return <span title={href}>{label}</span>;
}

function looksLikeShellCommand(value: string): boolean {
  const normalized = value.trim();
  return (
    /(?:^|\s)--pairing-code(?:=|\s+)\S+/i.test(normalized) ||
    /(?:^|\s)--cloud-url(?:=|\s+)\S+/i.test(normalized) ||
    /(?:^|\s)--package(?:=|\s+)\S+/i.test(normalized) ||
    /^(?:npm|npx|pnpm|yarn|node|git|curl|python3?|pip3?|uv|opengrove)\s+/i.test(normalized)
  );
}

function isSafeRenderableImageSrc(src: string): boolean {
  return (
    src.startsWith("/generated/") ||
    src.startsWith("data:image/") ||
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(src)
  );
}

// forwarding-boundary: marks the API-origin conversion seam for renderable image URLs.
function renderableImageSrc(src: string): string {
  return apiUrl(src);
}
