import type { RoomMessage } from "./rooms-model";
import { sortRoomMessages } from "./rooms-api";

export function mergeHydratedRoomMessages(input: {
  serverMessages: RoomMessage[];
  currentMessages: RoomMessage[];
  messageIdsAtRequest: ReadonlySet<string>;
}): RoomMessage[] {
  const byId = new Map(input.serverMessages.map((message) => [message.id, message]));
  for (const message of input.currentMessages) {
    if (byId.has(message.id)) continue;
    if (message.status === "running" || !input.messageIdsAtRequest.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(sortRoomMessages);
}
