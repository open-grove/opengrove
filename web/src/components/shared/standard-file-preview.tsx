// vidstack 样式随主包加载；播放器 JS 经 React.lazy 拆成异步 chunk（见 video-file-preview.tsx），
// 异步 chunk 的 CSS 不会被浏览器自动加载，因此样式必须留在 eager 入口。
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

import { FileText, LoaderCircle } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { FlowPreview } from "./flow-preview";
import { MarkdownPreview } from "../knowledge/markdown-preview";
import {
  unsupportedStandardPreviewCopy,
  type PreviewableFile,
  type StandardFileCapability,
} from "./standard-file-capabilities";

const LazyVideoFilePreview = lazy(() =>
  import("./video-file-preview").then((module) => ({ default: module.VideoFilePreview })),
);

export function StandardFilePreview(props: {
  capability: StandardFileCapability;
  file: PreviewableFile;
  rawUrl?: string;
  onActivate?(): void;
}) {
  const { t } = useI18n();
  const { capability, file, rawUrl } = props;

  if (capability.preview.kind === "flow") {
    return (
      <div className="file-preview-markdown-shell">
        <FlowPreview text={file.content ?? ""} />
        {file.contentTruncated ? <div className="file-preview-truncated">{t("filePreview.truncated")}</div> : null}
      </div>
    );
  }

  if (capability.preview.kind === "markdown") {
    return (
      <div className="file-preview-markdown-shell">
        <MarkdownPreview text={file.content ?? ""} format="markdown" onActivate={props.onActivate} />
        {file.contentTruncated ? <div className="file-preview-truncated">{t("filePreview.truncated")}</div> : null}
      </div>
    );
  }

  if (capability.preview.kind === "source") {
    return (
      <div className="file-preview-source-shell">
        <pre className="standard-source-preview" onClick={props.onActivate}>
          <code>{file.content || " "}</code>
        </pre>
        {file.contentTruncated ? <div className="file-preview-truncated">{t("filePreview.truncated")}</div> : null}
      </div>
    );
  }

  if (rawUrl && capability.preview.kind === "image") {
    return (
      <div className="file-preview-media-frame">
        <img className="file-preview-media" src={rawUrl} alt={file.name} />
      </div>
    );
  }

  if (rawUrl && capability.preview.kind === "video") {
    return (
      <Suspense fallback={<VideoPreviewFallback />}>
        <LazyVideoFilePreview fileName={file.name} src={rawUrl} />
      </Suspense>
    );
  }

  if (rawUrl && capability.preview.kind === "audio") {
    return (
      <div className="file-preview-audio-frame">
        <audio src={rawUrl} controls />
      </div>
    );
  }

  if (rawUrl && capability.preview.kind === "pdf") {
    return (
      <div className="file-preview-doc-viewer">
        <iframe className="file-preview-embed" title={file.name} src={rawUrl} />
      </div>
    );
  }

  if (capability.canPreview && !rawUrl && capability.preview.kind !== "unsupported") {
    return (
      <StandardPreviewEmpty
        icon={<FileText size={20} />}
        title={t("filePreview.noPreviewUrl")}
        copy={file.mimeType || file.name}
      />
    );
  }

  return (
    <StandardPreviewEmpty
      icon={<FileText size={20} />}
      title={t("filePreview.unsupported")}
      copy={unsupportedStandardPreviewCopy(capability, file)}
    />
  );
}

function VideoPreviewFallback() {
  const { t } = useI18n();
  return (
    <div className="file-preview-empty mounted-app-preview-empty" role="status">
      <LoaderCircle size={20} className="spin" aria-hidden="true" />
      <strong>{t("filePreview.videoLoading")}</strong>
    </div>
  );
}

function StandardPreviewEmpty(props: { icon: ReactNode; title: string; copy?: string }) {
  return (
    <div className="file-preview-empty mounted-app-preview-empty">
      {props.icon}
      <strong>{props.title}</strong>
      {props.copy ? <p>{props.copy}</p> : null}
    </div>
  );
}
