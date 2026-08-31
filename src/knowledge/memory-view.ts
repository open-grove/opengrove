import { MemoryLedger, type MemoryRecord, type MemoryWriteRequest } from "../core.js";
import type { KnowledgeDocumentInput, KnowledgeScope } from "./types.js";
import type { KnowledgeStore } from "./store.js";

export class KnowledgeBackedMemoryLedger extends MemoryLedger {
  constructor(private readonly knowledge: KnowledgeStore) {
    super();
  }

  override write(input: MemoryWriteRequest): MemoryRecord {
    const record = super.write(input);
    this.syncMemory(record);
    return record;
  }

  override restore(records: MemoryRecord[]): void {
    super.restore(records);
    for (const record of records) {
      this.syncMemory(record);
    }
  }

  override update(id: string, patch: Partial<Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">>): MemoryRecord {
    const record = super.update(id, patch);
    this.syncMemory(record);
    return record;
  }

  override delete(id: string): boolean {
    const deleted = super.delete(id);
    if (deleted) {
      const doc = this.knowledge.get(memoryKnowledgeId(id));
      if (doc && doc.lifecycle !== "archived") {
        this.knowledge.archive(doc.id);
      }
    }
    return deleted;
  }

  private syncMemory(record: MemoryRecord): void {
    this.knowledge.upsert(memoryRecordToKnowledgeDocument(record));
  }
}

export function createKnowledgeBackedMemoryLedger(knowledge: KnowledgeStore): KnowledgeBackedMemoryLedger {
  return new KnowledgeBackedMemoryLedger(knowledge);
}

export function memoryKnowledgeId(memoryId: string): string {
  return `memory.${memoryId}`;
}

export function memoryRecordToKnowledgeDocument(record: MemoryRecord): KnowledgeDocumentInput & { id: string } {
  return {
    id: memoryKnowledgeId(record.id),
    slug: `memory-${record.scope}-${record.kind}-${record.id}`,
    type: "memory",
    title: `${record.kind} (${record.scope})`,
    body: record.text,
    format: "plain",
    tags: ["memory", record.scope, record.kind, ...record.tags],
    sourceRefs: record.source.ref ? [record.source.ref] : [],
    scope: mapMemoryScope(record.scope),
    confidence: confidenceToNumber(record.confidence),
    lifecycle: record.expiresAt && Date.parse(record.expiresAt) < Date.now() ? "archived" : "active",
    metadata: {
      memoryId: record.id,
      memoryScope: record.scope,
      memoryKind: record.kind,
      memoryConfidence: record.confidence,
      sourceKind: record.source.kind,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt ?? "",
      ...(record.data ?? {}),
    },
  };
}

function mapMemoryScope(scope: MemoryRecord["scope"]): KnowledgeScope {
  if (scope === "workspace" || scope === "page" || scope === "session" || scope === "user") {
    return scope;
  }
  return "project";
}

function confidenceToNumber(confidence: MemoryRecord["confidence"]): number {
  if (confidence === "asserted") return 1;
  if (confidence === "observed") return 0.75;
  return 0.45;
}
