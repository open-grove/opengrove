import { translate } from "../../i18n";
import type { MarkdownCodeEditorFormat } from "../knowledge/markdown-code-editor";

export type PreviewableFile = {
  name: string;
  path: string;
  mimeType?: string;
  content?: string;
  contentTruncated?: boolean;
};

export type StandardFileKind =
  | "flow"
  | "markdown"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "binary";

export type StandardFilePreviewKind =
  | "flow"
  | "markdown"
  | "source"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "unsupported";

export type StandardFileCapability = {
  kind: StandardFileKind;
  label: string;
  extension: string;
  canPreview: boolean;
  editable: boolean;
  preview: {
    kind: StandardFilePreviewKind;
    label: string;
    selectableText: boolean;
  };
  editor?: {
    kind: "codemirror";
    label: string;
    language: MarkdownCodeEditorFormat;
  };
};

export function resolveStandardFileCapability(
  file: PreviewableFile | undefined,
  selectedPath: string,
): StandardFileCapability {
  const path = selectedPath || file?.path || file?.name || "";
  const extension = fileExtension(path);
  const mimeType = normalizeMimeType(file?.mimeType);

  if (/\.flow\.md$/i.test(path)) {
    return textCapability("flow", "Flow", extension, "flow", "markdown");
  }
  if (mimeType.includes("markdown") || MARKDOWN_EXTENSIONS.has(extension)) {
    return textCapability("markdown", "Markdown", extension, "markdown", "markdown");
  }
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return mediaCapability("image", translate("filePreview.kindImage"), extension, "image");
  }
  if (mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return mediaCapability("video", translate("filePreview.kindVideo"), extension, "video");
  }
  if (mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) {
    return mediaCapability("audio", translate("filePreview.kindAudio"), extension, "audio");
  }
  if (mimeType === "application/pdf" || extension === "pdf") {
    return mediaCapability("pdf", "PDF", extension, "pdf");
  }
  if (isTextLike(mimeType, extension)) {
    const language = editorLanguageForTextFile(mimeType, extension);
    const label = languageLabel(language, extension);
    return textCapability("text", label, extension, "source", language);
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return unsupportedCapability("document", translate("filePreview.kindDocument"), extension);
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return unsupportedCapability("spreadsheet", translate("filePreview.kindSpreadsheet"), extension);
  }
  if (PRESENTATION_EXTENSIONS.has(extension)) {
    return unsupportedCapability("presentation", translate("filePreview.kindPresentation"), extension);
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return unsupportedCapability("archive", translate("filePreview.kindArchive"), extension);
  }
  return unsupportedCapability("binary", translate("filePreview.kindBinary"), extension);
}

export function unsupportedStandardPreviewCopy(capability: StandardFileCapability, file: PreviewableFile): string {
  const type = capability.extension ? `.${capability.extension}` : file.mimeType || file.name;
  if (capability.kind === "document") return translate("filePreview.unsupportedDocument", { type });
  if (capability.kind === "spreadsheet") return translate("filePreview.unsupportedSpreadsheet", { type });
  if (capability.kind === "presentation") return translate("filePreview.unsupportedPresentation", { type });
  if (capability.kind === "archive") return translate("filePreview.unsupportedArchive", { type });
  return file.mimeType || file.name;
}

function textCapability(
  kind: "flow" | "markdown" | "text",
  label: string,
  extension: string,
  previewKind: "flow" | "markdown" | "source",
  language: MarkdownCodeEditorFormat,
): StandardFileCapability {
  return {
    kind,
    label,
    extension,
    canPreview: true,
    editable: true,
    preview: {
      kind: previewKind,
      label,
      selectableText: true,
    },
    editor: {
      kind: "codemirror",
      label,
      language,
    },
  };
}

function mediaCapability(
  kind: "image" | "video" | "audio" | "pdf",
  label: string,
  extension: string,
  previewKind: "image" | "video" | "audio" | "pdf",
): StandardFileCapability {
  return {
    kind,
    label,
    extension,
    canPreview: true,
    editable: false,
    preview: {
      kind: previewKind,
      label,
      selectableText: false,
    },
  };
}

function unsupportedCapability(
  kind: Exclude<StandardFileKind, "markdown" | "text" | "image" | "video" | "audio" | "pdf">,
  label: string,
  extension: string,
): StandardFileCapability {
  return {
    kind,
    label,
    extension,
    canPreview: false,
    editable: false,
    preview: {
      kind: "unsupported",
      label,
      selectableText: false,
    },
  };
}

function normalizeMimeType(mimeType: string | undefined): string {
  return ((mimeType || "").split(";")[0] ?? "").trim().toLowerCase();
}

function editorLanguageForTextFile(mimeType: string, extension: string): MarkdownCodeEditorFormat {
  if (mimeType.includes("json") || extension === "json" || extension === "jsonl") return "json";
  if (mimeType.includes("yaml") || extension === "yaml" || extension === "yml") return "yaml";
  if (mimeType.includes("html") || extension === "html" || extension === "htm") return "html";
  if (mimeType.includes("css") || CSS_EXTENSIONS.has(extension)) return "css";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return extension === "jsx" ? "jsx" : "javascript";
  if (["ts", "tsx"].includes(extension)) return extension === "tsx" ? "tsx" : "typescript";
  return extension || "text";
}

function languageLabel(language: MarkdownCodeEditorFormat, extension: string): string {
  switch (language) {
    case "yaml":
      return "YAML";
    case "json":
      return "JSON";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "javascript":
    case "jsx":
      return "JavaScript";
    case "typescript":
    case "tsx":
      return "TypeScript";
    default:
      return extension
        ? translate("filePreview.kindTextWithExtension", { extension })
        : translate("filePreview.kindText");
  }
}

function isTextLike(mimeType: string, extension: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("yaml") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType.includes("toml") ||
    mimeType.includes("sql") ||
    TEXT_EXTENSIONS.has(extension)
  );
}

function fileExtension(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const CSS_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "csv",
  "tsv",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "kt",
  "kts",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "srt",
  "vtt",
  "ass",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "tif", "tiff"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mkv", "ogv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "odt", "rtf"]);
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "ods"]);
const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "odp"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar"]);
