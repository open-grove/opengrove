import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";

test("scoped app creation leaves root long polls connected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-scoped-long-poll-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  try {
    const rootEvents = state.app.events;
    const rootRooms = state.app.rooms;
    const cursor = rootEvents.latest(20).cursor;
    const eventSeq = rootRooms.snapshot().currentEventSeq;
    let eventWaiterResolved = false;
    let roomWaiterResolved = false;
    const eventWaiter = rootEvents.waitForEventsAfter(cursor, undefined, "", 1_000).then(() => {
      eventWaiterResolved = true;
    });
    const roomWaiter = rootRooms.waitForEventsAfter(eventSeq, 1_000).then(() => {
      roomWaiterResolved = true;
    });

    const scopedState = {
      ...state,
      rootState: state,
    } satisfies BridgeState;
    recreateBridgeApp(scopedState);
    await delay(30);

    assert.notEqual(scopedState.app, state.app);
    assert.equal(eventWaiterResolved, false, "a scoped run must not reconnect global event clients");
    assert.equal(roomWaiterResolved, false, "a scoped run must not reconnect Room event clients");

    rootEvents.releaseEventWaiters();
    rootRooms.releaseEventWaiters();
    await Promise.all([eventWaiter, roomWaiter]);
  } finally {
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("root hot rebuild releases long polls and preserves event cursors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-root-long-poll-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  try {
    const previousApp = state.app;
    const cursor = previousApp.events.latest(20).cursor;
    const eventSeq = previousApp.rooms.snapshot().currentEventSeq;
    previousApp.rooms.createRoom({ title: "Retained across hot rebuild" });
    state.store.saveFrom(previousApp);
    const eventWaiter = previousApp.events.waitForEventsAfter(cursor, undefined, "", 1_000);
    const roomWaiter = previousApp.rooms.waitForEventsAfter(eventSeq, 1_000);

    recreateBridgeApp(state);
    await Promise.race([
      Promise.all([eventWaiter, roomWaiter]),
      delay(250).then(() => assert.fail("root rebuild did not release long-poll waiters promptly")),
    ]);

    assert.notEqual(state.app, previousApp);
    assert.equal(state.app.events.eventsAfter(cursor, 20).resetRequired, false);
    const roomDelta = state.app.rooms.eventsAfter(eventSeq, 20);
    assert.equal(roomDelta.resetRequired, false, "Room event history must survive a hot rebuild");
    assert.ok(roomDelta.events.length > 0);
  } finally {
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
