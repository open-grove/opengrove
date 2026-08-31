import type { JsonObject, SourceRef } from "../core.js";
import type {
  ContextDeliveryPlan,
  KnowledgeDocument,
  KnowledgeDocumentInput,
  KnowledgeDocumentPatch,
  KnowledgeDocumentType,
  KnowledgeDeliveryDecision,
  KnowledgeDeliveryRecord,
  KnowledgeEvidenceInput,
  KnowledgeEvidenceRecord,
  KnowledgeFeedbackEvent,
  KnowledgeFeedbackInput,
  KnowledgeFilter,
  KnowledgeLedgerSnapshot,
  KnowledgeLifecycle,
  KnowledgeLink,
  KnowledgeRevision,
  KnowledgeRevisionInput,
  KnowledgeScope,
  KnowledgeSearchOptions,
  KnowledgeStoreSnapshot,
} from "./types.js";

// Ledger retention caps. The revision/evidence ledgers are append-only audit
// trails with no functional consumers beyond display, so bounding them keeps
// the persisted state file from growing without limit (a single misbehaving
// sync loop could otherwise write hundreds of thousands of records). When a
// ledger exceeds its cap, the oldest records are evicted first — record ids are
// monotonically increasing, and Map iteration order is insertion order, so the
// first key is always the oldest.
const MAX_REVISIONS = 20_000;
const MAX_EVIDENCE = 20_000;
const MAX_DELIVERIES = 10_000;
const MAX_FEEDBACK = 10_000;

function trimOldestEntries(map: Map<string, unknown>, max: number, protectedIds: Set<string> = new Set()): void {
  while (map.size > max) {
    let deleted = false;
    for (const key of map.keys()) {
      if (protectedIds.has(key)) continue;
      map.delete(key);
      deleted = true;
      break;
    }
    if (!deleted) break;
  }
}

// Restore a ledger into `target`, keeping only the newest `max` records. Persisted
// ledgers are serialized newest-first (list* sorts by createdAt desc), so we sort
// ascending by sequence id to restore insertion order, then keep the tail. Returns
// the highest sequence number seen (over the records that were restored).
function selectLedgerRecords<T extends { id: string; createdAt: string }>(
  records: T[],
  prefix: string,
  max: number,
): T[] {
  const ordered = [...records].sort((left, right) => {
    const seqDelta = parseSequencedId(left.id, prefix) - parseSequencedId(right.id, prefix);
    return seqDelta !== 0 ? seqDelta : left.createdAt.localeCompare(right.createdAt);
  });
  return ordered.length > max ? ordered.slice(ordered.length - max) : ordered;
}

function restoreLedgerMap<T extends { id: string; createdAt: string }>(
  target: Map<string, T>,
  records: T[],
  prefix: string,
  max: number,
): number {
  const kept = selectLedgerRecords(records, prefix, max);
  let highest = 0;
  for (const record of kept) {
    target.set(record.id, record);
    highest = Math.max(highest, parseSequencedId(record.id, prefix));
  }
  return highest;
}

function highestSequence<T>(records: T[], getId: (record: T) => string | undefined, prefix: string): number {
  let highest = 0;
  for (const record of records) {
    highest = Math.max(highest, parseSequencedId(getId(record) ?? "", prefix));
  }
  return highest;
}

function collectRevisionEvidenceIds(revisions: KnowledgeRevision[]): Set<string> {
  const ids = new Set<string>();
  for (const revision of revisions) {
    for (const evidenceId of revision.evidenceIds ?? []) {
      ids.add(evidenceId);
    }
  }
  return ids;
}

function selectEvidenceRecords(
  records: KnowledgeEvidenceRecord[],
  requiredIds: Set<string>,
  max: number,
): KnowledgeEvidenceRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const required = [...requiredIds]
    .map((id) => byId.get(id))
    .filter((record): record is KnowledgeEvidenceRecord => Boolean(record));
  const requiredSet = new Set(required.map((record) => record.id));
  const optional = records.filter((record) => !requiredSet.has(record.id));
  const optionalLimit = Math.max(0, max - required.length);
  return selectLedgerRecords(
    [...required, ...selectLedgerRecords(optional, "evidence", optionalLimit)],
    "evidence",
    Number.POSITIVE_INFINITY,
  );
}

export class KnowledgeStore {
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly evidence = new Map<string, KnowledgeEvidenceRecord>();
  private readonly revisions = new Map<string, KnowledgeRevision>();
  private readonly deliveries = new Map<string, KnowledgeDeliveryRecord>();
  private readonly feedback = new Map<string, KnowledgeFeedbackEvent>();
  private sequence = 0;
  private evidenceSequence = 0;
  private revisionSequence = 0;
  private deliverySequence = 0;
  private feedbackSequence = 0;

  create(input: KnowledgeDocumentInput): KnowledgeDocument {
    const now = new Date().toISOString();
    const id = input.id ?? `know_${++this.sequence}`;
    const document = normalizeDocument({
      ...input,
      id,
      slug: input.slug ?? slugify(`${input.type}-${input.title || id}`),
      format: input.format ?? "markdown",
      tags: input.tags ?? [],
      links: input.links ?? [],
      backlinks: [],
      sourceRefs: input.sourceRefs ?? [],
      scope: input.scope ?? "project",
      lifecycle: input.lifecycle ?? "active",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    });
    this.documents.set(document.id, document);
    const evidence = this.recordDocumentEvidence(document, "create");
    this.recordRevision({
      knowledgeId: document.id,
      operation: "create",
      title: document.title,
      bodyPreview: document.body,
      evidenceIds: evidence ? [evidence.id] : [],
      metadata: {
        type: document.type,
        scope: document.scope,
      },
    });
    return this.get(document.id)!;
  }

  upsert(input: KnowledgeDocumentInput & { id: string }): KnowledgeDocument {
    const existing = this.documents.get(input.id);
    if (!existing) {
      return this.create(input);
    }
    const patch = {
      slug: input.slug,
      type: input.type,
      title: input.title,
      body: input.body,
      format: input.format,
      tags: input.tags,
      links: input.links,
      sourceRefs: input.sourceRefs,
      scope: input.scope,
      confidence: input.confidence,
      lifecycle: input.lifecycle,
      metadata: input.metadata,
    };
    if (!wouldChangeDocument(existing, patch)) {
      return this.get(input.id)!;
    }
    return this.update(input.id, patch);
  }

  restore(documents: KnowledgeDocument[] = [], ledgers?: Partial<KnowledgeLedgerSnapshot>): void {
    this.documents.clear();
    this.sequence = 0;

    for (const document of documents) {
      const normalized = normalizeDocument(document);
      this.documents.set(normalized.id, normalized);
      const match = normalized.id.match(/^know_(\d+)$/);
      if (match) {
        this.sequence = Math.max(this.sequence, Number(match[1]));
      }
    }

    this.restoreLedgers(ledgers ?? {});
  }

  get(id: string): KnowledgeDocument | undefined {
    const document = this.documents.get(id);
    return document ? this.withBacklinks(document) : undefined;
  }

  list(filter: KnowledgeFilter = {}): KnowledgeDocument[] {
    const ids = filter.ids ? new Set(filter.ids) : undefined;
    const types = filter.types ? new Set(filter.types) : undefined;
    const documents = Array.from(this.documents.values())
      .filter((document) => {
        if (ids && !ids.has(document.id)) return false;
        if (filter.type && document.type !== filter.type) return false;
        if (types && !types.has(document.type)) return false;
        if (filter.scope && document.scope !== filter.scope) return false;
        if (filter.lifecycle && document.lifecycle !== filter.lifecycle) return false;
        if (filter.tags?.some((tag) => !document.tags.includes(tag))) return false;
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((document) => this.withBacklinks(document));

    return typeof filter.limit === "number" ? documents.slice(0, filter.limit) : documents;
  }

  search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeDocument[] {
    const needle = query.trim().toLowerCase();
    const base = this.list({ ...options, limit: undefined });
    const scored = base
      .map((document) => ({
        document,
        score: needle ? scoreDocument(document, needle) : 1,
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) => right.score - left.score || right.document.updatedAt.localeCompare(left.document.updatedAt),
      )
      .map((item) => item.document);

    return typeof options.limit === "number" ? scored.slice(0, options.limit) : scored;
  }

  update(id: string, patch: KnowledgeDocumentPatch): KnowledgeDocument {
    const current = this.documents.get(id);
    if (!current) {
      throw new Error(`Knowledge document not found: ${id}`);
    }
    const updated = normalizeDocument({
      ...current,
      ...stripUndefined(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.documents.set(id, updated);
    const operation = updated.lifecycle === "archived" && current.lifecycle !== "archived" ? "archive" : "update";
    const evidence = this.recordDocumentEvidence(updated, operation);
    this.recordRevision({
      knowledgeId: updated.id,
      operation,
      title: updated.title,
      bodyPreview: updated.body,
      evidenceIds: evidence ? [evidence.id] : [],
      metadata: {
        type: updated.type,
        previousUpdatedAt: current.updatedAt,
        changedFields: Object.keys(stripUndefined(patch)).join(","),
      },
    });
    return this.get(id)!;
  }

  archive(id: string): KnowledgeDocument {
    return this.update(id, { lifecycle: "archived" });
  }

  delete(id: string): boolean {
    const current = this.documents.get(id);
    const deleted = this.documents.delete(id);
    if (deleted && current) {
      this.recordRevision({
        knowledgeId: current.id,
        operation: "delete",
        title: current.title,
        bodyPreview: current.body,
        metadata: {
          type: current.type,
        },
      });
    }
    return deleted;
  }

  listBacklinks(id: string): KnowledgeLink[] {
    return Array.from(this.documents.values())
      .filter((document) => document.links.some((link) => link.targetId === id))
      .map((document) => ({
        targetId: document.id,
        relation: "backlink",
        title: document.title,
      }));
  }

  snapshot(): KnowledgeDocument[] {
    return this.list();
  }

  snapshotLedgers(): KnowledgeLedgerSnapshot {
    return {
      evidence: this.listEvidence(),
      revisions: this.listRevisions(),
      deliveries: this.listDeliveries(),
      feedback: this.listFeedback(),
    };
  }

  snapshotState(): KnowledgeStoreSnapshot {
    return {
      documents: this.snapshot(),
      ...this.snapshotLedgers(),
    };
  }

  restoreLedgers(snapshot: Partial<KnowledgeLedgerSnapshot> = {}): void {
    this.evidence.clear();
    this.revisions.clear();
    this.deliveries.clear();
    this.feedback.clear();
    this.evidenceSequence = 0;
    this.revisionSequence = 0;
    this.deliverySequence = 0;
    this.feedbackSequence = 0;

    const liveIds = new Set(this.documents.keys());

    // Drop delete tombstones for documents that no longer exist: once both the
    // create and the document are gone, the delete revision carries no value and
    // is pure churn residue. Retained records are capped to keep the newest.
    const revisions = (snapshot.revisions ?? [])
      .map(normalizeRevision)
      .filter((revision) => !(revision.operation === "delete" && !liveIds.has(revision.knowledgeId)));
    const retainedRevisions = selectLedgerRecords(revisions, "revision", MAX_REVISIONS);
    for (const revision of retainedRevisions) {
      this.revisions.set(revision.id, revision);
    }
    // Sequence must be derived from ALL persisted revisions (including any dropped
    // tombstone that held the highest id) so newly recorded revisions never reuse an id.
    const revisionSequence = highestSequence(snapshot.revisions ?? [], (record) => record?.id, "revision");
    this.revisionSequence = Math.max(
      highestSequence(retainedRevisions, (record) => record.id, "revision"),
      revisionSequence,
    );

    const evidence = (snapshot.evidence ?? []).map(normalizeEvidenceRecord);
    const retainedEvidence = selectEvidenceRecords(
      evidence,
      collectRevisionEvidenceIds(retainedRevisions),
      MAX_EVIDENCE,
    );
    this.evidenceSequence = Math.max(
      restoreLedgerMap(this.evidence, retainedEvidence, "evidence", retainedEvidence.length),
      highestSequence(snapshot.evidence ?? [], (record) => record?.id, "evidence"),
    );

    const deliveries = (snapshot.deliveries ?? []).map(normalizeDeliveryRecord);
    this.deliverySequence = restoreLedgerMap(this.deliveries, deliveries, "delivery", MAX_DELIVERIES);

    const feedback = (snapshot.feedback ?? []).map(normalizeFeedbackEvent);
    this.feedbackSequence = restoreLedgerMap(this.feedback, feedback, "feedback", MAX_FEEDBACK);
  }

  recordEvidence(input: KnowledgeEvidenceInput): KnowledgeEvidenceRecord {
    const now = new Date().toISOString();
    const record = normalizeEvidenceRecord({
      ...input,
      id: input.id ?? `evidence_${++this.evidenceSequence}`,
      createdAt: now,
      metadata: input.metadata ?? {},
    });
    this.evidence.set(record.id, record);
    trimOldestEntries(this.evidence, MAX_EVIDENCE, collectRevisionEvidenceIds([...this.revisions.values()]));
    return cloneEvidenceRecord(record);
  }

  listEvidence(filter: { knowledgeId?: string; limit?: number } = {}): KnowledgeEvidenceRecord[] {
    const records = Array.from(this.evidence.values())
      .filter((record) => !filter.knowledgeId || record.knowledgeId === filter.knowledgeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneEvidenceRecord);
    return typeof filter.limit === "number" ? records.slice(0, filter.limit) : records;
  }

  recordRevision(input: KnowledgeRevisionInput): KnowledgeRevision {
    const now = new Date().toISOString();
    const revision = normalizeRevision({
      ...input,
      id: input.id ?? `revision_${++this.revisionSequence}`,
      createdAt: now,
      metadata: input.metadata ?? {},
    });
    this.revisions.set(revision.id, revision);
    trimOldestEntries(this.revisions, MAX_REVISIONS);
    return cloneRevision(revision);
  }

  listRevisions(filter: { knowledgeId?: string; limit?: number } = {}): KnowledgeRevision[] {
    const revisions = Array.from(this.revisions.values())
      .filter((revision) => !filter.knowledgeId || revision.knowledgeId === filter.knowledgeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRevision);
    return typeof filter.limit === "number" ? revisions.slice(0, filter.limit) : revisions;
  }

  recordDelivery(plan: ContextDeliveryPlan): KnowledgeDeliveryRecord[] {
    const records = plan.decisions.map((decision) => this.recordDeliveryDecision(plan, decision));
    return records;
  }

  listDeliveries(
    filter: { knowledgeId?: string; runId?: string; sessionId?: string; limit?: number } = {},
  ): KnowledgeDeliveryRecord[] {
    const records = Array.from(this.deliveries.values())
      .filter((record) => !filter.knowledgeId || record.knowledgeId === filter.knowledgeId)
      .filter((record) => !filter.runId || record.runId === filter.runId)
      .filter((record) => !filter.sessionId || record.sessionId === filter.sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneDeliveryRecord);
    return typeof filter.limit === "number" ? records.slice(0, filter.limit) : records;
  }

  recordFeedback(input: KnowledgeFeedbackInput): KnowledgeFeedbackEvent {
    const now = new Date().toISOString();
    const event = normalizeFeedbackEvent({
      ...input,
      id: input.id ?? `feedback_${++this.feedbackSequence}`,
      createdAt: now,
      metadata: input.metadata ?? {},
    });
    this.feedback.set(event.id, event);
    trimOldestEntries(this.feedback, MAX_FEEDBACK);
    return cloneFeedbackEvent(event);
  }

  listFeedback(
    filter: { knowledgeId?: string; deliveryId?: string; runId?: string; limit?: number } = {},
  ): KnowledgeFeedbackEvent[] {
    const events = Array.from(this.feedback.values())
      .filter((event) => !filter.knowledgeId || event.knowledgeId === filter.knowledgeId)
      .filter((event) => !filter.deliveryId || event.deliveryId === filter.deliveryId)
      .filter((event) => !filter.runId || event.runId === filter.runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneFeedbackEvent);
    return typeof filter.limit === "number" ? events.slice(0, filter.limit) : events;
  }

  private withBacklinks(document: KnowledgeDocument): KnowledgeDocument {
    return {
      ...document,
      tags: [...document.tags],
      links: document.links.map((link) => ({ ...link })),
      backlinks: this.listBacklinks(document.id),
      sourceRefs: document.sourceRefs.map((source) => ({ ...source })),
      metadata: { ...document.metadata },
    };
  }

  private recordDeliveryDecision(
    plan: ContextDeliveryPlan,
    decision: KnowledgeDeliveryDecision,
  ): KnowledgeDeliveryRecord {
    const record = normalizeDeliveryRecord({
      ...decision,
      id: `delivery_${++this.deliverySequence}`,
      planId: plan.id,
      runId: plan.runId,
      sessionId: plan.sessionId,
      kernelId: plan.kernelId,
      createdAt: new Date().toISOString(),
    });
    this.deliveries.set(record.id, record);
    trimOldestEntries(this.deliveries, MAX_DELIVERIES);
    return cloneDeliveryRecord(record);
  }

  private recordDocumentEvidence(
    document: KnowledgeDocument,
    action: "create" | "update" | "archive",
  ): KnowledgeEvidenceRecord | undefined {
    const kind = inferEvidenceKind(document);
    return this.recordEvidence({
      knowledgeId: document.id,
      kind,
      summary: `${action}:${document.type}:${document.title}`,
      sourceRefs: document.sourceRefs,
      confidence: document.confidence,
      observedAt: document.updatedAt,
      metadata: {
        action,
        type: document.type,
        scope: document.scope,
      },
    });
  }
}

export function createKnowledgeStore(documents: KnowledgeDocument[] = []): KnowledgeStore {
  const store = new KnowledgeStore();
  store.restore(documents);
  return store;
}

export function isKnowledgeDocumentType(value: string): value is KnowledgeDocumentType {
  return (
    value === "skill" ||
    value === "memory" ||
    value === "note" ||
    value === "project_doc" ||
    value === "artifact_ref" ||
    value === "routine" ||
    value === "profile" ||
    value === "source"
  );
}

export function isKnowledgeScope(value: string): value is KnowledgeScope {
  return (
    value === "global" ||
    value === "project" ||
    value === "workspace" ||
    value === "session" ||
    value === "user" ||
    value === "page"
  );
}

function normalizeDocument(
  input: Partial<KnowledgeDocument> & Pick<KnowledgeDocument, "id" | "type" | "title" | "body">,
): KnowledgeDocument {
  const now = new Date().toISOString();
  return {
    id: input.id,
    slug: input.slug || slugify(`${input.type}-${input.title || input.id}`),
    type: normalizeType(input.type),
    title: input.title || input.id,
    body: input.body || "",
    format: input.format === "json" || input.format === "plain" ? input.format : "markdown",
    tags: normalizeStringArray(input.tags),
    links: normalizeLinks(input.links),
    backlinks: normalizeLinks(input.backlinks),
    sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs.filter(Boolean) : [],
    scope: normalizeScope(input.scope),
    confidence: typeof input.confidence === "number" ? input.confidence : undefined,
    lifecycle: normalizeLifecycle(input.lifecycle),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
    metadata: isJsonObject(input.metadata) ? input.metadata : {},
  };
}

function wouldChangeDocument(current: KnowledgeDocument, patch: KnowledgeDocumentPatch): boolean {
  const next = normalizeDocument({
    ...current,
    ...stripUndefined(patch),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
  return JSON.stringify(documentComparable(current)) !== JSON.stringify(documentComparable(next));
}

function documentComparable(document: KnowledgeDocument): unknown {
  return {
    id: document.id,
    slug: document.slug,
    type: document.type,
    title: document.title,
    body: document.body,
    format: document.format,
    tags: [...document.tags],
    links: document.links.map((link) => ({ ...link })),
    sourceRefs: document.sourceRefs.map((source) => ({ ...source })),
    scope: document.scope,
    confidence: document.confidence ?? null,
    lifecycle: document.lifecycle,
    metadata: { ...document.metadata },
  };
}

function normalizeEvidenceRecord(
  input: Partial<KnowledgeEvidenceRecord> & Pick<KnowledgeEvidenceRecord, "id" | "knowledgeId" | "kind" | "summary">,
): KnowledgeEvidenceRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    knowledgeId: input.knowledgeId,
    kind: normalizeEvidenceKind(input.kind),
    summary: input.summary || input.knowledgeId,
    sourceRefs: normalizeSourceRefs(input.sourceRefs),
    confidence: typeof input.confidence === "number" ? input.confidence : undefined,
    observedAt: typeof input.observedAt === "string" ? input.observedAt : undefined,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    metadata: isJsonObject(input.metadata) ? input.metadata : {},
  };
}

function normalizeRevision(
  input: Partial<KnowledgeRevision> & Pick<KnowledgeRevision, "id" | "knowledgeId" | "operation" | "title">,
): KnowledgeRevision {
  const now = new Date().toISOString();
  return {
    id: input.id,
    knowledgeId: input.knowledgeId,
    operation: normalizeRevisionOperation(input.operation),
    title: input.title || input.knowledgeId,
    bodyPreview: truncate(typeof input.bodyPreview === "string" ? input.bodyPreview : "", 320),
    evidenceIds: normalizeStringArray(input.evidenceIds),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    metadata: isJsonObject(input.metadata) ? input.metadata : {},
  };
}

function normalizeDeliveryRecord(
  input: Partial<KnowledgeDeliveryRecord> &
    Pick<
      KnowledgeDeliveryRecord,
      "id" | "planId" | "knowledgeId" | "knowledgeType" | "title" | "mode" | "reason" | "score" | "includeInPrompt"
    >,
): KnowledgeDeliveryRecord {
  const now = new Date().toISOString();
  const normalizedType = normalizeType(input.knowledgeType);
  return {
    id: input.id,
    planId: input.planId,
    runId: typeof input.runId === "string" ? input.runId : undefined,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    kernelId: typeof input.kernelId === "string" ? input.kernelId : undefined,
    knowledgeId: input.knowledgeId,
    knowledgeType: normalizedType,
    title: input.title || input.knowledgeId,
    mode: normalizeDeliveryMode(input.mode),
    reason: input.reason || "selected",
    score: typeof input.score === "number" ? input.score : 0,
    includeInPrompt: Boolean(input.includeInPrompt),
    contextItemId: typeof input.contextItemId === "string" ? input.contextItemId : undefined,
    characterCount: typeof input.characterCount === "number" ? input.characterCount : undefined,
    metadata: isJsonObject(input.metadata) ? input.metadata : {},
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
  };
}

function normalizeFeedbackEvent(
  input: Partial<KnowledgeFeedbackEvent> & Pick<KnowledgeFeedbackEvent, "id" | "knowledgeId" | "signal">,
): KnowledgeFeedbackEvent {
  const now = new Date().toISOString();
  return {
    id: input.id,
    knowledgeId: input.knowledgeId,
    deliveryId: typeof input.deliveryId === "string" ? input.deliveryId : undefined,
    runId: typeof input.runId === "string" ? input.runId : undefined,
    signal: normalizeFeedbackSignal(input.signal),
    scoreDelta: typeof input.scoreDelta === "number" ? input.scoreDelta : undefined,
    note: typeof input.note === "string" ? input.note : undefined,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    metadata: isJsonObject(input.metadata) ? input.metadata : {},
  };
}

function cloneEvidenceRecord(record: KnowledgeEvidenceRecord): KnowledgeEvidenceRecord {
  return {
    ...record,
    sourceRefs: record.sourceRefs.map((source) => ({ ...source })),
    metadata: { ...record.metadata },
  };
}

function cloneRevision(revision: KnowledgeRevision): KnowledgeRevision {
  return {
    ...revision,
    evidenceIds: [...revision.evidenceIds],
    metadata: { ...revision.metadata },
  };
}

function cloneDeliveryRecord(record: KnowledgeDeliveryRecord): KnowledgeDeliveryRecord {
  return {
    ...record,
    metadata: { ...record.metadata },
  };
}

function cloneFeedbackEvent(event: KnowledgeFeedbackEvent): KnowledgeFeedbackEvent {
  return {
    ...event,
    metadata: { ...event.metadata },
  };
}

function normalizeSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      title: typeof item.title === "string" ? item.title : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      locator: typeof item.locator === "string" ? item.locator : undefined,
      quote: typeof item.quote === "string" ? item.quote : undefined,
    }))
    .filter((source) => source.title || source.url || source.locator || source.quote);
}

function normalizeEvidenceKind(value: unknown): KnowledgeEvidenceRecord["kind"] {
  if (
    value === "user_assertion" ||
    value === "tool_observation" ||
    value === "artifact_asset" ||
    value === "skill_manifest" ||
    value === "runtime_event" ||
    value === "external_source"
  ) {
    return value;
  }
  return "system";
}

function normalizeRevisionOperation(value: unknown): KnowledgeRevision["operation"] {
  if (value === "create" || value === "update" || value === "archive" || value === "delete") {
    return value;
  }
  return "sync";
}

function normalizeDeliveryMode(value: unknown): KnowledgeDeliveryRecord["mode"] {
  if (
    value === "skill_tool_hint" ||
    value === "native_skill" ||
    value === "loaded_skill" ||
    value === "artifact_handle" ||
    value === "suppressed_duplicate"
  ) {
    return value;
  }
  return "prompt_snippet";
}

function normalizeFeedbackSignal(value: unknown): KnowledgeFeedbackEvent["signal"] {
  if (
    value === "ignored" ||
    value === "corrected" ||
    value === "stale" ||
    value === "promoted" ||
    value === "demoted"
  ) {
    return value;
  }
  return "useful";
}

function inferEvidenceKind(document: KnowledgeDocument): KnowledgeEvidenceRecord["kind"] {
  if (document.type === "skill") return "skill_manifest";
  if (document.type === "artifact_ref") return "artifact_asset";
  if (document.type === "memory") return "user_assertion";
  if (document.sourceRefs.some((source) => source.url)) return "external_source";
  return "system";
}

function parseSequencedId(id: string, prefix: string): number {
  const match = id.match(new RegExp(`^${prefix}_(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

function normalizeType(value: unknown): KnowledgeDocumentType {
  return typeof value === "string" && isKnowledgeDocumentType(value) ? value : "note";
}

function normalizeScope(value: unknown): KnowledgeScope {
  return typeof value === "string" && isKnowledgeScope(value) ? value : "project";
}

function normalizeLifecycle(value: unknown): KnowledgeLifecycle {
  return value === "draft" || value === "archived" ? value : "active";
}

function normalizeLinks(value: unknown): KnowledgeLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      targetId: typeof item.targetId === "string" ? item.targetId : "",
      relation: typeof item.relation === "string" ? item.relation : "related",
      title: typeof item.title === "string" ? item.title : undefined,
    }))
    .filter((link) => link.targetId);
}

function scoreDocument(document: KnowledgeDocument, needle: string): number {
  const tokens = tokenize(needle);
  const haystack = [
    document.type,
    document.title,
    document.slug,
    document.body,
    document.tags.join(" "),
    document.sourceRefs
      .map((source) => [source.title, source.url, source.locator, source.quote].filter(Boolean).join(" "))
      .join(" "),
    JSON.stringify(document.metadata),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (haystack.includes(needle.slice(0, 120))) {
    score += 8;
  }
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length > 8 ? 2 : 1;
    }
  }
  if (document.lifecycle === "active") {
    score += 0.25;
  }
  return score;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .map((item) => item.trim()),
        ),
      )
    : [];
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `doc-${Date.now()}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
