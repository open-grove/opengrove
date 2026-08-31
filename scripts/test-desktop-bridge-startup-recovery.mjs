import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const testRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-bridge-startup-"));
const bundlePath = join(testRoot, "bridge-startup-recovery.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-startup-recovery.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
  });
  const { DesktopBridgeStartupRetrySignal, startDesktopBridgeWithRecovery } = await import(
    pathToFileURL(bundlePath).href
  );

  const attempts = [];
  const failures = [];
  const waits = [];
  const sequence = [];
  const runtime = await startDesktopBridgeWithRecovery({
    beforeFirstAttempt: () => sequence.push("startup-shell-opened"),
    start: async () => {
      sequence.push(`bridge-attempt-${attempts.length + 1}`);
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) throw new Error(`bridge failed ${attempts.length}`);
      return { apiBase: "http://127.0.0.1:43123/api" };
    },
    isStopping: () => false,
    isBlocker: () => false,
    onFailure: (failure) => failures.push(failure),
    onBlocked: () => assert.fail("recoverable failures must not be classified as permanent blockers"),
    waitForRetry: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(runtime.apiBase, "http://127.0.0.1:43123/api");
  assert.equal(sequence[0], "startup-shell-opened");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.deepEqual(
    failures.map((failure) => ({ attempt: failure.attempt, delayMs: failure.delayMs })),
    [
      { attempt: 1, delayMs: 1_000 },
      { attempt: 2, delayMs: 2_000 },
    ],
  );

  const blocker = Object.assign(new Error("another OpenGrove owns the state"), { code: "LOCAL_STATE_LOCKED" });
  const blockedFailures = [];
  const blockedWaits = [];
  await assert.rejects(
    () =>
      startDesktopBridgeWithRecovery({
        beforeFirstAttempt: () => undefined,
        start: async () => {
          throw blocker;
        },
        isStopping: () => false,
        isBlocker: (error) => error === blocker,
        onFailure: () => assert.fail("permanent blockers must not enter the automatic retry path"),
        onBlocked: (failure) => blockedFailures.push(failure),
        waitForRetry: async (delayMs) => blockedWaits.push(delayMs),
      }),
    (error) => error === blocker,
  );
  assert.equal(blockedFailures.length, 1);
  assert.deepEqual(blockedWaits, []);

  const retrySignal = new DesktopBridgeStartupRetrySignal();
  let released = false;
  const pendingRetry = retrySignal.wait(60_000).then(() => {
    released = true;
  });
  retrySignal.retryNow();
  await pendingRetry;
  assert.equal(released, true);

  process.stdout.write("desktop bridge startup recovery: ok\n");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
