import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeState } from "../server/bridge-state.js";
import { migrateWwProvisioning } from "../server/migrations/ww-provisioning-v1.js";
import { beginWwProviderSession, provisionWwProviderAfterLogin } from "../server/ww-provider-provisioning.js";
import { recordWwProviderOwnership, readWwProviderLocalState } from "../server/ww-provider-local-state.js";
import { failedWwReconciliation } from "../server/ww-provider-reconciliation.js";
import { createWwHostedServices } from "../server/ww/index.js";
import type { WwProviderCredentialsClient } from "../server/ww/types.js";
import type { BridgeProviderProfile } from "../server/bridge-types.js";

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
  assert.equal(failedWwReconciliation(new SyntaxError("invalid JSON")).status, "retrying");
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

  const previousFetch = globalThis.fetch;
  try {
    for (const body of ["<html>Proxy unavailable</html>", JSON.stringify({ data: { unexpected: true } })]) {
      beginWwProviderSession(input);
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        return new Response(body, { status: 200 });
      };
      const malformedInput = {
        ...input,
        client: createWwHostedServices(input.baseUrl, { requestTimeoutMs: 250 }).providerCredentials,
      };
      const result = await provisionWwProviderAfterLogin(malformedInput);
      assert.equal(result.status, "failed");
      if (result.status !== "failed") throw new Error("expected verification failure");
      assert.equal(result.retryable, true, "malformed management responses must schedule recovery");
      assert.ok(result.retryAt);
      assert.equal(
        state.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
        undefined,
      );
      assert.equal(state.app === app, true, "a malformed management response must retain the verified running route");
      const beforeCooldown = requests;
      await provisionWwProviderAfterLogin(malformedInput);
      assert.equal(requests, beforeCooldown, "malformed-response recovery must honor the persisted cooldown");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }

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
  await testLegacyUpgrade();
  console.log("ww-provider-reconciliation-harness ok");
} finally {
  await state.store.close?.();
  rmSync(directory, { recursive: true, force: true });
}

async function testLegacyUpgrade(): Promise<void> {
  const legacyDirectory = mkdtempSync(join(directory, "upgrade-"));
  const legacyState = createBridgeState({ statePath: join(legacyDirectory, "state.json") });
  const legacyInput = { ...input, state: legacyState };
  try {
    unavailable = false;
    await provisionWwProviderAfterLogin(legacyInput);
    const profile = legacyState.settings.customProviders.find((candidate) => candidate.id === "ww");
    assert.ok(profile);
    delete profile.provisioning;
    const path = join(legacyDirectory, "ww-provider.json");
    const legacySource = {
      version: 1,
      installationId: "12345678-1234-4123-8123-123456789abc",
      ownerIssuer: input.baseUrl,
      ownerUserId: input.userId,
      apiKeyId: key.id,
      apiKeyPrefix: key.keyPrefix,
      pending: [],
    };
    writeFileSync(path, JSON.stringify(legacySource));
    const runningApp = legacyState.app;
    beginWwProviderSession(legacyInput);
    const outageInput = {
      ...legacyInput,
      client: {
        ...client,
        async listApiKeys() {
          assert.equal(
            legacyState.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
            undefined,
            "upgrades must retain the existing route before the management request completes",
          );
          throw Object.assign(new Error("unavailable"), { status: 503 });
        },
      },
    };
    const result = await provisionWwProviderAfterLogin(outageInput);
    assert.equal(result.status, "failed");
    assert.equal(
      legacyState.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
      undefined,
      "a management outage during upgrade must not quarantine the old working Key",
    );
    assert.equal(legacyState.app, runningApp, "migration and retries must not rebuild the running App");
    assert.equal(
      readWwProviderLocalState(legacyState).verification,
      undefined,
      "importing local ownership is not a fresh remote verification",
    );
    assert.equal(readWwProviderLocalState(legacyState).reconciliation?.lastVerifiedAt, undefined);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2, "migration must persist exactly once");
    beginWwProviderSession(legacyInput);
    await provisionWwProviderAfterLogin(legacyInput);
    assert.ok(readWwProviderLocalState(legacyState).verification, "successful inspection replaces imported ownership");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).importedCredential, undefined);

    const readyProfile = legacyState.settings.customProviders.find((candidate) => candidate.id === "ww");
    assert.ok(readyProfile);
    const baselineProfile = { ...readyProfile, provisioning: undefined };
    const negativeCases: {
      name: string;
      source?: Record<string, unknown>;
      profile?: Partial<BridgeProviderProfile>;
    }[] = [
      { name: "missing ownership identity", source: { apiKeyId: undefined } },
      { name: "different account", source: { ownerUserId: "another-user" } },
      { name: "different issuer", source: { ownerIssuer: "https://another.example.test" } },
      { name: "different Key prefix", source: { apiKeyPrefix: "ww_sk_other" } },
      { name: "previous quarantine", profile: { provisioningBlocked: true } },
      {
        name: "changed credential marker",
        profile: { provisioning: { status: "pending", reason: "credential_changed", attempt: 0 } },
      },
      { name: "rejected credential", source: { rejectedKeyFingerprint: "a".repeat(64) } },
      { name: "invalid modern verification", source: { verification: { expiresAt: "invalid" } } },
      {
        name: "recovery block",
        source: {
          recoveryBlock: {
            issuer: input.baseUrl,
            userId: input.userId,
            blockedAt: "2026-07-05T00:00:00Z",
            reason: "api_key_invalid_after_repair",
          },
        },
      },
      {
        name: "pending creation",
        source: {
          pending: [
            {
              issuer: input.baseUrl,
              userId: input.userId,
              startedAt: new Date().toISOString(),
              idempotencyKey: "pending-test",
            },
          ],
        },
      },
      { name: "already migrated without evidence", source: { version: 2 } },
    ];
    for (const scenario of negativeCases) {
      legacyState.settings.customProviders = [{ ...baselineProfile, ...scenario.profile }];
      writeFileSync(path, JSON.stringify({ ...legacySource, ...scenario.source }));
      beginWwProviderSession(legacyInput);
      unavailable = true;
      await provisionWwProviderAfterLogin(legacyInput);
      assert.equal(
        legacyState.settings.customProviders.find((candidate) => candidate.id === "ww")?.provisioningBlocked,
        true,
        scenario.name + " must not acquire upgrade continuity",
      );
      assert.equal(readWwProviderLocalState(legacyState).importedCredential, undefined, scenario.name);
    }
    legacyState.settings.customProviders = [{ ...baselineProfile }];
    writeFileSync(path, JSON.stringify(legacySource));
    assert.ok(readWwProviderLocalState(legacyState).importedCredential);
    legacyState.settings.customProviders[0]!.apiKey = "ww_sk_owned_changed_secret";
    beginWwProviderSession(legacyInput);
    await provisionWwProviderAfterLogin(legacyInput);
    assert.equal(
      legacyState.settings.customProviders[0]?.provisioningBlocked,
      true,
      "a replacement sharing the old prefix cannot inherit the once-imported fingerprint",
    );
    assert.equal(
      readWwProviderLocalState(legacyState).importedCredential?.fingerprint,
      "0c493b73c05e35aca25f7de03eb20473de1f3c98e5609c77520b9f29dc918bf5",
      "repeated loads must retain the original import instead of reseeding from the edited Key",
    );
  } finally {
    await legacyState.store.close?.();
  }
}
