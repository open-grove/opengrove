#!/usr/bin/env node
// One-time offline compaction for a bloated OpenGrove local-state.json.
//
// Why: a knowledge native-sync bug (two physical dirs sharing one vaultPath)
// produced an unbounded create/delete churn, inflating knowledgeRevisions /
// knowledgeEvidence (and, via duplicate imports, knowledge) until the bridge
// OOM'd on load/save. The code fix stops new churn; this script shrinks the
// already-bloated file so the bridge can load it without crashing.
//
// This mirrors the in-app retention logic (KnowledgeStore caps + snapshot event
// compaction) applied offline, plus a knowledge de-dupe pass. It NEVER touches
// rooms (your chat), members, runs, sessions, routines, artifacts, approvals,
// questions, or workingState.
//
// Usage:
//   1. QUIT the OpenGrove app / stop the bridge first (the file is written live).
//   2. node --max-old-space-size=8192 scripts/compact-local-state.mjs [path]
//      (path defaults to the macOS location below)
//   3. Review the printed before/after report, then restart the app.
//
// A timestamped backup is written next to the file before anything is changed.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep these in sync with src/knowledge/store.ts and src/storage/json-state-store.ts.
const MAX_REVISIONS = 20_000;
const MAX_EVIDENCE = 20_000;
const MAX_DELIVERIES = 10_000;
const MAX_FEEDBACK = 10_000;
const MAX_VOLATILE_EVENTS = 4_000;
const VOLATILE_EVENT_TYPES = new Set([
  "assistant.delta",
  "assistant.status",
  "model.requested",
  "model.response",
  "runtime.diagnostic",
  "context.assembled",
]);

function defaultStatePath() {
  return join(homedir(), "Library", "Application Support", "OpenGrove", "data", "local-state.json");
}

function mb(n) {
  return `${(n / 1048576).toFixed(1)}MB`;
}

function timestamp() {
  // Avoid Date in a way that stays readable; this script runs interactively.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseSequencedId(id, prefix) {
  if (typeof id !== "string") return 0;
  const match = id.match(new RegExp(`^${prefix}_(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

// Keep newest `max` records; input is newest-first (list* serialization order),
// so we sort ascending by sequence and keep the tail.
function sortLedgerRecords(records, prefix) {
  return [...records].sort((a, b) => {
    const delta = parseSequencedId(a?.id, prefix) - parseSequencedId(b?.id, prefix);
    if (delta !== 0) return delta;
    return String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""));
  });
}

function keepNewest(records, prefix, max) {
  if (!Array.isArray(records)) return [];
  const ordered = sortLedgerRecords(records, prefix);
  return ordered.length > max ? ordered.slice(ordered.length - max) : ordered;
}

function collectRevisionEvidenceIds(revisions) {
  const ids = new Set();
  for (const revision of revisions) {
    for (const evidenceId of revision?.evidenceIds ?? []) {
      if (typeof evidenceId === "string" && evidenceId) ids.add(evidenceId);
    }
  }
  return ids;
}

function keepEvidenceForRevisions(records, requiredIds, max) {
  if (!Array.isArray(records)) return [];
  const byId = new Map(records.map((record) => [record?.id, record]));
  const required = [...requiredIds].map((id) => byId.get(id)).filter(Boolean);
  const requiredSet = new Set(required.map((record) => record.id));
  const optional = records.filter((record) => !requiredSet.has(record?.id));
  const optionalLimit = Math.max(0, max - required.length);
  // Preserve every evidence record still referenced by the retained revisions.
  // If that ever exceeds MAX_EVIDENCE, consistency wins over a hard cap.
  return sortLedgerRecords([...required, ...keepNewest(optional, "evidence", optionalLimit)], "evidence");
}

function compactEventLog(events, typeKey, maxVolatile) {
  if (!Array.isArray(events)) return [];
  const isVolatile = (e) => typeof e?.[typeKey] === "string" && VOLATILE_EVENT_TYPES.has(e[typeKey]);
  const volatileCount = events.reduce((c, e) => (isVolatile(e) ? c + 1 : c), 0);
  if (volatileCount <= maxVolatile) return events;
  let drop = volatileCount - maxVolatile;
  return events.filter((e) => {
    if (!isVolatile(e)) return true;
    if (drop > 0) {
      drop -= 1;
      return false;
    }
    return true;
  });
}

function main() {
  const path = process.argv[2] || defaultStatePath();
  if (!existsSync(path)) {
    console.error(`state file not found: ${path}`);
    process.exit(1);
  }

  const raw = readFileSync(path, "utf8");
  console.log(`Loaded ${path}`);
  console.log(`  on-disk size: ${mb(raw.length)}`);
  const state = JSON.parse(raw);

  const before = {
    knowledge: state.knowledge?.length ?? 0,
    knowledgeRevisions: state.knowledgeRevisions?.length ?? 0,
    knowledgeEvidence: state.knowledgeEvidence?.length ?? 0,
    knowledgeDeliveries: state.knowledgeDeliveries?.length ?? 0,
    knowledgeFeedback: state.knowledgeFeedback?.length ?? 0,
    events: state.events?.length ?? 0,
    executions: state.executions?.length ?? 0,
  };

  // 1. De-dupe knowledge documents by id (docIds are path-hash stable; a true
  //    duplicate shares an id). Keep the one with the newest sourceFileSyncedAt.
  const knowledgeById = new Map();
  for (const doc of state.knowledge ?? []) {
    const existing = knowledgeById.get(doc.id);
    if (!existing) {
      knowledgeById.set(doc.id, doc);
      continue;
    }
    const a = String(existing.metadata?.sourceFileSyncedAt ?? existing.updatedAt ?? "");
    const b = String(doc.metadata?.sourceFileSyncedAt ?? doc.updatedAt ?? "");
    knowledgeById.set(doc.id, b >= a ? doc : existing);
  }
  state.knowledge = [...knowledgeById.values()];
  const liveIds = new Set(knowledgeById.keys());

  // 2. Revisions: drop delete-tombstones for documents that no longer exist,
  //    then keep the newest MAX_REVISIONS.
  const prunedRevisions = (state.knowledgeRevisions ?? []).filter(
    (r) => !(r?.operation === "delete" && !liveIds.has(r?.knowledgeId)),
  );
  state.knowledgeRevisions = keepNewest(prunedRevisions, "revision", MAX_REVISIONS);

  // 3. Evidence: keep records referenced by the retained revisions, then fill
  //    the remaining budget with the newest evidence. This avoids producing
  //    revisions whose evidenceIds point to records the compaction just deleted.
  state.knowledgeEvidence = keepEvidenceForRevisions(
    state.knowledgeEvidence ?? [],
    collectRevisionEvidenceIds(state.knowledgeRevisions),
    MAX_EVIDENCE,
  );

  // 4. Deliveries / feedback: newest N.
  state.knowledgeDeliveries = keepNewest(state.knowledgeDeliveries ?? [], "delivery", MAX_DELIVERIES);
  state.knowledgeFeedback = keepNewest(state.knowledgeFeedback ?? [], "feedback", MAX_FEEDBACK);

  // 5. events / executions: keep all structural, tail-cap volatile.
  state.events = compactEventLog(state.events ?? [], "type", MAX_VOLATILE_EVENTS);
  state.executions = compactEventLog(state.executions ?? [], "eventType", MAX_VOLATILE_EVENTS);

  const after = {
    knowledge: state.knowledge.length,
    knowledgeRevisions: state.knowledgeRevisions.length,
    knowledgeEvidence: state.knowledgeEvidence.length,
    knowledgeDeliveries: state.knowledgeDeliveries.length,
    knowledgeFeedback: state.knowledgeFeedback.length,
    events: state.events.length,
    executions: state.executions.length,
  };

  console.log("\n  field                before      after");
  for (const key of Object.keys(before)) {
    console.log(`  ${key.padEnd(20)} ${String(before[key]).padStart(8)} -> ${String(after[key]).padStart(8)}`);
  }

  // Backup, then atomic write (no indentation — matches the app's saveFrom).
  const backup = `${path}.pre-compaction.${timestamp()}.bak`;
  copyFileSync(path, backup);
  console.log(`\nBackup written: ${backup}`);

  const output = `${JSON.stringify(state)}\n`;
  const tempPath = `${path}.compact.${process.pid}.tmp`;
  writeFileSync(tempPath, output, "utf8");
  renameSync(tempPath, path);
  console.log(`Compacted ${path}`);
  console.log(`  new on-disk size: ${mb(output.length)}  (was ${mb(raw.length)})`);
  console.log("\nDone. Restart OpenGrove.");
}

main();
