import assert from "node:assert/strict";
import { test } from "node:test";
import { probeRealRuntimeVersion } from "./kernel-real-runtime-version.js";

test("CI reads the actual cold engine version after the UI discovery deadline", async () => {
  assert.equal(
    await probeRealRuntimeVersion(process.execPath, [
      "-e",
      'setTimeout(() => console.log("Engine 1.2.3\\nInstall metadata"), 2100)',
    ]),
    "Engine 1.2.3",
  );
});

test("failed or empty version probes never fabricate an identity", async () => {
  await assert.rejects(
    probeRealRuntimeVersion(process.execPath, ["-e", 'console.log("not a successful probe"); process.exit(1)']),
  );
  await assert.rejects(probeRealRuntimeVersion(process.execPath, ["-e", ""]), /no engine identity/);
});
