import assert from "node:assert/strict";

import { evaluateReleaseCiEligibility, validateCandidateCommit } from "./release-ci-eligibility.mjs";

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
