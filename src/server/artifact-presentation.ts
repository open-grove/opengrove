import type { ArtifactAsset, ArtifactRecord, JsonObject, JsonValue, SourceRef } from "../core.js";
import { isSensitiveWireKey, REDACTED_WIRE_VALUE } from "./wire-redaction.js";

const SUMMARY_DATA_KEYS = [
  "fileName",
  "name",
  "filePath",
  "mimeType",
  "imageUri",
  "summary",
  "slug",
  "threadId",
  "runId",
] as const;

export function presentArtifactSummary(artifact: ArtifactRecord): ArtifactRecord {
  const data: JsonObject = {};
  for (const key of SUMMARY_DATA_KEYS) {
    const value = artifact.data[key];
    if (key === "imageUri" && typeof value === "string") {
      const reference = safeReference(value);
      if (reference) data[key] = reference;
      continue;
    }
    if (isSmallScalar(value)) data[key] = compactScalar(value);
  }
  return {
    id: artifact.id,
    type: artifact.type,
    title: compactText(artifact.title, 512),
    status: compactText(artifact.status, 128),
    version: artifact.version,
    tags: artifact.tags.slice(0, 50).map((tag) => compactText(tag, 128) ?? ""),
    data,
    assets: artifact.assets?.slice(0, 20).map(presentAsset),
    preview: artifact.preview
      ? {
          title: compactText(artifact.preview.title, 512),
          text: compactText(artifact.preview.text, 2_000),
          imageUri: safeReference(artifact.preview.imageUri),
          mimeType: compactText(artifact.preview.mimeType, 256),
          status: compactText(artifact.preview.status, 128),
        }
      : undefined,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    provenance: compactMetadata(artifact.provenance),
    sourceRefs: artifact.sourceRefs?.slice(0, 20).map(presentSourceRef),
    parentId: compactText(artifact.parentId, 512),
    variantOf: compactText(artifact.variantOf, 512),
    derivedFrom: artifact.derivedFrom?.slice(0, 50).map((id) => compactText(id, 512) ?? ""),
    lineage: artifact.lineage?.slice(0, 50).map((id) => compactText(id, 512) ?? ""),
  };
}

export function presentArtifactSummaries(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  return artifacts.map(presentArtifactSummary);
}

export function presentArtifactCards(artifacts: ArtifactRecord[]): JsonObject[] {
  return presentArtifactSummaries(artifacts).map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title ?? artifact.id,
    status: artifact.status ?? "",
    tags: artifact.tags,
    data: artifact.data,
    preview: {
      title: artifact.preview?.title ?? artifact.title ?? artifact.id,
      mimeType: artifact.preview?.mimeType ?? "",
    },
  }));
}

function presentAsset(asset: ArtifactAsset): ArtifactAsset {
  return {
    kind: asset.kind,
    uri: safeReference(asset.uri),
    path: compactText(asset.path, 2_048),
    title: compactText(asset.title, 512),
    mimeType: compactText(asset.mimeType, 256),
  };
}

function presentSourceRef(source: SourceRef): SourceRef {
  return {
    title: compactText(source.title, 512),
    url: safeReference(source.url),
    locator: compactText(source.locator, 2_048),
    quote: compactText(source.quote, 2_000),
  };
}

function compactMetadata(value: JsonObject | undefined): JsonObject | undefined {
  if (!value) return undefined;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (isSensitiveWireKey(key)) {
      output[key] = REDACTED_WIRE_VALUE;
    } else if (isSmallScalar(item)) {
      output[key] = compactScalar(item);
    }
  }
  return output;
}

function isSmallScalar(value: JsonValue | undefined): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function compactScalar(value: string | number | boolean | null): JsonValue {
  return typeof value === "string" ? (compactText(value, 2_048) ?? "") : value;
}

function safeReference(value: string | undefined): string | undefined {
  if (!value || value.startsWith("data:")) return undefined;
  return compactText(value, 2_048);
}

function compactText(value: string | undefined, limit: number): string | undefined {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
