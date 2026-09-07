import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-provider-recovery-"));
const previousWindow = globalThis.window;
// QueryObserver uses browser scheduling only when a window exists at import time.
globalThis.window = {};
const { QueryClient, QueryObserver } = await import("@tanstack/query-core");
const client = new QueryClient();
let unsubscribe;
try {
  const bundle = join(temporary, "recovery.mjs");
  await build({
    entryPoints: [join(root, "web/src/runtime/auth-session-recovery.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { authSessionRecoveryDelay, authSessionRecoveryOptions } = await import(pathToFileURL(bundle).href);
  const now = Date.parse("2026-09-05T00:00:00Z");
  const pending = {
    status: "authenticated",
    providerProvisioning: { status: "failed", retryable: true, retryAt: "2026-09-05T00:00:15Z" },
  };
  assert.equal(authSessionRecoveryDelay(pending, now), 15000);
  assert.equal(authSessionRecoveryDelay({ status: "unauthenticated" }, now, true), false);
  assert.equal(authSessionRecoveryDelay({ status: "temporarily_unavailable" }, now), 30000);
  assert.equal(
    authSessionRecoveryDelay(
      { status: "authenticated", providerProvisioning: { status: "failed", retryable: false } },
      now,
    ),
    false,
  );
  assert.equal(
    authSessionRecoveryDelay(
      { status: "authenticated", providerProvisioning: { status: "skipped", reason: "provider_disabled" } },
      now,
    ),
    false,
  );

  let requests = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["auth-session"],
    ...authSessionRecoveryOptions,
    queryFn: async () => {
      requests += 1;
      return requests === 1
        ? { ...pending, providerProvisioning: { ...pending.providerProvisioning, retryAt: new Date().toISOString() } }
        : { status: "authenticated", providerProvisioning: { status: "configured" } };
    },
  });
  const recovered = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("session recovery did not run")), 5000);
    unsubscribe = observer.subscribe((result) => {
      if (result.data?.providerProvisioning.status === "configured") {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
  });
  await recovered;
  await delay(1100);
  assert.equal(requests, 2, "HTTP-successful provisioning failures must retry automatically and stop after recovery");
  console.log("✓ WW recovery retries successful session envelopes and stops after recovery, logout, or user action");
} finally {
  unsubscribe?.();
  client.clear();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  await rm(temporary, { recursive: true, force: true });
}
