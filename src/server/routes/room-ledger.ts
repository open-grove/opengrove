import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeState } from "../bridge-types.js";
import { record } from "../http-utils.js";
import { readRoomLedgerCapability } from "../room-ledger-capabilities.js";
import { resolveLedgerRoom } from "../../rooms/ledger-room-resolver.js";
import { buildRoomLedgerReadValue } from "../../rooms/ledger-view.js";

export async function handleRoomLedgerCapabilityRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  sendJson: (response: ServerResponse, status: number, data: unknown) => void;
  readJsonBody: (request: IncomingMessage) => Promise<unknown>;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = input;
  if (request.method !== "POST" || url.pathname !== "/room-ledger/read") {
    return false;
  }

  const capability = readRoomLedgerCapability(readBearerToken(request.headers.authorization));
  if (!capability) {
    sendJson(response, 403, { ok: false, error: "ledger_capability_invalid" });
    return true;
  }

  const body = record(await readJsonBody(request));
  const sourceRoomId = capability.sourceRoomId.trim();
  const resolved = resolveLedgerRoom(state.app.rooms, sourceRoomId);
  if (!resolved) {
    sendJson(response, 404, { ok: false, error: "room_not_found" });
    return true;
  }
  const room = resolved.room;

  sendJson(response, 200, {
    ok: true,
    value: buildRoomLedgerReadValue(state.app.rooms, room, body),
  });
  return true;
}

function readBearerToken(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}
