import type { MemoryFilter, MemoryRecord, MemoryWriteRequest } from "../types.js";

export class MemoryLedger {
  private readonly records = new Map<string, MemoryRecord>();
  private sequence = 0;

  write(input: MemoryWriteRequest): MemoryRecord {
    const now = new Date().toISOString();
    const id = input.id ?? `mem_${++this.sequence}`;
    const record: MemoryRecord = {
      ...input,
      id,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return record;
  }

  restore(records: MemoryRecord[]): void {
    this.records.clear();
    this.sequence = 0;

    for (const record of records) {
      this.records.set(record.id, record);
      const match = record.id.match(/^mem_(\d+)$/);
      if (match) {
        this.sequence = Math.max(this.sequence, Number(match[1]));
      }
    }
  }

  upsert(record: MemoryRecord): MemoryRecord {
    this.records.set(record.id, record);
    const match = record.id.match(/^mem_(\d+)$/);
    if (match) {
      this.sequence = Math.max(this.sequence, Number(match[1]));
    }
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">>): MemoryRecord {
    const current = this.records.get(id);
    if (!current) {
      throw new Error(`Memory record not found: ${id}`);
    }

    const updated: MemoryRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  list(filter: MemoryFilter = {}): MemoryRecord[] {
    const records = Array.from(this.records.values()).filter((record) => {
      if (filter.scope && record.scope !== filter.scope) return false;
      if (filter.kind && record.kind !== filter.kind) return false;
      if (filter.tags?.some((tag) => !record.tags.includes(tag))) return false;
      return true;
    });

    return typeof filter.limit === "number" ? records.slice(0, filter.limit) : records;
  }

  search(query: string, filter: MemoryFilter = {}): MemoryRecord[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return this.list(filter);
    }

    return this.list(filter).filter((record) => {
      const haystack = [record.kind, record.text, record.tags.join(" "), record.data ? JSON.stringify(record.data) : ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }
}
