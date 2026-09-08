import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessStartedAtAsync } from "../dist/storage/legacy-state-lock.compat.js";

// Keep the real platform probe separate from deterministic legacy-recovery
// tests. On Windows this exercises PowerShell startup, UTC output and parsing.
const beforeSpawn = Date.now();
const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "pipe", "ignore"],
});
const exited = once(child, "exit");
try {
  await Promise.race([
    once(child.stdout, "data", { signal: AbortSignal.timeout(30_000) }),
    exited.then(() => {
      throw new Error("probe child exited before ready");
    }),
  ]);
  const afterSpawn = Date.now();
  const queriedStart = await readProcessStartedAtAsync(child.pid);
  assert.equal(typeof queriedStart, "number", "the platform process-start query must succeed within its own budget");
  assert.ok(
    queriedStart >= beforeSpawn - 1_000 && queriedStart <= afterSpawn + 1_000,
    "the query must fall within the child's observed creation interval (allowing ps second precision)",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}
console.log(`process start inspection (${process.platform}): ok`);
