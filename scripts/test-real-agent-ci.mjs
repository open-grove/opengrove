import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  planRealAgents,
  summarizeRealAgentCoverage,
  readRealAgentRequirements,
  selectRealAgentCases,
} from "./real-agent-ci.mjs";
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

const directory = mkdtempSync(join(tmpdir(), "opengrove-evidence-policy-"));
try {
  const file = join(directory, "probe.json");
  const timestamp = new Date().toISOString();
  const probe = {
    kernel: "pi",
    capability: "turn.lifecycle",
    status: "passed",
    checkedAt: timestamp.slice(0, 10),
    hostVersion: "0.7.0",
    kernelVersion: "0.85.1",
    runtimeMode: "sdk",
  };
  const invoke = (value) => {
    writeFileSync(file, JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [
        "scripts/check-real-runtime-evidence.mjs",
        "--file",
        file,
        "--kernel",
        "pi",
        "--require",
        "turn.lifecycle",
        "--fail-on-failed",
        "--not-before",
        timestamp,
        "--host-version",
        "0.7.0",
        "--kernel-version",
        "0.85.1",
        "--runtime-mode",
        "sdk",
      ],
      { encoding: "utf8" },
    );
  };
  const evidence = { schemaVersion: 1, generatedAt: timestamp, probes: [probe] };
  assert.equal(invoke(evidence).status, 0);
  for (const change of [
    { kernelVersion: "0.84.0" },
    { hostVersion: "0.6.0" },
    { runtimeMode: "cli" },
    { status: "skipped", reason: "missing_credentials" },
  ])
    assert.equal(invoke({ ...evidence, probes: [{ ...probe, ...change }] }).status, 1);
  assert.equal(invoke({ ...evidence, generatedAt: "2020-01-01T00:00:00Z" }).status, 1);
  assert.equal(invoke({ ...evidence, authorization: "test-only-value" }).status, 1);
  assert.equal(invoke({ ...evidence, probes: [probe, probe] }).status, 1);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const receiptNow = new Date("2026-09-15T12:00:00Z");
const context = { headSha: "a".repeat(40), runId: "123", runAttempt: "2", now: receiptNow };
const oldCase = {
  ...pass,
  headSha: context.headSha,
  runId: "123",
  runAttempt: "1",
  generatedAt: "2026-09-15T11:00:00Z",
};
const newCase = { ...oldCase, runAttempt: "2", generatedAt: "2026-09-15T12:00:00Z" };
assert.deepEqual(selectRealAgentCases([oldCase, newCase], context), [newCase]);
assert.deepEqual(
  selectRealAgentCases([oldCase], context),
  [oldCase],
  "failed-job reruns may reuse fresh passed cases from the same run and code",
);
assert.throws(() => selectRealAgentCases([{ ...oldCase, headSha: "b".repeat(40) }], context), /another run/);
assert.throws(() => selectRealAgentCases([{ ...oldCase, generatedAt: "2026-09-13T12:00:00Z" }], context), /stale/);
assert.throws(() => selectRealAgentCases([newCase, newCase], context), /duplicate/);

const caseRoot = mkdtempSync(join(tmpdir(), "opengrove-ci-case-"));
try {
  mkdirSync(join(caseRoot, "scripts"));
  mkdirSync(join(caseRoot, "dist/tests"), { recursive: true });
  writeFileSync(join(caseRoot, "package.json"), JSON.stringify({ type: "module", version: "0.7.0" }));
  copyFileSync(
    resolve(import.meta.dirname, "check-real-runtime-evidence.mjs"),
    join(caseRoot, "scripts/check-real-runtime-evidence.mjs"),
  );
  const probeProgram = (status) =>
    `import { writeFileSync } from "node:fs"; const time = new Date().toISOString(); writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify({schemaVersion:1,generatedAt:time,probes:[{kernel:"pi",capability:"turn.lifecycle",status:${JSON.stringify(status)},checkedAt:time.slice(0,10),hostVersion:"0.7.0",kernelVersion:"0.85.1",runtimeMode:"sdk"}]}));`;
  const stub = join(caseRoot, "dist/tests/kernel-capability-real-runtime-probe-runner.js");
  writeFileSync(stub, probeProgram("passed"));
  const env = {
    ...process.env,
    RUNNER_TEMP: caseRoot,
    CI_KERNEL: "pi",
    CI_RUNTIME_MODE: "sdk",
    CI_KERNEL_VERSION: "0.85.1",
    CI_CAPABILITIES: "turn.lifecycle",
    CI_AGENT_IMAGE: image,
    CI_RUNTIME_ENVIRONMENTS: "{}",
    GITHUB_SHA: context.headSha,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const invokeCase = () =>
    spawnSync(process.execPath, [resolve(import.meta.dirname, "run-real-agent-ci-case.mjs")], {
      cwd: caseRoot,
      env,
      encoding: "utf8",
    });
  const success = invokeCase();
  assert.equal(success.status, 0, success.stderr);
  const receiptPath = join(caseRoot, "real-agent-case/sanitized/case-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(selectRealAgentCases([receipt], { ...context, now: new Date() })[0].capabilities[0], "turn.lifecycle");
  writeFileSync(stub, probeProgram("failed"));
  assert.notEqual(invokeCase().status, 0);
  assert.equal(existsSync(receiptPath), false, "a failed probe must never publish a previous successful case receipt");
} finally {
  rmSync(caseRoot, { recursive: true, force: true });
}
