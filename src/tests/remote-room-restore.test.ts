import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRoomChannelSnapshot } from "../rooms/channel-store.js";

test("invalid remote metadata cannot hide local contacts or conversation history", () => {
  const restored = normalizeRoomChannelSnapshot({
    rooms: [{ id: "room", memberIds: ["local", "remote"] }],
    members: [
      { id: "local", source: "manual" },
      { id: "remote", source: "remote", remoteAgent: { address: 42 } },
    ],
    messages: [
      { id: "local-reply", roomId: "room", text: "Keep this reply", status: "done" },
      { id: "remote-reply", roomId: "room", text: "Keep this too", status: "running", remoteTask: { pending: true } },
    ],
  });
  assert.equal(restored.members[0]!.disabled, false);
  assert.equal(restored.members[1]!.source, "remote");
  assert.equal(restored.members[1]!.disabled, true);
  assert.equal(restored.members[1]!.remoteAgent, undefined);
  assert.deepEqual(
    restored.messages.map((m) => m.text),
    ["Keep this reply", "Keep this too"],
  );
  assert.equal(restored.messages[1]!.status, "interrupted");
  assert.equal(restored.messages[1]!.remoteTask, undefined);
});
