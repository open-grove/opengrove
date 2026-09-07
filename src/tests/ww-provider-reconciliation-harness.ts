import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeState } from "../server/bridge-state.js";
import { migrateWwProvisioning } from "../server/migrations/ww-provisioning-v1.js";
import { beginWwProviderSession, provisionWwProviderAfterLogin } from "../server/ww-provider-provisioning.js";
import { recordWwProviderOwnership, readWwProviderLocalState } from "../server/ww-provider-local-state.js";
import { failedWwReconciliation } from "../server/ww-provider-reconciliation.js";
import type { WwProviderCredentialsClient } from "../server/ww/types.js";

const directory = mkdtempSync(join(tmpdir(), "opengrove-ww-reconciliation-"));
const state = createBridgeState({ statePath: join(directory, "state.json") });
const key = {
  id: "key-owned",
  name: "OpenGrove WW Provider",
  apiKey: "ww_sk_owned_secret",
  keyPrefix: "ww_sk_owned",
  status: "active",
  createdAt: "2026-07-05T00:00:00Z",
};
let unavailable = false;
const client: WwProviderCredentialsClient = {
  async listApiKeys() {
    if (unavailable) throw Object.assign(new Error("unavailable"), { status: 503 });
    return [key];
  },
  async createApiKey() {
    return key;
  },
};
const input = { state, client, baseUrl: "https://ww.example.test", accessToken: "access", userId: "user-owned" };
try {
  assert.deepEqual(migrateWwProvisioning({ provisioningBlocked: true }), {
    status: "pending",
    reason: "verification_required",
    attempt: 0,
  });
  assert.equal(failedWwReconciliation(new SyntaxError("invalid JSON")).status, "blocked");
  assert.equal(failedWwReconciliation(Object.assign(new Error("expired"), { status: 401 })).status, "needs-login");
  assert.equal(failedWwReconciliation(Object.assign(new Error("denied"), { status: 403 })).status, "blocked");
  const rateLimited = failedWwReconciliation(
    Object.assign(new Error("limited"), { status: 429, retryAfter: 90 }),
    undefined,
    0,
  );
  assert.equal(rateLimited.retryAt, "1970-01-01T00:01:30.000Z");

  beginWwProviderSession(input);
  assert.equal((await provisionWwProviderAfterLogin(input)).status, "configured");
  const app = state.app;
  assert.equal((await provisionWwProviderAfterLogin(input)).status, "already-configured");
  assert.equal(state.app === app, true, "verification metadata must not rebuild the running App");
  unavailable = true;
  assert.equal((await provisionWwProviderAfterLogin(input)).status, "failed");
  assert.equal(state.settings.customProviders.find((provider) => provider.id === "ww")?.provisioningBlocked, undefined);
  assert.equal(state.app === app, true, "an outage with a verified Key must retain the running App");

  beginWwProviderSession(input);
  const provider = state.settings.customProviders.find((candidate) => candidate.id === "ww");
  assert.ok(provider);
  provider.apiKey = "ww_sk_owned_changed_secret";
  await provisionWwProviderAfterLogin(input);
  assert.equal(
    state.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
    true,
    "a changed Key cannot inherit the old fingerprint during an outage",
  );

  beginWwProviderSession(input);
  recordWwProviderOwnership(state, {
    issuer: input.baseUrl,
    userId: input.userId,
    apiKeyId: key.id,
    apiKeyPrefix: key.keyPrefix,
    apiKey: key.apiKey,
    expiresAt: "2020-01-01T00:00:00Z",
  });
  const expiredProvider = state.settings.customProviders.find((candidate) => candidate.id === "ww");
  assert.ok(expiredProvider);
  expiredProvider.apiKey = key.apiKey;
  expiredProvider.provisioningBlocked = undefined;
  await provisionWwProviderAfterLogin(input);
  assert.equal(
    state.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
    true,
    "an expired verification cannot keep the Key usable during an outage",
  );
  const ownership = {
    issuer: input.baseUrl,
    userId: input.userId,
    apiKeyId: key.id,
    apiKeyPrefix: key.keyPrefix,
    apiKey: key.apiKey,
  };
  for (const [expiresAt, expected] of [
    ["2027-01-01T00:00:00Z", "2027-01-01T00:00:00.000Z"],
    ["2027-01-01T00:00:00+00:00", "2027-01-01T00:00:00.000Z"],
    ["2027-01-01T08:00:00+08:00", "2027-01-01T00:00:00.000Z"],
  ]) {
    recordWwProviderOwnership(state, { ...ownership, expiresAt });
    assert.equal(
      readWwProviderLocalState(state).verification?.expiresAt,
      expected,
      "service expiry timestamps must be normalized before persistence and survive readback",
    );
  }
  const localStatePath = join(directory, "ww-provider.json");
  const saved = JSON.parse(readFileSync(localStatePath, "utf8"));
  saved.verification.expiresAt = "2020-01-01T08:00:00+08:00";
  writeFileSync(localStatePath, JSON.stringify(saved));
  assert.equal(
    readWwProviderLocalState(state).verification?.expiresAt,
    "2020-01-01T00:00:00.000Z",
    "already persisted offset timestamps must recover with their expiry intact",
  );
  for (const invalidExpiry of ["not-a-date", "2027-01-01T00:00:00", "2027-01-01 00:00:00"]) {
    saved.verification.expiresAt = invalidExpiry;
    writeFileSync(localStatePath, JSON.stringify(saved));
    assert.equal(
      readWwProviderLocalState(state).verification,
      undefined,
      "unreadable or ambiguous expiry must invalidate verification without breaking account state",
    );
    assert.equal(readWwProviderLocalState(state).ownerUserId, input.userId);
    recordWwProviderOwnership(state, { ...ownership, expiresAt: invalidExpiry });
    assert.equal(
      readWwProviderLocalState(state).verification,
      undefined,
      "an invalid upstream expiry must not become an immortal verified credential",
    );
  }
  recordWwProviderOwnership(state, ownership);
  assert.ok(
    readWwProviderLocalState(state).verification,
    "an explicitly non-expiring service Key still supports verification",
  );
  console.log("ww-provider-reconciliation-harness ok");
} finally {
  await state.store.close?.();
  rmSync(directory, { recursive: true, force: true });
}
