import assert from "node:assert/strict";
import { runCiProcess } from "./ci-process.mjs";

const success = await runCiProcess(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
assert.equal(success.status, 0);
assert.equal(success.timedOut, false);
const failed = await runCiProcess(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
assert.equal(failed.status, 7);
const timeout = await runCiProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  timeoutMs: 100,
  stdio: "ignore",
});
assert.equal(timeout.timedOut, true);
assert.notEqual(timeout.status, 0);
assert.ok(timeout.durationMs < 10_000);
const absent = await runCiProcess("opengrove-test-nonexistent-command", [], { stdio: "ignore" });
assert.equal(absent.error, "ENOENT");
console.log("CI process success, failure, timeout and spawn diagnostics ok");
