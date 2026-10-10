import { buildKnownKernelCapabilityReport } from "../kernel/capabilities/report-for-kernel.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHermesRuntimeEnv } from "../runtime/hermes/home-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { bridgeKernelSupportsHostTools } from "../kernel/host-tools.js";
import { createHermesKernelAdapter } from "../kernel/adapters/hermes.js";
import { createOpenClawGatewayKernelAdapter } from "../kernel/adapters/openclaw.js";

test("Hermes and OpenClaw product routing exposes the shared product-tool integration", () => {
  for (const id of ["hermes", "openclaw"]) {
    assert.equal(bridgeKernelSupportsHostTools(id), true, id);
    const report = buildKnownKernelCapabilityReport(id);
    assert.equal(report.capabilities.find((entry) => entry.capability === "tools.hostTool")?.exposed, "yes", id);
  }
  const hermes = createHermesKernelAdapter({ command: "/bin/false" });
  const openclaw = createOpenClawGatewayKernelAdapter({ url: "ws://127.0.0.1:1" });
  assert.equal(hermes.capabilities.hostTools, true);
  assert.equal(openclaw.capabilities.hostTools, true);
  assert.equal(openclaw.capabilities.toolCalls, true);
});

test("persistent Hermes consumer homes isolate the native source profile by default", () => {
  const source = mkdtempSync(join(tmpdir(), "hermes-profile-contract-"));
  writeFileSync(join(source, "config.yaml"), "approvals:\n  mode: manual\n");
  const owned = join(source, "product-profile");
  const prepared = prepareHermesRuntimeEnv({
    runtimeEnv: { HERMES_HOME: source },
    providerConfig: undefined,
    nativeSkillDir: undefined,
    isolatedHome: undefined,
    persistentHome: owned,
  });
  assert.equal(prepared.env.HERMES_HOME, owned);
  assert.equal(prepared.isolatedHome, owned);
});
