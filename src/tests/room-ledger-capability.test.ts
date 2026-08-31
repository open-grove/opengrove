import assert from "node:assert/strict";
import test from "node:test";
import { internalBridgeBaseUrl } from "../server/internal-bridge-url.js";
import { revokeRoomLedgerCapability } from "../server/room-ledger-capabilities.js";
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
