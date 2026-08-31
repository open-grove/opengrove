import type { AttachmentPayload, ContextArtifactPayload, MessageContext } from "../bridge";
import { APP_PRODUCT_NAME } from "../identity";

export function createSnapshot(
  context: { text: string } | null,
  attachments: AttachmentPayload[] = [],
): Record<string, unknown> {
  const text = context?.text || "";
  const hasExplicitContext = Boolean(text.trim() || attachments.length);
  return {
    title: hasExplicitContext ? APP_PRODUCT_NAME : "",
    url: hasExplicitContext ? location.href : "",
    selection: text,
    visibleText: text,
    locator: "standalone-ui",
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.size,
      text: attachment.kind === "text" ? attachment.text : undefined,
      dataUrl: attachment.dataUrl,
      thumbnailUrl: attachment.kind === "image" ? attachment.thumbnailUrl : undefined,
    })),
  };
}

export function buildContextPayload(
  baseText: string,
  attachments: AttachmentPayload[],
  artifacts: ContextArtifactPayload[],
): MessageContext {
  const selectedText = baseText.trim();
  const parts = [selectedText, renderArtifactContext(artifacts), renderAttachmentContext(attachments)].filter(Boolean);
  return {
    text: parts.join("\n\n"),
    selectedText,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.size,
      thumbnailUrl: attachment.kind === "image" ? attachment.thumbnailUrl : undefined,
      error: attachment.error,
    })),
    artifacts,
  };
}

function renderArtifactContext(artifacts: ContextArtifactPayload[]): string {
  if (!artifacts.length) {
    return "";
  }
  const lines = ["Context explicitly attached by the user:"];
  for (const artifact of artifacts) {
    lines.push(
      `- ${artifact.title} (${artifact.type}, id: ${artifact.id})${artifact.summary ? `: ${artifact.summary}` : ""}`,
    );
    if (artifact.imageUri) {
      lines.push(`  Image URI: ${artifact.imageUri}`);
    }
  }
  return lines.join("\n");
}

function renderAttachmentContext(attachments: AttachmentPayload[]): string {
  if (!attachments.length) {
    return "";
  }

  const lines = ["Attachments:"];
  for (const attachment of attachments) {
    const meta = `${attachment.name} · ${attachment.mimeType || "application/octet-stream"} · ${formatBytes(attachment.size)}`;
    if (attachment.kind === "image") {
      lines.push(
        `- [Image] ${meta}. If the current kernel supports native image input, OpenGrove also sends the image content.`,
      );
    } else if (attachment.kind === "text" && attachment.text) {
      lines.push(`- [Text file] ${meta}\n${attachment.text}`);
    } else {
      lines.push(
        `- [File] ${meta}${attachment.error ? `. ${attachment.error}` : ". The file is preserved as a local upload copy and provided as attachment context."}`,
      );
    }
  }
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
