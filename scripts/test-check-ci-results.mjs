import assert from "node:assert/strict";
import { checkCiResults, parseCiJobExpectations } from "./check-ci-results.mjs";

assert.deepEqual(
  checkCiResults(
    { scope: { result: "success" }, web: { result: "skipped" }, unit: { result: "success" } },
    { scope: "success", web: "skipped", unit: "success" },
  ),
  [],
  "jobs should satisfy the aggregate gate only when they match the scope decision",
);

assert.deepEqual(
  checkCiResults({ scope: { result: "success" }, web: { result: "failure" }, unit: { result: "cancelled" } }),
  [
    { job: "web", result: "failure", expected: "success" },
    { job: "unit", result: "cancelled", expected: "success" },
  ],
  "failed and cancelled dependencies must fail the aggregate gate",
);

assert.deepEqual(
  checkCiResults({ scope: { result: "success" }, malformed: {} }),
  [{ job: "malformed", result: "missing", expected: "success" }],
  "a malformed dependency result must fail closed",
);

assert.deepEqual(
  checkCiResults({ scope: { result: "success" }, web: { result: "skipped" } }, { scope: "success", web: "success" }),
  [{ job: "web", result: "skipped", expected: "success" }],
  "a required job that GitHub skipped must not produce a false-green aggregate",
);

assert.deepEqual(
  checkCiResults({ scope: { result: "success" }, web: { result: "success" } }, { scope: "success", web: "skipped" }),
  [{ job: "web", result: "success", expected: "skipped" }],
  "an out-of-scope job that ran should expose a broken scope contract",
);

assert.deepEqual(
  parseCiJobExpectations("scope=success\nweb=skipped\nunit=success\n"),
  { scope: "success", web: "skipped", unit: "success" },
  "the workflow-friendly expectation format should parse without hidden defaults",
);

assert.throws(() => checkCiResults(null), /object/u, "the GitHub needs payload must be an object");
assert.throws(() => checkCiResults({}), /at least one/u, "an empty needs payload must not report false success");
assert.throws(
  () => checkCiResults({ scope: { result: "success" } }, { scope: "success", web: "skipped" }),
  /unknown dependency/u,
  "expectations must not silently drift beyond the dependency list",
);
assert.throws(
  () => checkCiResults({ scope: { result: "success" }, web: { result: "skipped" } }, { scope: "success" }),
  /missing dependency/u,
  "every dependency must have an explicit expectation when scope policy is supplied",
);

console.log("CI result aggregation harness ok");
