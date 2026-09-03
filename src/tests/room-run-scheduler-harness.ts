import assert from "node:assert/strict";
import { RoomChannelStore, type RoomChannelMember, type RoomChannelMessage } from "../rooms/channel-store.js";
import type { BridgeState } from "../server/bridge-types.js";
import {
  activeRoomRunIds,
  clearRoomRunController,
  reapInactiveRoomRun,
  scheduleRoomAssistantRunsWithExecutor,
  type RoomRunExecutionInput,
} from "../server/room-runs/scheduler.js";

const NOW = "2026-07-10T00:00:00.000Z";

async function main(): Promise<void> {
  await assertSameRoomSameMemberSerializes();
  await assertDifferentRoomsSameMemberRunConcurrently();
  await assertSameRoomDifferentMembersRunConcurrently();
  await assertCompositeQueueKeysCannotCollide();
  await assertRejectedRunDoesNotLeakOrPoisonQueue();
  await assertMissingFinalizationCallbackCannotHangCaller();
  await assertInactiveMessagesAreReapedWithoutInterruptingLiveRuns();
  await assertScopedSchedulingUsesTheRootControllerRegistry();
  console.log("room-run-scheduler-harness passed");
}

async function assertMissingFinalizationCallbackCannotHangCaller(): Promise<void> {
  const state = createHarnessState();
  const member = createMember("member-app-demo-missing-finalization");
  let finalizedError = "";
  const [message] = scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId: "room-missing-finalization",
      triggerMessageId: "user-missing-finalization",
      targets: [member],
      assistantMessages: [createAssistantMessage("room-missing-finalization", "message-missing-finalization", member)],
      onMessageFinalized: ({ error }) => {
        finalizedError = error ?? "";
      },
    },
    async () => {
      // A broken executor returns without invoking the finalization callback.
    },
  );
  assert.ok(message?.runId);
  await waitFor(() => finalizedError !== "", "producer settlement fallback");
  assert.equal(finalizedError, "room_run_finalization_missing");
  clearRoomRunController(state, message.runId);
}

async function assertScopedSchedulingUsesTheRootControllerRegistry(): Promise<void> {
  const rootState = createHarnessState();
  rootState.rootState = rootState;
  const scopedState = { ...rootState, rootState } as BridgeState;
  const executor = createControlledExecutor();
  const member = createMember("member-app-demo-scoped-controller");
  const [message] = scheduleRoomAssistantRunsWithExecutor(
    scopedState,
    {
      roomId: "room-scoped-controller",
      triggerMessageId: "user-scoped-controller",
      targets: [member],
      assistantMessages: [createAssistantMessage("room-scoped-controller", "message-scoped-controller", member)],
    },
    executor.execute,
  );
  assert.ok(message?.runId);
  assert.equal(activeRoomRunIds(rootState).has(message.runId), true);
  assert.equal(activeRoomRunIds(scopedState).has(message.runId), true);

  await waitFor(() => executor.starts.length === 1, "scoped controller run to start");
  executor.release(message.id);
  await waitFor(() => executor.completed() === 1, "scoped controller run to complete");
  clearRoomRunController(scopedState, message.runId);
  assert.equal(activeRoomRunIds(rootState).has(message.runId), false);
}

async function assertInactiveMessagesAreReapedWithoutInterruptingLiveRuns(): Promise<void> {
  const rooms = new RoomChannelStore();
  const member = createMember("member-app-demo-liveness");
  rooms.upsertMember(member);
  const room = rooms.createRoom({ title: "Liveness", memberIds: [member.id] });
  rooms.createAssistantPlaceholder({
    roomId: room.id,
    target: member,
    id: "message-stale",
    runId: "room_run_stale",
  });
  const livePlaceholder = rooms.createAssistantPlaceholder({
    roomId: room.id,
    target: member,
    id: "message-live",
  });
  let saveCount = 0;
  const state = {
    app: { rooms },
    settings: { language: "zh-CN" },
    store: {
      saveFrom: () => {
        saveCount += 1;
        return {};
      },
    },
  } as unknown as BridgeState;
  state.rootState = state;
  const executor = createControlledExecutor();
  const [liveMessage] = scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId: room.id,
      triggerMessageId: "user-live",
      targets: [member],
      assistantMessages: [livePlaceholder],
    },
    executor.execute,
  );
  assert.ok(liveMessage?.runId);
  await waitFor(() => executor.starts.length === 1, "live liveness run to start");

  assert.equal(
    reapInactiveRoomRun(
      state,
      {
        roomId: room.id,
        assistantMessageId: "message-stale",
        runId: "room_run_stale",
      },
      NOW,
    ),
    true,
  );
  assert.equal(rooms.getMessage(room.id, "message-stale")?.status, "interrupted");
  assert.equal(rooms.getMessage(room.id, "message-live")?.status, "running");
  assert.equal(saveCount, 1);
  assert.equal(
    reapInactiveRoomRun(
      state,
      {
        roomId: room.id,
        assistantMessageId: liveMessage.id,
        runId: liveMessage.runId,
      },
      NOW,
    ),
    false,
    "a registered producer must never be reaped merely for being quiet",
  );

  executor.release("message-live");
  await waitFor(() => executor.completed() === 1, "live liveness run to complete");
  clearRoomRunController(state, liveMessage.runId);
  assert.equal(
    reapInactiveRoomRun(
      state,
      {
        roomId: room.id,
        assistantMessageId: liveMessage.id,
        runId: liveMessage.runId,
      },
      NOW,
    ),
    true,
  );
  assert.equal(rooms.getMessage(room.id, "message-live")?.status, "interrupted");
}

async function assertSameRoomSameMemberSerializes(): Promise<void> {
  const state = createHarnessState();
  const executor = createControlledExecutor();
  const member = createMember("member-app-demo-worker");

  scheduleRun(state, "room-a", member, "message-a-1", executor.execute);
  scheduleRun(state, "room-a", member, "message-a-2", executor.execute);

  await waitFor(() => executor.starts.length === 1, "first same-room run to start");
  await nextEventLoopTurn();
  assert.deepEqual(
    executor.starts,
    ["room-a:message-a-1"],
    "same member in the same room must not start a second turn concurrently",
  );

  executor.release("message-a-1");
  await waitFor(() => executor.starts.length === 2, "second same-room run to start after release");
  assert.deepEqual(executor.starts, ["room-a:message-a-1", "room-a:message-a-2"]);
  executor.release("message-a-2");
  await waitFor(() => executor.completed() === 2, "same-room runs to complete");
}

async function assertDifferentRoomsSameMemberRunConcurrently(): Promise<void> {
  const state = createHarnessState();
  const executor = createControlledExecutor();
  const member = createMember("member-app-demo-worker");

  scheduleRun(state, "room-a", member, "message-a", executor.execute);
  scheduleRun(state, "room-b", member, "message-b", executor.execute);

  await waitFor(() => executor.starts.length === 2, "cross-room runs to start concurrently");
  assert.deepEqual(
    new Set(executor.starts),
    new Set(["room-a:message-a", "room-b:message-b"]),
    "the same member must be able to run concurrently in isolated rooms",
  );

  executor.release("message-a");
  executor.release("message-b");
  await waitFor(() => executor.completed() === 2, "cross-room runs to complete");
}

async function assertSameRoomDifferentMembersRunConcurrently(): Promise<void> {
  const state = createHarnessState();
  const executor = createControlledExecutor();

  scheduleRun(state, "room-a", createMember("member-app-demo-writer"), "message-writer", executor.execute);
  scheduleRun(state, "room-a", createMember("member-app-demo-editor"), "message-editor", executor.execute);

  await waitFor(() => executor.starts.length === 2, "different members to start concurrently");
  assert.deepEqual(new Set(executor.starts), new Set(["room-a:message-writer", "room-a:message-editor"]));

  executor.release("message-writer");
  executor.release("message-editor");
  await waitFor(() => executor.completed() === 2, "different-member runs to complete");
}

async function assertCompositeQueueKeysCannotCollide(): Promise<void> {
  const state = createHarnessState();
  const executor = createControlledExecutor();

  scheduleRun(state, "room:a", createMember("member"), "message-room-colon", executor.execute);
  scheduleRun(state, "room", createMember("a:member"), "message-member-colon", executor.execute);

  await waitFor(() => executor.starts.length === 2, "unambiguous composite queue keys");
  assert.deepEqual(
    new Set(executor.starts),
    new Set(["room:a:message-room-colon", "room:message-member-colon"]),
    "distinct room/member pairs must never share a queue because of delimiter characters",
  );

  executor.release("message-room-colon");
  executor.release("message-member-colon");
  await waitFor(() => executor.completed() === 2, "composite-key runs to complete");
}

async function assertRejectedRunDoesNotLeakOrPoisonQueue(): Promise<void> {
  const state = createHarnessState();
  const member = createMember("member-app-demo-rejecting");
  const starts: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    scheduleRun(state, "room-reject", member, "message-reject", async () => {
      starts.push("rejected");
      throw new Error("scheduler-harness-rejection");
    });
    scheduleRun(state, "room-reject", member, "message-after-reject", async () => {
      starts.push("continued");
    });
    await waitFor(() => starts.length === 2, "queue to continue after a rejected run");
    await nextEventLoopTurn();
    assert.deepEqual(starts, ["rejected", "continued"]);
    assert.deepEqual(unhandled, [], "a rejected executor must have a terminal rejection handler");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

type HarnessExecutor = (state: BridgeState, input: RoomRunExecutionInput) => Promise<void>;

function createControlledExecutor(): {
  execute: HarnessExecutor;
  starts: string[];
  release(messageId: string): void;
  completed(): number;
} {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let completed = 0;
  return {
    starts,
    execute: async (_state, input) => {
      starts.push(`${input.roomId}:${input.assistantMessageId}`);
      await new Promise<void>((resolve) => {
        releases.set(input.assistantMessageId, resolve);
      });
      completed += 1;
    },
    release(messageId) {
      const release = releases.get(messageId);
      assert.ok(release, `run ${messageId} must have started before release`);
      releases.delete(messageId);
      release();
    },
    completed: () => completed,
  };
}

function scheduleRun(
  state: BridgeState,
  roomId: string,
  target: RoomChannelMember,
  assistantMessageId: string,
  execute: HarnessExecutor,
): void {
  scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId,
      triggerMessageId: `user-${assistantMessageId}`,
      targets: [target],
      assistantMessages: [createAssistantMessage(roomId, assistantMessageId, target)],
    },
    execute,
  );
}

function createHarnessState(): BridgeState {
  return {
    app: {
      rooms: {
        updateMessage: (roomId: string, messageId: string, patch: Partial<RoomChannelMessage>): RoomChannelMessage => ({
          ...createAssistantMessage(roomId, messageId, createMember("member-app-demo-worker")),
          ...patch,
          updatedAt: NOW,
        }),
      },
    },
  } as unknown as BridgeState;
}

function createMember(id: string): RoomChannelMember {
  return {
    id,
    name: id,
    kernel: "claude-code",
    model: "claude-sonnet-4-5",
    role: "Harness employee",
    status: "idle",
    color: "#000000",
    lastActive: "ready",
    appId: "demo",
    source: "local",
  };
}

function createAssistantMessage(roomId: string, id: string, target: RoomChannelMember): RoomChannelMessage {
  return {
    id,
    roomId,
    channelSeq: 1,
    senderId: target.id,
    senderName: target.name,
    senderType: "agent",
    text: "",
    targetIds: [],
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await nextEventLoopTurn();
  }
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
