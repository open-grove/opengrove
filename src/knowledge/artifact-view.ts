import { ArtifactStore, type ArtifactCreateRequest, type ArtifactRecord } from "../core.js";
import type { KnowledgeDocumentInput } from "./types.js";
import type { KnowledgeStore } from "./store.js";

export class KnowledgeBackedArtifactStore extends ArtifactStore {
  constructor(private readonly knowledge: KnowledgeStore) {
    super();
  }

  override create(input: ArtifactCreateRequest): ArtifactRecord {
    const artifact = super.create(input);
    this.syncArtifact(artifact);
    return artifact;
  }

  override restore(records: ArtifactRecord[]): void {
    super.restore(records);
    for (const artifact of records) {
      this.syncArtifact(artifact);
    }
  }

  override update(id: string, patch: Partial<Omit<ArtifactRecord, "id" | "createdAt" | "updatedAt">>): ArtifactRecord {
    const artifact = super.update(id, patch);
    this.syncArtifact(artifact);
    return artifact;
  }

  override delete(id: string): boolean {
    const deleted = super.delete(id);
    if (deleted) {
      const doc = this.knowledge.get(artifactKnowledgeId(id));
      if (doc && doc.lifecycle !== "archived") {
        this.knowledge.archive(doc.id);
      }
    }
    return deleted;
  }

  private syncArtifact(artifact: ArtifactRecord): void {
    this.knowledge.upsert(artifactToKnowledgeDocument(artifact));
  }
}

export function createKnowledgeBackedArtifactStore(knowledge: KnowledgeStore): KnowledgeBackedArtifactStore {
  return new KnowledgeBackedArtifactStore(knowledge);
}

export function artifactKnowledgeId(artifactId: string): string {
  return `artifact.${artifactId}`;
}

export function artifactToKnowledgeDocument(artifact: ArtifactRecord): KnowledgeDocumentInput & { id: string } {
  const title = artifact.title || `${artifact.type} artifact`;
  return {
    id: artifactKnowledgeId(artifact.id),
    slug: `artifact-${artifact.type}-${artifact.id}`,
    type: "artifact_ref",
    title,
    body: summarizeArtifact(artifact),
    format: "markdown",
    tags: ["artifact", artifact.type, ...artifact.tags],
    sourceRefs: artifact.sourceRefs ?? [],
    scope: "session",
    lifecycle: artifact.status === "archived" ? "archived" : "active",
    metadata: {
      artifactId: artifact.id,
      artifactType: artifact.type,
      status: artifact.status ?? "",
      version: artifact.version ?? 1,
      parentId: artifact.parentId ?? "",
      variantOf: artifact.variantOf ?? "",
      derivedFrom: (artifact.derivedFrom ?? []).join(","),
      lineage: (artifact.lineage ?? []).join(","),
      assetCount: artifact.assets?.length ?? 0,
      previewTitle: artifact.preview?.title ?? "",
      previewText: artifact.preview?.text ?? "",
    },
  };
}

function summarizeArtifact(artifact: ArtifactRecord): string {
  const imageUri =
    artifact.preview?.imageUri ||
    artifact.data?.imageUri ||
    artifact.assets?.find((asset) => asset.kind === "image")?.uri;
  const imageAlt = artifact.preview?.title || artifact.title || artifact.id;
  const previewText = artifact.preview?.text?.trim();
  if (imageUri) {
    return [
      `![${markdownAlt(imageAlt)}](${imageUri})`,
      previewText && previewText !== artifact.title ? previewText : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const lines = [
    previewText || artifact.title || `${artifact.type} artifact`,
    artifact.assets?.length ? `${artifact.assets.length} 个资源` : "",
  ].filter(Boolean);
  return lines.join("\n\n");
}

function markdownAlt(value: string): string {
  return value.replace(/[\]\n\r]/g, " ").trim();
}
