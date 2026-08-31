import assert from "node:assert/strict";
import test from "node:test";
import type { RoomChannelMessage } from "../rooms/channel-store.js";
import { presentRoomMessage } from "../server/room-presentation.js";

test("room snapshots replace large inline image bytes with an on-demand URL", () => {
  const message: RoomChannelMessage = {
    id: "message-1",
    roomId: "room-1",
    channelSeq: 1,
    senderId: "user",
    senderName: "Me",
    senderType: "user",
    text: "image",
    targetIds: [],
    status: "sent",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    attachments: [
      {
        id: "attachment-1",
        name: "large.png",
        kind: "image",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${"a".repeat(1_000_000)}`,
      },
    ],
  };

  const presented = presentRoomMessage(message);
  const serialized = JSON.stringify(presented);
  assert.doesNotMatch(serialized, /data:image/);
  assert.match(serialized, /\/rooms\/room-1\/messages\/message-1\/attachments\/0\/content/);
  assert.ok(serialized.length < 5_000);
});
