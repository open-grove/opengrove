import { randomBytes } from "node:crypto";
import type { RoomLedgerCapability } from "#agent-protocol";

const DEFAULT_ROOM_LEDGER_CAPABILITY_TTL_MS = 15 * 60 * 1000;

export interface RoomLedgerCapabilityRecord extends RoomLedgerCapability {
  runId: string;
  createdAt: string;
}

const roomLedgerCapabilities = new Map<string, RoomLedgerCapabilityRecord>();

export function createRoomLedgerCapability(input: {
  runId: string;
  sourceRoomId: string;
  readUrl: string;
  ttlMs?: number;
}): RoomLedgerCapabilityRecord {
  pruneExpiredRoomLedgerCapabilities();
  const now = Date.now();
  const token = `roomledger_${randomBytes(32).toString("base64url")}`;
  const record: RoomLedgerCapabilityRecord = {
    token,
    runId: input.runId,
    sourceRoomId: input.sourceRoomId,
    readUrl: input.readUrl,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_ROOM_LEDGER_CAPABILITY_TTL_MS)).toISOString(),
  };
  roomLedgerCapabilities.set(token, record);
  return record;
}

export function readRoomLedgerCapability(token: string | undefined): RoomLedgerCapabilityRecord | undefined {
  pruneExpiredRoomLedgerCapabilities();
  const normalized = token?.trim();
  if (!normalized) return undefined;
  return roomLedgerCapabilities.get(normalized);
}

export function revokeRoomLedgerCapability(token: string | undefined): void {
  const normalized = token?.trim();
  if (!normalized) return;
  roomLedgerCapabilities.delete(normalized);
}

export function pruneExpiredRoomLedgerCapabilities(now = Date.now()): void {
  for (const [token, capability] of roomLedgerCapabilities) {
    const expiresAt = Date.parse(capability.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      roomLedgerCapabilities.delete(token);
    }
  }
}
