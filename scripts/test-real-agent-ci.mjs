import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCodexAccountRuntime } from "./codex-ci.mjs";
import {
  planRealAgents,
  summarizeRealAgentCoverage,
  readRealAgentRequirements,
  selectRealAgentCases,
} from "./real-agent-ci.mjs";
const required = [
  {
    case: "pi",
    provider: { kind: "deepseek", protocol: "openai-completions", model: "deepseek-flash", configRevision: "1" },
    kernel: "pi",
    runtime_mode: "sdk",
    kernel_version: "0.85.1",
    capabilities: ["turn.lifecycle", "session.lifecycle"],
  },
];
const planContext = { inputDigest: "a".repeat(64) };
const missing = planRealAgents(required, {}, planContext);
assert.equal(missing.matrix.include.length, 0);
assert.deepEqual(missing.unconfigured, ["pi"]);
assert.equal(summarizeRealAgentCoverage(missing, []).ready, false);
const image = `ghcr.io/open-grove/pi@sha256:${"a".repeat(64)}`;
const plan = planRealAgents(required, { pi: { image } }, planContext);
assert.equal(plan.matrix.include[0].capabilities, "turn.lifecycle,session.lifecycle");
assert.throws(() => planRealAgents(required, { pi: { image: "ghcr.io/open-grove/pi:latest" } }, planContext), /digest/);
const pass = {
  schemaVersion: 2,
  case: "pi",
  image,
  provider: plan.matrix.include[0].provider,
  fingerprint: plan.matrix.include[0].fingerprint,
  kernel: "pi",
  runtimeMode: "sdk",
  kernelVersion: "0.85.1",
  capabilities: ["turn.lifecycle", "session.lifecycle"],
  passed: true,
};
assert.equal(summarizeRealAgentCoverage(plan, [pass]).ready, true);
assert.equal(summarizeRealAgentCoverage(plan, [{ ...pass, capabilities: ["turn.lifecycle"] }]).ready, false);
assert.equal(summarizeRealAgentCoverage(plan, [{ ...pass, passed: false }]).ready, false);
assert.equal(summarizeRealAgentCoverage(plan, [{ ...pass, runtimeMode: "cli" }]).ready, false);
assert.throws(() => summarizeRealAgentCoverage(plan, [pass, pass]), /duplicate/);
const inventory = readRealAgentRequirements();
assert.equal(inventory.length, 8);
assert.equal(new Set(inventory.map((item) => item.kernel)).size, 7);
assert.deepEqual(inventory.find((item) => item.case === "codex-native").capabilities, [
  "response.speed",
  "reasoning.summary",
]);
assert.ok(!inventory.find((item) => item.case === "codex").capabilities.includes("response.speed"));
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
    provider: { kind: "openai-compatible", model: "deepseek-flash" },
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
        "--provider-kind",
        "openai-compatible",
        "--provider-model",
        "deepseek-flash",
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
    { provider: { kind: "native", model: "deepseek-flash" } },
    { provider: { kind: "openai-compatible", model: "another-model" } },
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
  const accountEnv = prepareCodexAccountRuntime({
    root: caseRoot,
    authJson: JSON.stringify({ tokens: { access_token: "private-test-account" } }),
    model: "gpt-5.5",
    env: {
      CODEX_AUTH_JSON: "private-test-account",
      DEEPSEEK_API_KEY: "foreign-provider",
      OPENAI_BASE_URL: "https://other.invalid",
      PATH: process.env.PATH,
    },
  });
  assert.equal(accountEnv.CODEX_AUTH_JSON, undefined);
  assert.equal(accountEnv.OPENAI_BASE_URL, undefined);
  assert.equal(accountEnv.DEEPSEEK_API_KEY, undefined);
  assert.equal(accountEnv.OPENGROVE_REAL_RUNTIME_MODEL, "gpt-5.5");
  assert.equal(
    JSON.parse(readFileSync(join(accountEnv.CODEX_HOME, "auth.json"))).tokens.access_token,
    "private-test-account",
  );
  assert.equal(readFileSync(join(accountEnv.CODEX_HOME, "config.toml"), "utf8"), 'model = "gpt-5.5"\n');
  assert.throws(
    () => prepareCodexAccountRuntime({ root: caseRoot, authJson: "{}", model: "gpt-5.5" }),
    /account profile/,
  );
  const nativeRequirement = inventory.find((item) => item.case === "codex-native");
  const diagnosticContext = { ...planContext, purpose: "diagnostic" };
  const nativePlan = planRealAgents([nativeRequirement], { "codex-native": { image } }, diagnosticContext);
  assert.equal(nativePlan.matrix.include[0].provider.kind, "codex-native");
  assert.throws(
    () =>
      planRealAgents([nativeRequirement], { "codex-native": { image, model: "deepseek-flash" } }, diagnosticContext),
    /provider profile/,
  );
  const deferredPlan = planRealAgents([required[0], nativeRequirement], { pi: { image } }, planContext);
  assert.deepEqual(deferredPlan.unconfigured, []);
  assert.deepEqual(
    deferredPlan.deferred.map((item) => item.case),
    ["codex-native"],
  );
  const deferredReceipt = summarizeRealAgentCoverage(deferredPlan, [pass]);
  assert.equal(deferredReceipt.ready, true, "an explicitly deferred account case is not a release blocker");
  assert.ok(
    !deferredReceipt.coverage.some((item) => item.case === "codex-native"),
    "unrun capabilities must never be counted as passed",
  );
  mkdirSync(join(caseRoot, "scripts"));
  mkdirSync(join(caseRoot, "dist/tests"), { recursive: true });
  writeFileSync(join(caseRoot, "package.json"), JSON.stringify({ type: "module", version: "0.7.0" }));
  copyFileSync(
    resolve(import.meta.dirname, "check-real-runtime-evidence.mjs"),
    join(caseRoot, "scripts/check-real-runtime-evidence.mjs"),
  );
  const probeProgram = (status) =>
    `import { writeFileSync } from "node:fs"; const time = new Date().toISOString(); writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify({schemaVersion:1,generatedAt:time,probes:[{kernel:"pi",capability:"turn.lifecycle",status:${JSON.stringify(status)},checkedAt:time.slice(0,10),hostVersion:"0.7.0",kernelVersion:"0.85.1",runtimeMode:"sdk",provider:{kind:"openai-compatible",model:"deepseek-flash"}}]}));`;
  const stub = join(caseRoot, "dist/tests/kernel-capability-real-runtime-probe-runner.js");
  writeFileSync(stub, probeProgram("passed"));
  const env = {
    ...process.env,
    RUNNER_TEMP: caseRoot,
    CI_CASE_PLAN: JSON.stringify({ ...plan.matrix.include[0], capabilities: "turn.lifecycle" }),
    CI_KERNEL: "pi",
    CI_RUNTIME_MODE: "sdk",
    CI_KERNEL_VERSION: "0.85.1",
    CI_CAPABILITIES: "turn.lifecycle",
    CI_AGENT_IMAGE: image,
    CI_RUNTIME_ENVIRONMENTS: "{}",
    DEEPSEEK_API_KEY: "test-only-deepseek-key",
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
  assert.equal(existsSync(join(caseRoot, "real-agent-case/deepseek")), false);
  assert.equal(`${success.stdout}${success.stderr}`.includes(env.DEEPSEEK_API_KEY), false);
  const receiptPath = join(caseRoot, "real-agent-case/sanitized/case-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(selectRealAgentCases([receipt], { ...context, now: new Date() })[0].capabilities[0], "turn.lifecycle");
  writeFileSync(stub, probeProgram("failed"));
  assert.notEqual(invokeCase().status, 0);
  assert.equal(
    JSON.parse(readFileSync(receiptPath, "utf8")).passed,
    false,
    "failed diagnostics must supersede any earlier success",
  );
  assert.equal(existsSync(join(caseRoot, "real-agent-case/deepseek")), false);
  assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")).failure.capabilities, [
    { capability: "turn.lifecycle", status: "failed" },
  ]);
  env.CI_CASE_PLAN = JSON.stringify(nativePlan.matrix.include[0]);
  env.CODEX_AUTH_JSON = JSON.stringify({ tokens: { access_token: "private-test-account" } });
  writeFileSync(
    stub,
    `import {writeFileSync,readFileSync} from 'node:fs';
    if(process.env.CODEX_AUTH_JSON || process.env.DEEPSEEK_API_KEY) throw new Error('credential environment leaked');
    if(JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json')).auth_mode!=='chatgpt') throw new Error('auth profile mismatch');
    const time=new Date().toISOString();
    writeFileSync(process.argv[process.argv.indexOf('--out')+1], JSON.stringify({schemaVersion:1,generatedAt:time,probes:${JSON.stringify(nativeRequirement.capabilities)}.map(capability=>({kernel:'codex',capability,status:'passed',checkedAt:time.slice(0,10),hostVersion:'0.7.0',kernelVersion:'codex-cli 0.154.0-alpha.6.2',runtimeMode:'sdk',provider:{kind:'native',model:process.env.OPENGROVE_REAL_RUNTIME_MODEL}}))}));`,
  );
  const nativeResult = invokeCase();
  assert.equal(nativeResult.status, 0, nativeResult.stderr);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).passed, true);
  assert.equal(existsSync(join(caseRoot, "real-agent-case/codex-native")), false);
  assert.ok(!`${nativeResult.stdout}${nativeResult.stderr}`.includes("private-test-account"));
  delete env.CODEX_AUTH_JSON;
  assert.notEqual(invokeCase().status, 0);
  const missingAccount = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(missingAccount.passed, false);
  assert.equal(missingAccount.failure.stage, "configuration");
  assert.ok(missingAccount.failure.capabilities.every((item) => item.status === "missing"));
} finally {
  rmSync(caseRoot, { recursive: true, force: true });
}

for (const change of [
  { kernelVersion: "wrong" },
  { image: `ghcr.io/open-grove/pi@sha256:${"b".repeat(64)}` },
  { fingerprint: "wrong" },
  { provider: { ...pass.provider, model: "deepseek-other" } },
])
  assert.equal(summarizeRealAgentCoverage(plan, [{ ...pass, ...change }]).ready, false);
assert.notEqual(
  plan.planDigest,
  planRealAgents(required, { pi: { image, configRevision: "2" } }, planContext).planDigest,
);
