import { Children, createContext, isValidElement, useContext, useState, type MouseEvent, type ReactNode } from "react";
import { Download, Maximize2, PackagePlus } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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

const ChatMarkdownRenderOptionsContext = createContext<ChatMarkdownRenderOptions | null>(null);
const CHAT_MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownPre,
  code: MarkdownCode,
  p: MarkdownParagraph,
  a: MarkdownAnchor,
  img: MarkdownImage,
  table: MarkdownTable,
};

export function ChatMarkdownRenderer(props: { markdown: string } & ChatMarkdownRenderOptions) {
  const { markdown, ...options } = props;
  return (
    <ChatMarkdownRenderOptionsContext.Provider value={options}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS} skipHtml>
        {markdown}
      </ReactMarkdown>
    </ChatMarkdownRenderOptionsContext.Provider>
  );
}

function useChatMarkdownRenderOptions(): ChatMarkdownRenderOptions {
  const options = useContext(ChatMarkdownRenderOptionsContext);
  if (!options) {
    throw new Error("Markdown components must render inside ChatMarkdownRenderer");
  }
  return options;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const options = useChatMarkdownRenderOptions();
  return <ChatImageNode src={src} alt={alt} options={options} />;
}

type CodeProps = {
  className?: string;
  children?: ReactNode;
};

function MarkdownCode({ className, children }: CodeProps) {
  const text = String(children ?? "");
  // react-markdown v10:fenced code 走 <pre><code class="language-xxx">。
  // 块级外壳由 pre override 负责,code 自身只返回合法 <code>。
  const isFenced = Boolean(className?.startsWith("language-")) || text.includes("\n");
  if (isFenced) {
    return <code className={className}>{text.replace(/\n$/, "")}</code>;
  }
  // inline code 永远是纯 <code>,不资源化(Phase 1 决策)。
  return <code className="thread-md-inline-code">{children}</code>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const codeChild = Children.toArray(children).find((child) => isValidElement<{ className?: string }>(child));
  const className = isValidElement<{ className?: string }>(codeChild) ? codeChild.props.className || "" : "";
  const lang = className.replace(/^language-/, "").trim();
  return (
    <div className="thread-code-block">
      {lang ? <div className="thread-code-lang">{lang}</div> : null}
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const nodes = Children.toArray(children);
  if (!nodes.some(isChatImageElement)) {
    return <p className="thread-md-p">{children}</p>;
  }

  const blocks: ReactNode[] = [];
  let inlineNodes: ReactNode[] = [];
  const flushInline = () => {
    if (!inlineNodes.some(isMeaningfulInlineNode)) {
      inlineNodes = [];
      return;
    }
    blocks.push(
      <p className="thread-md-p" key={`p-${blocks.length}`}>
        {inlineNodes}
      </p>,
    );
    inlineNodes = [];
  };

  nodes.forEach((node) => {
    if (isChatImageElement(node)) {
      flushInline();
      blocks.push(node);
      return;
    }
    inlineNodes.push(node);
  });
  flushInline();

  return <>{blocks}</>;
}

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const options = useChatMarkdownRenderOptions();
  const label = nodeToText(children);
  const target = String(href || "");
  return renderChatMarkdownLink(label, target, options);
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="thread-md-table-wrap">
      <table className="thread-md-table">{children}</table>
    </div>
  );
}

// ===== image:复用 Phase 1 的 figure/预览/下载/存成果 交互 =====

function ChatImageNode(props: { src?: string; alt?: string; options: ChatMarkdownRenderOptions }) {
  const safeSrc = String(props.src || "");
  if (!safeSrc || !isSafeRenderableImageSrc(safeSrc)) {
    return null;
  }
  const image: ChatImagePayload = { src: renderableImageSrc(safeSrc), alt: String(props.alt || "") };
  return (
    <ChatRenderedImage
      image={image}
      onPreview={props.options.onPreviewImage}
      onSaveArtifact={props.options.onSaveImageArtifact}
    />
  );
}

function isChatImageElement(node: ReactNode): boolean {
  return isValidElement(node) && node.type === MarkdownImage;
}

function isMeaningfulInlineNode(node: ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  return node != null && node !== false;
}

function ChatRenderedImage(props: {
  image: ChatImagePayload;
  onPreview?(image: ChatImagePayload): void;
  onSaveArtifact?(image: ChatImagePayload): void;
}) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const fileName = fileNameFromImageSrc(props.image.src);
  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    blurActiveElement();
    props.onPreview?.(props.image);
  };
  const download = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDownloading(true);
    setDownloadError("");
    void downloadBridgeFile(props.image.src, fileName)
      .catch((error) => setDownloadError(markdownImageDownloadErrorMessage(error, t)))
      .finally(() => setDownloading(false));
  };
  return (
    <figure className="thread-image-figure">
      <div className="thread-image-frame">
        <button
          type="button"
          className="thread-image-preview-button"
          onClick={openPreview}
          aria-label={t("chat.previewImageAria", { name: props.image.alt || fileName })}
        >
          <img className="thread-rendered-image" src={props.image.src} alt={props.image.alt} />
        </button>
        <span className="thread-image-action-buttons">
          <button
            type="button"
            className="thread-image-action"
            onClick={openPreview}
            aria-label={t("chat.previewAria", { name: props.image.alt || fileName })}
            title={t("thread.resourcePreview")}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="thread-image-action"
            onClick={download}
            disabled={downloading}
            aria-label={t("chat.downloadAria", { name: props.image.alt || fileName })}
            title={t("filePreview.download")}
          >
            <Download size={13} />
          </button>
          {props.onSaveArtifact ? (
            <button
              type="button"
              className="thread-image-action"
              onClick={() => props.onSaveArtifact?.(props.image)}
              aria-label={t("chat.saveToArtifactsAria", { name: props.image.alt || fileName })}
              title={t("chat.saveToArtifacts")}
            >
              <PackagePlus size={13} />
            </button>
          ) : null}
        </span>
      </div>
      <figcaption className="thread-image-caption">{props.image.alt || fileName}</figcaption>
      {downloadError ? (
        <span className="thread-image-download-error" role="alert">
          {downloadError}
        </span>
      ) : null}
    </figure>
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

function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

// ===== chat markdown link:外链/资源/命令分流(Phase 3 resolver)=====

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

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  return "";
}

function fileNameFromImageSrc(src: string): string {
  try {
    const url = new URL(src, "http://localhost");
    const name = url.pathname.split("/").filter(Boolean).at(-1);
    return name || "image";
  } catch {
    return "image";
  }
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
