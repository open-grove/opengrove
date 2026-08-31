import type { RoomLedgerCapability } from "#agent-protocol";
import { createRoomLedgerCapability } from "../room-ledger-capabilities.js";

export function createRoomLedgerCapabilityForRoomRun(input: {
  runId: string;
  roomId: string;
  internalBridgeBaseUrl?: string;
}): RoomLedgerCapability | undefined {
  const apiBaseUrl = internalBridgeApiBaseUrl(input.internalBridgeBaseUrl);
  if (!apiBaseUrl) return undefined;
  return createRoomLedgerCapability({
    runId: input.runId,
    sourceRoomId: input.roomId,
    readUrl: `${apiBaseUrl}/room-ledger/read`,
  });
}

function internalBridgeApiBaseUrl(internalBridgeBaseUrl: string | undefined): string {
  const trimmed = internalBridgeBaseUrl?.trim().replace(/\/+$/, "") || "";
  if (!trimmed) return "";
  return `${trimmed}/api`;
}
