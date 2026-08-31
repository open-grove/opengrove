import type { AgentEvent, ArtifactStore, JsonObject, JsonValue } from "../core.js";
import { visitSafeJsonValues } from "../core/safe-json.js";

export interface ExtractMediaArtifactsOptions {
  artifacts: ArtifactStore;
  question: string;
  events: AgentEvent[];
}

export function extractMediaArtifactsFromEvents(options: ExtractMediaArtifactsOptions): string[] {
  const { artifacts, question, events } = options;
  const artifactIds: string[] = [];
  const seenArtifactIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.finished" || !event.result.ok) {
      continue;
    }
    for (const media of extractMediaDescriptors(event.result.value)) {
      const existing = artifacts.findByMediaUri(media.uri);
      if (existing) {
        if (!seenArtifactIds.has(existing.id)) artifactIds.push(existing.id);
        seenArtifactIds.add(existing.id);
        continue;
      }
      const artifactType =
        media.kind === "image" ? "image" : media.kind === "audio" ? "audio" : media.kind === "video" ? "video" : "file";
      const title = media.title;
      const artifact = artifacts.create({
        type: artifactType,
        title,
        status: "generated",
        tags: dedupeIds(["artifact", "auto", "tool-result", media.kind, event.toolId]),
        data: {
          uri: media.uri,
          ...(media.kind === "image" ? { imageUri: media.uri } : {}),
          mimeType: media.mimeType ?? "",
          sourceToolId: event.toolId,
        },
        assets: [
          {
            kind: media.kind,
            uri: media.uri,
            title,
            mimeType: media.mimeType,
          },
        ],
        preview: {
          title,
          ...(media.kind === "image" ? { imageUri: media.uri } : {}),
          mimeType: media.mimeType,
          text: summarizeForArtifact(question),
        },
        sourceRefs: [
          {
            title: event.toolId,
            locator: `run:${event.runId}`,
          },
        ],
        provenance: {
          createdBy: "local-bridge.media-extractor",
          runId: event.runId,
          toolId: event.toolId,
        },
      });
      if (!seenArtifactIds.has(artifact.id)) artifactIds.push(artifact.id);
      seenArtifactIds.add(artifact.id);
    }
  }
  return artifactIds;
}

type MediaDescriptor = {
  kind: "image" | "audio" | "video" | "file";
  uri: string;
  title: string;
  mimeType?: string;
};

function extractMediaDescriptors(value: JsonValue | undefined): MediaDescriptor[] {
  const descriptors: MediaDescriptor[] = [];
  visitSafeJsonValues(value, ({ value: item }) => {
    if (typeof item === "string") {
      const descriptor = mediaDescriptorFromUri(item);
      if (descriptor) {
        descriptors.push(descriptor);
      }
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const object = item as JsonObject;
    for (const uri of mediaUrisFromObject(object)) {
      const descriptor = mediaDescriptorFromUri(uri.value, {
        kindHint: uri.kindHint,
        title:
          stringValue(object.title) ||
          stringValue(object.alt) ||
          stringValue(object.fileName) ||
          stringValue(object.name),
        mimeType: stringValue(object.mimeType) || stringValue(object.contentType) || uri.mimeType,
        allowGenericFile: uri.allowGenericFile,
      });
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }
  });
  const seen = new Set<string>();
  return descriptors.filter((item) => {
    if (seen.has(item.uri)) return false;
    seen.add(item.uri);
    return true;
  });
}

function mediaUrisFromObject(object: JsonObject): Array<{
  value: string;
  kindHint?: MediaDescriptor["kind"];
  mimeType?: string;
  allowGenericFile?: boolean;
}> {
  const candidates: Array<{
    key: string;
    kindHint?: MediaDescriptor["kind"];
    allowGenericFile?: boolean;
  }> = [
    { key: "generatedSrc", kindHint: "image" },
    { key: "imageUri", kindHint: "image" },
    { key: "imageUrl", kindHint: "image" },
    { key: "audioUri", kindHint: "audio" },
    { key: "audioUrl", kindHint: "audio" },
    { key: "videoUri", kindHint: "video" },
    { key: "videoUrl", kindHint: "video" },
    { key: "mediaUri", allowGenericFile: true },
    { key: "mediaUrl", allowGenericFile: true },
    { key: "fileUri", kindHint: "file", allowGenericFile: true },
    { key: "fileUrl", kindHint: "file", allowGenericFile: true },
    { key: "path", kindHint: "file", allowGenericFile: true },
    { key: "uri" },
    { key: "url" },
  ];
  const values: Array<{
    value: string;
    kindHint?: MediaDescriptor["kind"];
    mimeType?: string;
    allowGenericFile?: boolean;
  }> = [];
  for (const candidate of candidates) {
    const value = stringValue(object[candidate.key]);
    if (value) {
      values.push({
        value,
        kindHint: candidate.kindHint,
        mimeType: stringValue(object.mimeType) || stringValue(object.contentType),
        allowGenericFile: candidate.allowGenericFile,
      });
    }
  }
  for (const key of ["mediaUrls", "fileUrls", "files", "assets"]) {
    const array = object[key];
    if (!Array.isArray(array)) {
      continue;
    }
    for (const item of array) {
      if (typeof item === "string") {
        values.push({ value: item, allowGenericFile: key !== "assets" });
        continue;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entry = item as JsonObject;
        const value = stringValue(entry.uri) || stringValue(entry.url) || stringValue(entry.path);
        if (value) {
          values.push({
            value,
            kindHint: mediaKindFromMime(stringValue(entry.mimeType) || stringValue(entry.contentType)),
            mimeType: stringValue(entry.mimeType) || stringValue(entry.contentType),
            allowGenericFile: true,
          });
        }
      }
    }
  }
  return values;
}

function mediaDescriptorFromUri(
  value: string,
  options: {
    kindHint?: MediaDescriptor["kind"];
    title?: string;
    mimeType?: string;
    allowGenericFile?: boolean;
  } = {},
): MediaDescriptor | undefined {
  const uri = value.trim();
  if (!uri) {
    return undefined;
  }
  const mimeType = options.mimeType || mediaMimeTypeFromUri(uri);
  const kind = options.kindHint || mediaKindFromMime(mimeType) || mediaKindFromUri(uri);
  if (!kind) {
    return options.allowGenericFile && looksLikeFileUri(uri)
      ? { kind: "file", uri, title: options.title || fileNameFromUri(uri), mimeType }
      : undefined;
  }
  return {
    kind,
    uri,
    title: options.title || fileNameFromUri(uri),
    mimeType,
  };
}

function mediaKindFromUri(value: string): MediaDescriptor["kind"] | undefined {
  if (value.startsWith("data:image/")) return "image";
  if (value.startsWith("data:audio/")) return "audio";
  if (value.startsWith("data:video/")) return "video";
  if (value.startsWith("data:application/") || value.startsWith("data:text/")) return "file";
  const ext = extensionFromUri(value);
  if (!ext && value.startsWith("/generated/")) return "file";
  if (ext && ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext)) return "image";
  if (ext && ["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (ext && ["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) return "video";
  if (ext && ["pdf", "md", "txt", "json", "csv", "tsv", "yaml", "yml", "docx", "pptx", "xlsx", "zip"].includes(ext)) {
    return "file";
  }
  return undefined;
}

function mediaKindFromMime(value: string | undefined): MediaDescriptor["kind"] | undefined {
  const mimeType = value?.toLowerCase();
  if (!mimeType) return undefined;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("application/") || mimeType.startsWith("text/")) return "file";
  return undefined;
}

function mediaMimeTypeFromUri(value: string): string | undefined {
  const dataMatch = value.match(/^data:([^;,]+)/i);
  if (dataMatch?.[1]) {
    return dataMatch[1].toLowerCase();
  }
  const ext = extensionFromUri(value);
  if (!ext) {
    return undefined;
  }
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "md") return "text/markdown";
  if (ext === "txt") return "text/plain";
  if (ext === "json") return "application/json";
  if (ext === "pdf") return "application/pdf";
  if (["png", "webp", "gif", "avif"].includes(ext)) return `image/${ext}`;
  if (["wav", "aac", "ogg", "flac"].includes(ext)) return `audio/${ext}`;
  if (["mp4", "webm", "m4v"].includes(ext)) return `video/${ext}`;
  return undefined;
}

function looksLikeFileUri(value: string): boolean {
  return (
    value.startsWith("/generated/") ||
    value.startsWith("file://") ||
    value.startsWith("/") ||
    Boolean(extensionFromUri(value))
  );
}

function extensionFromUri(value: string): string | undefined {
  const match = value.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  return match?.[1]?.toLowerCase();
}

function fileNameFromUri(value: string): string {
  const path = value.split(/[?#]/)[0] ?? value;
  return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "image");
}

function summarizeForArtifact(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dedupeIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
