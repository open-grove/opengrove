import { randomBytes } from "node:crypto";
import type { RoomLedgerCapability } from "#agent-protocol";

const DEFAULT_ROOM_LEDGER_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ROOM_LEDGER_CAPABILITY_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ROOM_LEDGER_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

export interface RoomLedgerCapabilityRecord extends RoomLedgerCapability {
  runId: string;
  createdAt: string;
}

const roomLedgerCapabilities = new Map<string, RoomLedgerCapabilityRecord>();
const roomLedgerCapabilityLeases = new Map<string, { ttlMs: number; absoluteExpiresAtMs: number }>();

export function createRoomLedgerCapability(input: {
  runId: string;
  sourceRoomId: string;
  readUrl: string;
  ttlMs?: number;
  maxLifetimeMs?: number;
  now?: number;
}): RoomLedgerCapabilityRecord {
  const now = input.now ?? Date.now();
  pruneExpiredRoomLedgerCapabilities(now);
  const ttlMs = positiveDuration(input.ttlMs, DEFAULT_ROOM_LEDGER_CAPABILITY_TTL_MS);
  const maxLifetimeMs = positiveDuration(input.maxLifetimeMs, DEFAULT_ROOM_LEDGER_CAPABILITY_MAX_LIFETIME_MS);
  const token = `roomledger_${randomBytes(32).toString("base64url")}`;
  const record: RoomLedgerCapabilityRecord = {
    token,
    runId: input.runId,
    sourceRoomId: input.sourceRoomId,
    readUrl: input.readUrl,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(ttlMs, maxLifetimeMs)).toISOString(),
  };
  roomLedgerCapabilities.set(token, record);
  roomLedgerCapabilityLeases.set(token, { ttlMs, absoluteExpiresAtMs: now + maxLifetimeMs });
  return record;
}

export function readRoomLedgerCapability(
  token: string | undefined,
  now = Date.now(),
): RoomLedgerCapabilityRecord | undefined {
  pruneExpiredRoomLedgerCapabilities(now);
  const normalized = token?.trim();
  if (!normalized) return undefined;
  return roomLedgerCapabilities.get(normalized);
}

/** Host-owned renewal; capability reads intentionally never extend the lease. */
export function renewRoomLedgerCapability(
  token: string | undefined,
  now = Date.now(),
): RoomLedgerCapabilityRecord | undefined {
  const normalized = token?.trim();
  if (!normalized) return undefined;
  pruneExpiredRoomLedgerCapabilities(now);
  const record = roomLedgerCapabilities.get(normalized);
  const lease = roomLedgerCapabilityLeases.get(normalized);
  if (!record || !lease || now >= lease.absoluteExpiresAtMs) {
    revokeRoomLedgerCapability(normalized);
    return undefined;
  }
  record.expiresAt = new Date(Math.min(now + lease.ttlMs, lease.absoluteExpiresAtMs)).toISOString();
  return record;
}

export function keepRoomLedgerCapabilityAlive(
  token: string | undefined,
  intervalMs = DEFAULT_ROOM_LEDGER_KEEPALIVE_INTERVAL_MS,
): () => void {
  const normalized = token?.trim();
  if (!normalized) return () => {};
  const lease = roomLedgerCapabilityLeases.get(normalized);
  if (!lease) return () => {};
  const safeIntervalMs = Math.max(1, Math.min(intervalMs, Math.max(1, lease.ttlMs - 1)));
  const timer = setInterval(() => renewRoomLedgerCapability(normalized), safeIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function revokeRoomLedgerCapability(token: string | undefined): void {
  const normalized = token?.trim();
  if (!normalized) return;
  roomLedgerCapabilities.delete(normalized);
  roomLedgerCapabilityLeases.delete(normalized);
}

export function pruneExpiredRoomLedgerCapabilities(now = Date.now()): void {
  for (const [token, capability] of roomLedgerCapabilities) {
    const expiresAt = Date.parse(capability.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      roomLedgerCapabilities.delete(token);
      roomLedgerCapabilityLeases.delete(token);
    }
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
