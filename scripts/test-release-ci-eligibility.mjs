import assert from "node:assert/strict";

import {
  evaluateReleaseCiEligibility,
  validateCandidateCommit,
  verifyReleaseLiveEvidence,
} from "./release-ci-eligibility.mjs";

import { planRealAgents, createLiveReceipt } from "./real-agent-ci.mjs";

const candidateCommit = "a".repeat(40);
const nightlyCommit = "b".repeat(40);
const now = new Date("2026-08-28T12:00:00.000Z");

assert.doesNotThrow(() => validateCandidateCommit(candidateCommit));
assert.throws(() => validateCandidateCommit("main"), /40-character commit SHA/i);

function workflowRun({ id, headSha, conclusion = "success", updatedAt = "2026-08-28T06:00:00.000Z" }) {
  return {
    id,
    status: "completed",
    conclusion,
    head_sha: headSha,
    updated_at: updatedAt,
    html_url: `https://github.com/open-grove/opengrove/actions/runs/${id}`,
  };
}

{
  const evidence = evaluateReleaseCiEligibility({
    candidateCommit,
    mainRuns: [workflowRun({ id: 101, headSha: candidateCommit })],
    nightlyRuns: [workflowRun({ id: 202, headSha: nightlyCommit })],
    now,
    isAncestor: (ancestor, descendant) => ancestor === nightlyCommit && descendant === candidateCommit,
  });

  assert.equal(evidence.candidateCommit, candidateCommit);
  assert.equal(evidence.mainCi.runId, 101);
  assert.equal(evidence.mainCi.headSha, candidateCommit);
  assert.equal(evidence.nightly.runId, 202);
  assert.equal(evidence.nightly.headSha, nightlyCommit);
  assert.equal(evidence.nightly.ageHours, 6);
}

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit,
      mainRuns: [workflowRun({ id: 101, headSha: "c".repeat(40) })],
      nightlyRuns: [workflowRun({ id: 202, headSha: nightlyCommit })],
      now,
      isAncestor: () => true,
    }),
  /exact candidate SHA/i,
);

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit,
      mainRuns: [
        workflowRun({ id: 101, headSha: candidateCommit, updatedAt: "2026-08-28T04:00:00.000Z" }),
        workflowRun({
          id: 102,
          headSha: candidateCommit,
          conclusion: "failure",
          updatedAt: "2026-08-28T05:00:00.000Z",
        }),
      ],
      nightlyRuns: [workflowRun({ id: 202, headSha: nightlyCommit })],
      now,
      isAncestor: () => true,
    }),
  /latest Main CI run.*failure/i,
);

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit,
      mainRuns: [workflowRun({ id: 101, headSha: candidateCommit })],
      nightlyRuns: [
        workflowRun({ id: 201, headSha: nightlyCommit, updatedAt: "2026-08-28T04:00:00.000Z" }),
        workflowRun({
          id: 202,
          headSha: nightlyCommit,
          conclusion: "failure",
          updatedAt: "2026-08-28T06:00:00.000Z",
        }),
      ],
      now,
      isAncestor: () => true,
    }),
  /latest Nightly run.*failure/i,
);

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit,
      mainRuns: [workflowRun({ id: 101, headSha: candidateCommit })],
      nightlyRuns: [workflowRun({ id: 202, headSha: nightlyCommit, updatedAt: "2026-08-27T11:59:59.000Z" })],
      now,
      isAncestor: () => true,
    }),
  /older than 24 hours/i,
);

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit,
      mainRuns: [workflowRun({ id: 101, headSha: candidateCommit })],
      nightlyRuns: [workflowRun({ id: 202, headSha: nightlyCommit })],
      now,
      isAncestor: () => false,
    }),
  /not an ancestor/i,
);

assert.throws(
  () =>
    evaluateReleaseCiEligibility({
      candidateCommit: "main",
      mainRuns: [],
      nightlyRuns: [],
      now,
      isAncestor: () => true,
    }),
  /40-character commit SHA/i,
);

console.log("Release CI eligibility harness ok");

const run = { id: 202, run_attempt: 2, head_sha: nightlyCommit };
const required = [
  {
    case: "pi",
    kernel: "pi",
    runtime_mode: "sdk",
    kernel_version: "0.85.1",
    capabilities: ["turn.lifecycle"],
    provider: { kind: "deepseek", protocol: "openai-completions", model: "deepseek-flash", configRevision: "1" },
  },
];
const context = { headSha: nightlyCommit, runId: "202", runAttempt: "2", inputDigest: "a".repeat(64), now };
const images = { pi: { image: `ghcr.io/open-grove/pi@sha256:${"a".repeat(64)}` } };
const plan = planRealAgents(required, images, context);
const entry = plan.matrix.include[0];
const oldCase = {
  schemaVersion: 2,
  case: "pi",
  kernel: "pi",
  runtimeMode: "sdk",
  kernelVersion: "0.85.1",
  image: entry.image,
  provider: entry.provider,
  fingerprint: entry.fingerprint,
  capabilities: ["turn.lifecycle"],
  passed: true,
  headSha: nightlyCommit,
  runId: "202",
  runAttempt: "1",
  generatedAt: now.toISOString(),
  artifactId: 99,
};
// Agent succeeds on attempt 1; another independent branch fails. Only that
// branch and Nightly's final result run on attempt 2, reusing the original case.
const proof = createLiveReceipt(plan, [oldCase], context, "success");
const checkProof = (evidence = proof, digest = proof.inputDigest, expectedPlan = plan) =>
  verifyReleaseLiveEvidence({ evidence, run, plan: expectedPlan, candidateInputDigest: digest, now });
assert.equal(checkProof().capabilities, 1);
assert.equal(proof.runAttempt, "2");
assert.equal(proof.coverage[0].caseRunAttempt, "1");
assert.throws(() => checkProof(undefined, "b".repeat(64)), /inputs changed/);
assert.throws(() => checkProof({ ...proof, ready: false }), /complete/);
assert.throws(() => checkProof({ ...proof, runAttempt: "1" }), /different/);
assert.throws(() => checkProof({ ...proof, coverage: [] }), /incomplete/);
for (const change of [
  { kernelVersion: "wrong" },
  { image: `ghcr.io/open-grove/pi@sha256:${"b".repeat(64)}` },
  { fingerprint: "wrong" },
  { provider: { ...entry.provider, model: "deepseek-other" } },
  { artifactId: null },
  { caseRunAttempt: "3" },
])
  assert.throws(() => checkProof({ ...proof, coverage: [{ ...proof.coverage[0], ...change }] }), /identity/);
assert.throws(
  () => checkProof({ ...proof, coverage: [{ ...proof.coverage[0], checkedAt: "2020-01-01T00:00:00Z" }] }),
  /Stale/,
);
assert.throws(
  () =>
    checkProof({
      ...proof,
      coverage: [{ ...proof.coverage[0], capabilities: [{ capability: "turn.lifecycle", status: "skipped" }] }],
    }),
  /Unverified/,
);
assert.throws(
  () => createLiveReceipt(plan, [{ ...oldCase, headSha: "c".repeat(40) }], context, "success"),
  /another run/,
);
const failedLatest = createLiveReceipt(
  plan,
  [oldCase, { ...oldCase, runAttempt: "2", passed: false, artifactId: 100 }],
  context,
  "success",
);
assert.equal(failedLatest.ready, false, "an old success must never hide a newer failure");
assert.throws(() => checkProof(failedLatest), /complete/);
const changedPlan = planRealAgents(required, { pi: { ...images.pi, model: "deepseek-other" } }, context);
assert.throws(() => checkProof(proof, proof.inputDigest, changedPlan), /plan/);
assert.equal(createLiveReceipt(plan, [oldCase], context, "failure").ready, false);
console.log("Partial Nightly reruns preserve identity, freshness and failure barriers");
