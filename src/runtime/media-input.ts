import type { AgentAttachmentContext } from "../core.js";

export interface ParsedImageDataUrl {
  /** MIME type taken verbatim from the data URL, e.g. "image/png". */
  mediaType: string;
  /** Base64 payload with whitespace stripped, ready for SDK content blocks. */
  base64: string;
}

/**
 * Parse a `data:image/...;base64,...` URL into its MIME type and base64 payload.
 * Returns undefined for non-image or non-base64 data URLs so callers can skip
 * attachments their runtime cannot carry.
 */
export function parseImageDataUrl(dataUrl: string | undefined): ParsedImageDataUrl | undefined {
  if (!dataUrl) return undefined;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return undefined;
  const mediaType = match[1];
  const base64 = match[2];
  if (!mediaType || !base64) return undefined;
  return {
    mediaType: mediaType.toLowerCase(),
    base64: base64.replace(/\s/g, ""),
  };
}

/** Image attachments that carry a usable base64 image data URL. */
export function imageAttachmentsWithDataUrl(
  attachments: readonly AgentAttachmentContext[] | undefined,
): Array<{ attachment: AgentAttachmentContext; image: ParsedImageDataUrl }> {
  const result: Array<{ attachment: AgentAttachmentContext; image: ParsedImageDataUrl }> = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "image") continue;
    const image = parseImageDataUrl(attachment.dataUrl);
    if (image) result.push({ attachment, image });
  }
  return result;
}
