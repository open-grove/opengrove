import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonObject, JsonValue, ToolCallContext, ToolDefinition, ToolResult, ToolSpec } from "../core.js";
import type { RoomContextRef, RoomLedgerCapability } from "#agent-protocol";
import type { RoomChannelStore } from "../rooms/channel-store.js";
import { resolveLedgerRoom } from "../rooms/ledger-room-resolver.js";
import { buildRoomLedgerReadValue, normalizeRoomLedgerReadValue } from "../rooms/ledger-view.js";

export interface RoomLedgerRunContext {
  sourceRoomId?: string;
  roomContextRef?: RoomContextRef;
  ledgerCapability?: RoomLedgerCapability;
}

const roomLedgerContextsByRun = new Map<string, RoomLedgerRunContext>();
const roomLedgerContext = new AsyncLocalStorage<RoomLedgerRunContext>();

export async function withRoomLedgerAccessForRun<T>(
  runId: string | undefined,
  ledgerAccess: RoomLedgerRunContext | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const normalizedRunId = runId?.trim();
  const normalizedSourceRoomId = ledgerAccess?.sourceRoomId?.trim();
  if (!normalizedSourceRoomId) {
    return await callback();
  }
  const normalizedLedgerAccess = {
    ...ledgerAccess,
    sourceRoomId: normalizedSourceRoomId,
  };
  if (!normalizedRunId) {
    return await roomLedgerContext.run(normalizedLedgerAccess, callback);
  }
  roomLedgerContextsByRun.set(normalizedRunId, normalizedLedgerAccess);
  try {
    return await roomLedgerContext.run(normalizedLedgerAccess, callback);
  } finally {
    roomLedgerContextsByRun.delete(normalizedRunId);
  }
}

export function createRoomLedgerReadTool(
  spec: ToolSpec,
  rooms: RoomChannelStore,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input, context): Promise<ToolResult<JsonValue>> {
      const runLedger = readRunLedgerContext(context);
      const roomContextCapability = capabilityFromRoomContextRef(runLedger?.roomContextRef);
      if (roomContextCapability) {
        return await readCapabilityRoomLedger(roomContextCapability, input);
      }
      if (runLedger?.ledgerCapability) {
        const capabilityResult = await readCapabilityRoomLedger(runLedger.ledgerCapability, input);
        if (capabilityResult.ok || !canFallBackToLocalLedger(capabilityResult.error)) {
          return capabilityResult;
        }
        const localResult = readLocalRoomLedger(rooms, runLedger.sourceRoomId, input);
        if (!localResult.ok) return capabilityResult;
        console.warn("room_ledger_local_fallback", {
          sourceRoomId: runLedger.sourceRoomId,
          readUrl: runLedger.ledgerCapability.readUrl,
          error: capabilityResult.error,
        });
        return localResult;
      }

      const roomId = runLedger?.sourceRoomId || readString(input.roomId);
      return readLocalRoomLedger(rooms, roomId, input);
    },
  };
}

function readLocalRoomLedger(
  rooms: RoomChannelStore,
  roomId: string | undefined,
  input: JsonObject,
): ToolResult<JsonValue> {
  if (!roomId) {
    return { ok: false, error: "room_id_required" };
  }
  const resolved = resolveLedgerRoom(rooms, roomId);
  if (!resolved) {
    return { ok: false, error: "room_not_found" };
  }
  return {
    ok: true,
    value: buildRoomLedgerReadValue(rooms, resolved.room, input),
  };
}

function canFallBackToLocalLedger(error: string | undefined): boolean {
  return (
    error === "authentication_required" ||
    error === "session_required" ||
    error === "bridge_token_required" ||
    error === "not_found" ||
    error?.startsWith("room_ledger_read_failed:") === true ||
    (error ? /^http_(?:401|403|404|408|429|5\d\d)$/.test(error) : false)
  );
}

function readRunLedgerContext(context: ToolCallContext | undefined): RoomLedgerRunContext | undefined {
  const runId = context?.runId?.trim();
  return (runId ? roomLedgerContextsByRun.get(runId) : undefined) ?? roomLedgerContext.getStore();
}

function capabilityFromRoomContextRef(ref: RoomContextRef | undefined): RoomLedgerCapability | undefined {
  if (!ref || ref.kind === "local-room") return undefined;
  return {
    sourceRoomId: ref.sourceRoomId,
    readUrl: ref.readUrl,
    token: ref.token,
    expiresAt: ref.expiresAt,
  };
}

async function readCapabilityRoomLedger(
  capability: RoomLedgerCapability,
  input: JsonObject,
): Promise<ToolResult<JsonValue>> {
  const readUrl = capability.readUrl.trim();
  const token = capability.token.trim();
  if (!readUrl || !token) {
    return { ok: false, error: "ledger_capability_invalid" };
  }

  const body = JSON.stringify({
    roomId: readString(input.roomId),
    query: readString(input.query),
    limit: readOptionalNumber(input.limit),
    beforeSeq: readOptionalNumber(input.beforeSeq),
    afterSeq: readOptionalNumber(input.afterSeq),
    includeMembers: input.includeMembers === true,
  });
  const response = await fetchRoomLedgerCapability(readUrl, token, body);
  if (!response.ok) {
    return { ok: false, error: response.error };
  }

  const payload = (await response.response.json().catch(() => undefined)) as
    | { ok?: boolean; error?: unknown; value?: JsonValue }
    | undefined;
  if (!response.response.ok || payload?.ok !== true) {
    const error = typeof payload?.error === "string" ? payload.error : `http_${response.response.status}`;
    return { ok: false, error };
  }

  return {
    ok: true,
    value: normalizeRoomLedgerReadValue(payload.value, input.includeMembers === true),
  };
}

async function fetchRoomLedgerCapability(
  readUrl: string,
  token: string,
  body: string,
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(readUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      });
      return { ok: true, response };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 2) {
        await delay(150 * (attempt + 1));
      }
    }
  }
  return { ok: false, error: `room_ledger_read_failed:${lastError || "fetch_failed"}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
