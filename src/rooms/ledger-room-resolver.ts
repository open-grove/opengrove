import type { RoomChannelRoom, RoomChannelStore } from "./channel-store.js";

export function resolveLedgerRoom(
  rooms: RoomChannelStore,
  requestedRoomId: string,
): { room: RoomChannelRoom } | undefined {
  const requested = normalizeRequestedRoomId(requestedRoomId);
  const candidates = uniqueStrings(
    [requestedRoomId, requested, safeDecodeURIComponent(requestedRoomId), safeDecodeURIComponent(requested)]
      .map(normalizeRequestedRoomId)
      .filter(Boolean),
  );

  for (const candidate of candidates) {
    const exact = rooms.getRoom(candidate);
    if (exact) return { room: exact };
  }

  return undefined;
}

function normalizeRequestedRoomId(value: string): string {
  let normalized = value.trim();
  if (!normalized) return "";
  if (normalized.startsWith("opengrove://rooms/")) {
    normalized = normalized.slice("opengrove://rooms/".length);
  }
  const hashIndex = normalized.indexOf("#");
  if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex);
  const queryIndex = normalized.indexOf("?");
  if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex);
  return normalized.trim();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
