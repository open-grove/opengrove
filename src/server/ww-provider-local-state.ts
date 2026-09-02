import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BridgeState } from "./bridge-types.js";
import { writePrivateFileAtomically } from "../storage/private-file.js";
import { bridgeDataPath } from "./storage-paths.js";

const WW_PROVIDER_LOCAL_STATE_VERSION = 1;
const WW_PROVIDER_LOCAL_STATE_FILE = "ww-provider.json";
const MAX_PENDING_PROVISIONING_OPERATIONS = 8;
// WW retains idempotency results for 24 hours. Stop automatic replay early so
// clock skew cannot turn an old, possibly successful request into a second key.
const WW_PROVISIONING_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1_000;
const WW_PROVISIONING_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

interface WwPendingProvisioning {
  issuer: string;
  userId: string;
  idempotencyKey: string;
  startedAt: string;
}

interface WwProviderRecoveryBlock {
  issuer: string;
  userId: string;
  blockedAt: string;
  reason: "api_key_invalid_after_repair";
}

interface WwProviderProductDefaults {
  issuer: string;
  userId: string;
  status: "pending" | "completed";
}

export interface WwProviderLocalState {
  version: 1;
  installationId: string;
  ownerIssuer?: string;
  ownerUserId?: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  recoveryBlock?: WwProviderRecoveryBlock;
  productDefaults?: WwProviderProductDefaults;
  pending: WwPendingProvisioning[];
}

export function requestWwProviderProductDefaults(
  state: BridgeState,
  input: { issuer: string; userId: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  if (
    current.productDefaults?.issuer === issuer &&
    current.productDefaults.userId === userId &&
    current.productDefaults.status === "completed"
  ) {
    return current;
  }
  const next: WwProviderLocalState = {
    ...current,
    productDefaults: { issuer, userId, status: "pending" },
  };
  writeWwProviderLocalState(state, next);
  return next;
}

export function hasPendingWwProviderProductDefaults(
  state: BridgeState,
  input: { issuer: string; userId: string },
): boolean {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const defaults = readWwProviderLocalState(state).productDefaults;
  return defaults?.issuer === issuer && defaults.userId === userId && defaults.status === "pending";
}

export function completeWwProviderProductDefaults(
  state: BridgeState,
  input: { issuer: string; userId: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  if (
    current.productDefaults?.issuer !== issuer ||
    current.productDefaults.userId !== userId ||
    current.productDefaults.status !== "pending"
  ) {
    return current;
  }
  const next: WwProviderLocalState = {
    ...current,
    productDefaults: { issuer, userId, status: "completed" },
  };
  writeWwProviderLocalState(state, next);
  return next;
}

export function canonicalWwIssuer(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("ww_base_url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ww_base_url_invalid");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function ensureWwProvisioningAttempt(
  state: BridgeState,
  input: { issuer: string; userId: string },
): { localState: WwProviderLocalState; idempotencyKey: string } {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  const existing = current.pending.find((pending) => pending.issuer === issuer && pending.userId === userId);
  if (existing) {
    if (!isReplayableWwProvisioningAttempt(existing)) {
      throw new Error("ww_api_key_provisioning_replay_expired");
    }
    return { localState: current, idempotencyKey: existing.idempotencyKey };
  }

  const idempotencyKey = `og-${current.installationId}-${randomUUID()}`;
  const pending: WwPendingProvisioning = {
    issuer,
    userId,
    idempotencyKey,
    startedAt: new Date().toISOString(),
  };
  const next: WwProviderLocalState = {
    ...current,
    pending: [
      ...current.pending.filter((candidate) => candidate.issuer !== issuer || candidate.userId !== userId),
      pending,
    ].slice(-MAX_PENDING_PROVISIONING_OPERATIONS),
  };
  writeWwProviderLocalState(state, next);
  return { localState: next, idempotencyKey };
}

export function hasPendingWwProvisioningAttempt(
  state: BridgeState,
  input: { issuer: string; userId: string },
): boolean {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  return readWwProviderLocalState(state).pending.some(
    (pending) => pending.issuer === issuer && pending.userId === userId,
  );
}

export function recordWwProviderOwnership(
  state: BridgeState,
  input: { issuer: string; userId: string; apiKeyId: string; apiKeyPrefix: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  const recoveryBlock = recoveryBlockForAccount(current, issuer, userId);
  const next: WwProviderLocalState = {
    version: WW_PROVIDER_LOCAL_STATE_VERSION,
    installationId: current.installationId,
    ownerIssuer: issuer,
    ownerUserId: userId,
    apiKeyId: requiredString(input.apiKeyId, "ww_api_key_identity_missing"),
    apiKeyPrefix: requiredString(input.apiKeyPrefix, "ww_api_key_identity_missing"),
    ...(recoveryBlock ? { recoveryBlock } : {}),
    ...(current.productDefaults ? { productDefaults: current.productDefaults } : {}),
    pending: current.pending.filter((pending) => pending.issuer !== issuer || pending.userId !== userId),
  };
  writeWwProviderLocalState(state, next);
  return next;
}

export function claimWwProviderAccount(
  state: BridgeState,
  input: { issuer: string; userId: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  const sameAccount = current.ownerIssuer === issuer && current.ownerUserId === userId;
  const recoveryBlock = recoveryBlockForAccount(current, issuer, userId);
  const next: WwProviderLocalState = {
    version: WW_PROVIDER_LOCAL_STATE_VERSION,
    installationId: current.installationId,
    ownerIssuer: issuer,
    ownerUserId: userId,
    ...(sameAccount && current.apiKeyId ? { apiKeyId: current.apiKeyId } : {}),
    ...(sameAccount && current.apiKeyPrefix ? { apiKeyPrefix: current.apiKeyPrefix } : {}),
    ...(recoveryBlock ? { recoveryBlock } : {}),
    ...(current.productDefaults ? { productDefaults: current.productDefaults } : {}),
    pending: current.pending,
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    writeWwProviderLocalState(state, next);
  }
  return next;
}

export function blockWwProviderRecovery(
  state: BridgeState,
  input: { issuer: string; userId: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  const next: WwProviderLocalState = {
    ...current,
    ownerIssuer: issuer,
    ownerUserId: userId,
    recoveryBlock: {
      issuer,
      userId,
      blockedAt: new Date().toISOString(),
      reason: "api_key_invalid_after_repair",
    },
  };
  writeWwProviderLocalState(state, next);
  return next;
}

export function clearWwProviderRecoveryBlock(
  state: BridgeState,
  input: { issuer: string; userId: string },
): WwProviderLocalState {
  const issuer = canonicalWwIssuer(input.issuer);
  const userId = requiredString(input.userId, "ww_user_id_missing");
  const current = readWwProviderLocalState(state);
  if (!recoveryBlockForAccount(current, issuer, userId)) return current;
  const { recoveryBlock: _recoveryBlock, ...withoutRecoveryBlock } = current;
  const next: WwProviderLocalState = withoutRecoveryBlock;
  writeWwProviderLocalState(state, next);
  return next;
}

export function isWwProviderRecoveryBlocked(state: BridgeState, input: { issuer: string; userId: string }): boolean {
  const current = readWwProviderLocalState(state);
  return Boolean(recoveryBlockForAccount(current, canonicalWwIssuer(input.issuer), input.userId.trim()));
}

export function wwProviderAccountMatches(state: BridgeState, input: { issuer: string; userId: string }): boolean {
  const current = readWwProviderLocalState(state);
  return current.ownerIssuer === canonicalWwIssuer(input.issuer) && current.ownerUserId === input.userId.trim();
}

export function readWwProviderLocalState(state: BridgeState): WwProviderLocalState {
  let source: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(wwProviderLocalStatePath(state), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ww_provider_local_state_invalid");
    }
    source = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return emptyWwProviderLocalState();
    }
    if (error instanceof Error && error.message === "ww_provider_local_state_invalid") throw error;
    throw new Error("ww_provider_local_state_invalid");
  }

  if (source.version !== WW_PROVIDER_LOCAL_STATE_VERSION) {
    throw new Error("ww_provider_local_state_version_unsupported");
  }
  const installationId = stringValue(source.installationId);
  if (!installationId || !isUuid(installationId)) {
    throw new Error("ww_provider_local_state_invalid");
  }

  const ownerIssuer = stringValue(source.ownerIssuer);
  const ownerUserId = stringValue(source.ownerUserId);
  const apiKeyId = stringValue(source.apiKeyId);
  const apiKeyPrefix = stringValue(source.apiKeyPrefix);
  const recoveryBlock = parseRecoveryBlock(source.recoveryBlock);
  // `newUserDefaults` was the 0.6.1 name. Reading it here is the only
  // compatibility boundary; subsequent writes use the product-owned name.
  const productDefaults = parseProductDefaults(source.productDefaults ?? source.newUserDefaults);
  const pending = parsePending(source.pending);
  return {
    version: WW_PROVIDER_LOCAL_STATE_VERSION,
    installationId,
    ...(ownerIssuer ? { ownerIssuer: canonicalWwIssuer(ownerIssuer) } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(apiKeyPrefix ? { apiKeyPrefix } : {}),
    ...(recoveryBlock ? { recoveryBlock } : {}),
    ...(productDefaults ? { productDefaults } : {}),
    pending,
  };
}

function emptyWwProviderLocalState(): WwProviderLocalState {
  return {
    version: WW_PROVIDER_LOCAL_STATE_VERSION,
    installationId: randomUUID(),
    pending: [],
  };
}

function parsePending(input: unknown): WwPendingProvisioning[] {
  if (input === undefined) return [];
  const candidates = Array.isArray(input) ? input : [input];
  const output: WwPendingProvisioning[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("ww_provider_local_state_invalid");
    }
    const source = candidate as Record<string, unknown>;
    const issuer = stringValue(source.issuer);
    // Pre-issuer pending records cannot be safely reused across WW deployments.
    if (!issuer) continue;
    const userId = stringValue(source.userId);
    const idempotencyKey = stringValue(source.idempotencyKey);
    const startedAt = stringValue(source.startedAt);
    if (
      !userId ||
      !idempotencyKey ||
      idempotencyKey.length > 128 ||
      !/^[\x21-\x7e]+$/.test(idempotencyKey) ||
      !startedAt ||
      !Number.isFinite(Date.parse(startedAt))
    ) {
      throw new Error("ww_provider_local_state_invalid");
    }
    output.push({
      issuer: canonicalWwIssuer(issuer),
      userId,
      idempotencyKey,
      startedAt,
    });
  }
  return output.slice(-MAX_PENDING_PROVISIONING_OPERATIONS);
}

function parseRecoveryBlock(input: unknown): WwProviderRecoveryBlock | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("ww_provider_local_state_invalid");
  }
  const source = input as Record<string, unknown>;
  const issuer = stringValue(source.issuer);
  const userId = stringValue(source.userId);
  const blockedAt = stringValue(source.blockedAt);
  if (
    !issuer ||
    !userId ||
    !blockedAt ||
    !Number.isFinite(Date.parse(blockedAt)) ||
    source.reason !== "api_key_invalid_after_repair"
  ) {
    throw new Error("ww_provider_local_state_invalid");
  }
  return {
    issuer: canonicalWwIssuer(issuer),
    userId,
    blockedAt,
    reason: "api_key_invalid_after_repair",
  };
}

function parseProductDefaults(input: unknown): WwProviderProductDefaults | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("ww_provider_local_state_invalid");
  }
  const source = input as Record<string, unknown>;
  const issuer = stringValue(source.issuer);
  const userId = stringValue(source.userId);
  if (!issuer || !userId || (source.status !== "pending" && source.status !== "completed")) {
    throw new Error("ww_provider_local_state_invalid");
  }
  return {
    issuer: canonicalWwIssuer(issuer),
    userId,
    status: source.status,
  };
}

function recoveryBlockForAccount(
  state: WwProviderLocalState,
  issuer: string,
  userId: string,
): WwProviderRecoveryBlock | undefined {
  const block = state.recoveryBlock;
  return block?.issuer === issuer && block.userId === userId ? block : undefined;
}

function isReplayableWwProvisioningAttempt(pending: WwPendingProvisioning): boolean {
  const ageMs = Date.now() - Date.parse(pending.startedAt);
  return ageMs >= -WW_PROVISIONING_MAX_FUTURE_SKEW_MS && ageMs < WW_PROVISIONING_REPLAY_WINDOW_MS;
}

function writeWwProviderLocalState(state: BridgeState, value: WwProviderLocalState): void {
  writePrivateFileAtomically(wwProviderLocalStatePath(state), `${JSON.stringify(value, null, 2)}\n`);
}

function wwProviderLocalStatePath(state: BridgeState): string {
  return bridgeDataPath(state, WW_PROVIDER_LOCAL_STATE_FILE);
}

function requiredString(value: string, errorCode: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// forwarding-boundary: names the persisted installation-id validation contract.
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
