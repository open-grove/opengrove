import assert from "node:assert/strict";
import test from "node:test";
import { RoomChannelStore } from "../rooms/channel-store.js";

test("Rooms init caps messages across all rooms", () => {
  const store = new RoomChannelStore();
  for (let roomIndex = 0; roomIndex < 3; roomIndex += 1) {
    const room = store.createRoom({ id: `room-${roomIndex}`, title: `Room ${roomIndex}` });
    for (let messageIndex = 0; messageIndex < 3; messageIndex += 1) {
      store.postAgentMessage({
        roomId: room.id,
        senderId: "agent",
        senderName: "Agent",
        text: `${roomIndex}:${messageIndex}`,
      });
    }
  }

  const initial = store.getInit(3, 4);
  assert.equal(initial.messages.length, 4);
  assert.equal(initial.messagesTruncated, true);
});
