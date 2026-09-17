import assert from "node:assert/strict";
import {
  runReleaseStage,
  releaseIdentity,
  restoreReleaseProgress,
  githubWorkflowApi,
  dispatchReleaseStage,
} from "./release-orchestration.mjs";
const initial = () => ({
  schemaVersion: 1,
  id: "123",
  commit: "a".repeat(40),
  tag: "v0.8.0",
  clientReleaseNumber: 10033,
  stopAfter: "candidate",
  stages: {},
});
let dispatched = 0;
const run = {
  id: 456,
  event: "workflow_dispatch",
  path: ".github/workflows/desktop-release.yml",
  head_sha: "a".repeat(40),
  display_title: "OpenGrove v0.8.0 / candidate [123]",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/open-grove/opengrove/actions/runs/456",
};
const dependencies = {
  lookup: async () => null,
  dispatch: async () => {
    dispatched++;
    return 456;
  },
  readRun: async () => run,
  save: () => {},
  pause: async () => {},
};
const state = initial();
await runReleaseStage(state, "candidate", dependencies);
assert.equal(dispatched, 1);
assert.equal(state.stages.candidate.status, "success");
await runReleaseStage(state, "candidate", dependencies);
assert.equal(dispatched, 1, "resume must reuse a successful run");
await runReleaseStage(state, "finalize", dependencies);
assert.equal(dispatched, 1, "must stop at the authorized boundary");
await assert.rejects(
  runReleaseStage({ ...initial(), stopAfter: "promote" }, "promote", dependencies),
  /previous stage/,
);
await assert.rejects(
  runReleaseStage(initial(), "candidate", {
    ...dependencies,
    readRun: async () => ({ ...run, conclusion: "failure" }),
  }),
  /failure/,
);
await assert.rejects(
  runReleaseStage(initial(), "candidate", {
    ...dependencies,
    readRun: async () => ({ ...run, head_sha: "b".repeat(40) }),
  }),
  /candidate SHA/,
);
await assert.rejects(
  runReleaseStage(initial(), "candidate", {
    ...dependencies,
    readRun: async () => ({ ...run, display_title: "Unrelated candidate" }),
  }),
  /identity/,
);
const recovered = initial();
const before = dispatched;
await runReleaseStage(recovered, "candidate", { ...dependencies, lookup: async () => run });
assert.equal(dispatched, before, "recover an interrupted dispatch by its immutable orchestration identity");
console.log("Release orchestration boundaries and recovery ok");

const identity = releaseIdentity(initial());
assert.equal(identity, releaseIdentity({ ...initial(), stopAfter: "promote", id: "another-pipeline" }));
assert.notEqual(identity, releaseIdentity({ ...initial(), commit: "b".repeat(40) }));
const saved = {
  ...initial(),
  schemaVersion: 2,
  id: identity,
  stopAfter: "promote",
  stages: { candidate: { runId: 456, status: "success" } },
};
const resumed = restoreReleaseProgress({ ...initial(), schemaVersion: 2, id: identity }, saved);
assert.equal(resumed.stages.candidate.runId, 456);
assert.equal(resumed.stopAfter, "candidate");
assert.throws(() => restoreReleaseProgress({ ...resumed, tag: "v0.9.0" }, saved), /identity/);
let request;
const api = githubWorkflowApi("open-grove/opengrove", (command, args, options) => {
  assert.equal(command, "gh");
  assert.ok(args.includes("X-GitHub-Api-Version: 2026-03-10"));
  request = JSON.parse(options.input);
  return JSON.stringify({ workflow_run_id: 456, html_url: run.html_url });
});
assert.equal(dispatchReleaseStage("candidate", resumed, api).workflow_run_id, 456);
assert.deepEqual(Object.keys(request), ["ref", "inputs"]);
assert.equal(request.inputs.ref, resumed.commit);
assert.equal(request.inputs.orchestration_id, identity);
assert.throws(() => dispatchReleaseStage("candidate", resumed, () => ({})), /acknowledgement/);
let savedRun;
const interrupted = initial();
await assert.rejects(
  runReleaseStage(interrupted, "candidate", {
    ...dependencies,
    save: (value) => {
      savedRun = structuredClone(value);
    },
    readRun: async () => {
      throw new Error("connection lost");
    },
  }),
  /connection lost/,
);
const countBeforeResume = dispatched;
await runReleaseStage(savedRun, "candidate", dependencies);
assert.equal(dispatched, countBeforeResume, "persisted child IDs prevent redispatch after a connection loss");
