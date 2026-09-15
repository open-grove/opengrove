import assert from "node:assert/strict";
import { planRealAgents, summarizeRealAgentCoverage, readRealAgentRequirements } from "./real-agent-ci.mjs";
const required = [
  {
    kernel: "pi",
    runtime_mode: "sdk",
    kernel_version: "0.85.1",
    capabilities: ["turn.lifecycle", "session.lifecycle"],
  },
];
const missing = planRealAgents(required, {});
assert.equal(missing.matrix.include.length, 0);
assert.deepEqual(missing.unconfigured, ["pi"]);
assert.equal(summarizeRealAgentCoverage(required, []).ready, false);
const image = `ghcr.io/open-grove/pi@sha256:${"a".repeat(64)}`;
const plan = planRealAgents(required, { pi: { image } });
assert.equal(plan.matrix.include[0].capabilities, "turn.lifecycle,session.lifecycle");
assert.throws(() => planRealAgents(required, { pi: { image: "ghcr.io/open-grove/pi:latest" } }), /digest/);
const pass = {
  kernel: "pi",
  runtimeMode: "sdk",
  kernelVersion: "0.85.1",
  capabilities: ["turn.lifecycle", "session.lifecycle"],
  passed: true,
};
assert.equal(summarizeRealAgentCoverage(required, [pass]).ready, true);
assert.equal(summarizeRealAgentCoverage(required, [{ ...pass, capabilities: ["turn.lifecycle"] }]).ready, false);
assert.equal(summarizeRealAgentCoverage(required, [{ ...pass, passed: false }]).ready, false);
assert.equal(summarizeRealAgentCoverage(required, [{ ...pass, runtimeMode: "cli" }]).ready, false);
assert.throws(() => summarizeRealAgentCoverage(required, [pass, pass]), /duplicate/);
const inventory = readRealAgentRequirements();
assert.equal(inventory.length, 7);
assert.equal(
  inventory.reduce((n, item) => n + item.capabilities.length, 0),
  85,
);
console.log("Real Agent CI coverage policy ok");
