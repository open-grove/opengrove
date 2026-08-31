import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EventLog } from "../core/events.js";
import type { AgentEvent } from "../core/types.js";

function event(runId: string, index: number) {
  return {
    type: "turn.started" as const,
    runId,
    at: `2026-08-04T00:00:0${index}.000Z`,
  };
}

test("EventLog serves a bounded tail snapshot and then only newer events", () => {
  const log = new EventLog();
  log.append(event("run-1", 1));
  log.append(event("run-1", 2));
  log.append(event("run-2", 3));

  const snapshot = log.latest(2);
  assert.deepEqual(snapshot.events, [event("run-1", 2), event("run-2", 3)]);
  assert.equal(snapshot.hasOlder, true);
  assert.equal(snapshot.hasMore, false);
  assert.equal(snapshot.resetRequired, false);
  assert.match(snapshot.cursor, /^evt1_/);
  assert.match(snapshot.oldestCursor, /^evt1_/);

  log.append(event("run-2", 4));
  const delta = log.eventsAfter(snapshot.cursor, 20);
  assert.deepEqual(delta.events, [event("run-2", 4)]);
  assert.equal(delta.hasOlder, false);
  assert.equal(delta.hasMore, false);
  assert.equal(delta.resetRequired, false);
});

test("EventLog backfills older retained pages without changing the live cursor", () => {
  const log = new EventLog();
  for (let index = 1; index <= 5; index += 1) log.append(event("run-1", index));

  const snapshot = log.latest(2);
  const older = log.eventsBefore(snapshot.oldestCursor, 2);
  assert.deepEqual(older.events, [event("run-1", 2), event("run-1", 3)]);
  assert.equal(older.hasOlder, true);
  assert.equal(older.cursor, snapshot.cursor);

  const oldest = log.eventsBefore(older.oldestCursor, 2);
  assert.deepEqual(oldest.events, [event("run-1", 1)]);
  assert.equal(oldest.hasOlder, false);
});

test("EventLog cursors are bound to their filter scope", () => {
  const log = new EventLog();
  log.append(event("run-1", 1));
  const runOneCursor = log.latest(20, (entry) => entry.runId === "run-1", "run-1").cursor;

  assert.equal(log.eventsAfter(runOneCursor, 20, (entry) => entry.runId === "run-2", "run-2").resetRequired, true);
});

test("EventLog advances a filtered cursor across unrelated events", () => {
  const log = new EventLog();
  const emptyCursor = log.latest(20).cursor;
  log.append(event("run-1", 1));
  log.append(event("run-2", 2));
  log.append(event("run-2", 3));

  const page = log.eventsAfter(emptyCursor, 20, (entry) => entry.runId === "run-1");
  assert.deepEqual(page.events, [event("run-1", 1)]);
  assert.equal(page.hasMore, false);

  log.append(event("run-1", 4));
  assert.deepEqual(log.eventsAfter(page.cursor, 20, (entry) => entry.runId === "run-1").events, [event("run-1", 4)]);
});

test("EventLog reports an expired cursor after its hot window advances", () => {
  const log = new EventLog();
  log.setRetentionLimit(2);
  const cursor = log.latest(20).cursor;
  log.append(event("run-1", 1));
  log.append(event("run-1", 2));
  log.append(event("run-1", 3));

  const expired = log.eventsAfter(cursor, 20);
  assert.deepEqual(expired.events, []);
  assert.equal(expired.resetRequired, true);

  const snapshot = log.latest(20);
  assert.deepEqual(snapshot.events, [event("run-1", 2), event("run-1", 3)]);
  assert.equal(snapshot.hasOlder, false, "retained-window truncation is not backfillable from memory");
});

test("EventLog does not let a waiter predicate failure break append", async () => {
  const log = new EventLog();
  const cursor = log.latest(20).cursor;
  const waiting = log.waitForEventsAfter(
    cursor,
    () => {
      throw new Error("broken predicate");
    },
    "",
    1_000,
  );

  assert.doesNotThrow(() => log.append(event("run-safe", 1)));
  await waiting;
  assert.deepEqual(log.latest(20).events, [event("run-safe", 1)]);
});

test("EventLog does not wait on a cursor outside the retained window", async () => {
  const log = new EventLog();
  log.setRetentionLimit(2);
  const cursor = log.latest(20).cursor;
  log.append(event("run-1", 1));
  log.append(event("run-1", 2));
  log.append(event("run-1", 3));

  const startedAt = Date.now();
  await log.waitForEventsAfter(cursor, undefined, "", 1_000);
  assert.ok(Date.now() - startedAt < 100, "an expired cursor must resolve immediately for reset");
});

test("EventLog rejects a cursor from before restore or clear", () => {
  const log = new EventLog();
  log.append(event("old", 1));
  const beforeRestore = log.latest(20).cursor;

  log.restore([event("restored", 1), event("restored", 2)]);
  assert.equal(log.eventsAfter(beforeRestore, 20).resetRequired, true);

  const beforeClear = log.latest(20).cursor;
  log.clear();
  for (let index = 1; index <= 3; index += 1) log.append(event("new", index));
  assert.equal(log.eventsAfter(beforeClear, 20).resetRequired, true);
});

test("EventLog keeps cursors valid across an explicit in-process checkpoint restore", () => {
  const original = new EventLog();
  original.setRetentionLimit(2);
  original.append(event("run-hot", 1));
  original.append(event("run-hot", 2));
  original.append(event("run-hot", 3));
  const cursor = original.latest(20).cursor;

  const replacement = new EventLog();
  replacement.setRetentionLimit(2);
  replacement.restore([event("persisted", 1)]);
  replacement.restoreCheckpoint(original.checkpoint());
  replacement.append(event("run-hot", 4));

  const delta = replacement.eventsAfter(cursor, 20);
  assert.equal(delta.resetRequired, false);
  assert.deepEqual(delta.events, [event("run-hot", 4)]);
  assert.deepEqual(replacement.latest(20).events, [event("run-hot", 3), event("run-hot", 4)]);
});

test("EventLog long polling wakes only for matching events", async () => {
  const log = new EventLog();
  const predicate = (entry: AgentEvent) => entry.runId === "run-watched";
  const cursor = log.latest(20, predicate, "run-watched").cursor;
  let resolved = false;
  const waiting = log.waitForEventsAfter(cursor, predicate, "run-watched", 1_000).then(() => {
    resolved = true;
  });

  log.append(event("run-unrelated", 1));
  await delay(20);
  assert.equal(resolved, false, "an unrelated run must not wake a scoped long poll");

  log.append(event("run-watched", 2));
  await waiting;
  assert.equal(resolved, true);
});

test("EventLog long polling has a bounded idle timeout", async () => {
  const log = new EventLog();
  const cursor = log.latest(20).cursor;
  const startedAt = Date.now();
  await log.waitForEventsAfter(cursor, undefined, "", 50);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 35, `long poll timed out too early (${elapsedMs} ms)`);
  assert.ok(elapsedMs < 500, `long poll exceeded its timeout budget (${elapsedMs} ms)`);
});
