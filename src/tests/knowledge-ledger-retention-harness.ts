import assert from "node:assert/strict";
import { KnowledgeStore } from "../knowledge/store.js";
import type { KnowledgeDocument } from "../knowledge/types.js";

// Verifies the ledger retention behavior added to bound state-file growth:
//   1. recordRevision / recordEvidence evict the oldest records past the cap.
//   2. restoreLedgers drops delete-tombstones for documents that no longer exist.
//   3. restoreLedgers keeps the newest records and preserves the sequence counter
//      even when the highest-id record is a dropped tombstone (no id reuse).

// restore()/normalizeDocument fills in the remaining fields; a partial shape is
// sufficient at runtime, so we cast to satisfy the static signature.
function makeDoc(id: string): KnowledgeDocument {
  return {
    id,
    type: "note",
    title: id,
    body: "",
  } as KnowledgeDocument;
}

function main() {
  // --- 1. record-time ring buffer -----------------------------------------
  {
    const store = new KnowledgeStore();
    // MAX_REVISIONS is 20_000; go just over to keep the test fast but real.
    const total = 20_050;
    for (let i = 0; i < total; i += 1) {
      store.recordRevision({ knowledgeId: `doc_${i}`, operation: "create", title: `t${i}` });
    }
    const revisions = store.listRevisions();
    assert.equal(revisions.length, 20_000, "revisions should be capped at MAX_REVISIONS");
    // The oldest should have been evicted; the newest must survive.
    const ids = new Set(revisions.map((r) => r.knowledgeId));
    assert.ok(ids.has("doc_20049"), "newest revision should be retained");
    assert.ok(!ids.has("doc_0"), "oldest revision should be evicted");
  }

  // --- 2. orphan tombstone drop on restore ---------------------------------
  {
    const store = new KnowledgeStore();
    const liveDoc = makeDoc("know_live");
    // Ledger snapshot is serialized newest-first (list* sorts desc); emulate that.
    const revisions = [
      // newest first
      {
        id: "revision_5",
        knowledgeId: "know_live",
        operation: "update" as const,
        title: "live update",
        createdAt: "2026-07-01T00:00:05.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
      {
        id: "revision_4",
        knowledgeId: "know_gone",
        operation: "delete" as const,
        title: "gone delete",
        createdAt: "2026-07-01T00:00:04.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
      {
        id: "revision_3",
        knowledgeId: "know_live",
        operation: "create" as const,
        title: "live create",
        createdAt: "2026-07-01T00:00:03.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
      {
        id: "revision_2",
        knowledgeId: "know_gone",
        operation: "create" as const,
        title: "gone create",
        createdAt: "2026-07-01T00:00:02.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
    ];
    store.restore([liveDoc], { revisions });

    const restored = store.listRevisions();
    const restoredIds = restored.map((r) => r.id).sort();
    // The delete tombstone for the gone doc (revision_4) must be dropped.
    assert.ok(!restoredIds.includes("revision_4"), "orphan delete tombstone should be dropped on restore");
    // Non-delete revisions for the gone doc are kept (audit of what once existed).
    assert.ok(restoredIds.includes("revision_2"), "non-delete revision for gone doc should be retained");
    assert.ok(restoredIds.includes("revision_3"), "live doc create should be retained");
    assert.ok(restoredIds.includes("revision_5"), "live doc update should be retained");

    // --- 3. sequence must not reuse the dropped tombstone's id ---------------
    // revision_4 was dropped but held the 2nd-highest id; the highest retained is 5.
    const next = store.recordRevision({ knowledgeId: "know_live", operation: "update", title: "after restore" });
    assert.equal(next.id, "revision_6", `next revision id should continue past the max persisted id, got ${next.id}`);
  }

  // --- 3b. sequence continues past a DROPPED highest-id tombstone -----------
  {
    const store = new KnowledgeStore();
    const revisions = [
      {
        id: "revision_9",
        knowledgeId: "know_gone",
        operation: "delete" as const,
        title: "gone delete newest",
        createdAt: "2026-07-01T00:00:09.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
      {
        id: "revision_3",
        knowledgeId: "know_live",
        operation: "create" as const,
        title: "live create",
        createdAt: "2026-07-01T00:00:03.000Z",
        bodyPreview: "",
        evidenceIds: [],
        metadata: {},
      },
    ];
    store.restore([makeDoc("know_live")], { revisions });
    assert.ok(
      !store.listRevisions().some((r) => r.id === "revision_9"),
      "highest-id orphan tombstone should be dropped",
    );
    const next = store.recordRevision({ knowledgeId: "know_live", operation: "update", title: "x" });
    assert.equal(next.id, "revision_10", `sequence must account for dropped highest tombstone, got ${next.id}`);
  }

  // --- 4. retained revisions must not point at evicted evidence -------------
  {
    const store = new KnowledgeStore();
    const evidence = Array.from({ length: 20_050 }, (_, index) => {
      const seq = index + 1;
      return {
        id: `evidence_${seq}`,
        knowledgeId: "know_live",
        kind: "user_assertion" as const,
        summary: `e${seq}`,
        sourceRefs: [],
        confidence: undefined,
        observedAt: "2026-07-01T00:00:00.000Z",
        createdAt: `2026-07-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
        metadata: {},
      };
    });
    const revisions = [
      {
        id: "revision_10",
        knowledgeId: "know_live",
        operation: "update" as const,
        title: "revision with old evidence",
        createdAt: "2026-07-01T00:00:10.000Z",
        bodyPreview: "",
        evidenceIds: ["evidence_1"],
        metadata: {},
      },
    ];

    store.restore([makeDoc("know_live")], { evidence, revisions });
    assert.ok(
      store.listEvidence().some((record) => record.id === "evidence_1"),
      "evidence referenced by a retained revision should survive ledger caps",
    );
    store.recordEvidence({
      knowledgeId: "know_live",
      kind: "runtime_event",
      summary: "new direct evidence",
      sourceRefs: [],
      observedAt: "2026-07-01T00:01:00.000Z",
    });
    assert.ok(
      store.listEvidence().some((record) => record.id === "evidence_1"),
      "record-time evidence cap should not evict evidence referenced by a retained revision",
    );
  }

  console.log("knowledge-ledger-retention-harness passed");
}

main();
