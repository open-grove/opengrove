import assert from "node:assert/strict";
import test from "node:test";
import { internalBridgeBaseUrl } from "../server/internal-bridge-url.js";
import {
  createRoomLedgerCapability,
  readRoomLedgerCapability,
  renewRoomLedgerCapability,
  revokeRoomLedgerCapability,
} from "../server/room-ledger-capabilities.js";
import { createRoomLedgerCapabilityForRoomRun } from "../server/room-runs/ledger.js";

test("room ledger capabilities use the internal Bridge instead of the public gateway", () => {
  const capability = createRoomLedgerCapabilityForRoomRun({
    runId: "run-internal-ledger",
    roomId: "room-internal-ledger",
    internalBridgeBaseUrl: "http://127.0.0.1:37371/",
  });
  assert.equal(capability?.readUrl, "http://127.0.0.1:37371/api/room-ledger/read");
  revokeRoomLedgerCapability(capability?.token);
});

test("internal Bridge URLs turn wildcard listeners into loopback targets", () => {
  assert.equal(internalBridgeBaseUrl("0.0.0.0", 37371), "http://127.0.0.1:37371");
  assert.equal(internalBridgeBaseUrl("::", 37371), "http://[::1]:37371");
});

test("room ledger reads do not slide the lease, while Host renewal respects an absolute lifetime", () => {
  const created = createRoomLedgerCapability({
    runId: "run-renew-ledger",
    sourceRoomId: "room-renew-ledger",
    readUrl: "http://127.0.0.1:37371/api/room-ledger/read",
    ttlMs: 1_000,
    maxLifetimeMs: 2_500,
    now: 10_000,
  });
  const initialExpiry = created.expiresAt;

  assert.equal(readRoomLedgerCapability(created.token, 10_500)?.expiresAt, initialExpiry);
  assert.equal(renewRoomLedgerCapability(created.token, 10_500)?.expiresAt, new Date(11_500).toISOString());
  assert.equal(renewRoomLedgerCapability(created.token, 11_200)?.expiresAt, new Date(12_200).toISOString());
  assert.equal(renewRoomLedgerCapability(created.token, 12_000)?.expiresAt, new Date(12_500).toISOString());
  assert.equal(renewRoomLedgerCapability(created.token, 12_500), undefined);
  assert.equal(readRoomLedgerCapability(created.token, 12_500), undefined);
});
