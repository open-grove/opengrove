import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const pr = workflow("ci.yml");
const main = workflow("main-ci.yml");
const shared = workflow("ci-checks.yml");
const nightly = workflow("nightly.yml");

assert.deepEqual(Object.keys(pr.on), ["pull_request", "merge_group"]);
assert.deepEqual(main.on.push.branches, ["main"]);
assert.equal(main.concurrency["cancel-in-progress"], true);
for (const [entry, resultId, resultName] of [
  [pr, "required", "PR required"],
  [main, "result", "Main CI result"],
]) {
  assert.equal(entry.jobs.checks.uses, "./.github/workflows/ci-checks.yml");
  const result = entry.jobs[resultId];
  assert.equal(result.name, resultName);
  assert.equal(result.if, "always()");
  assert.equal(result.needs, "checks");
  assert.ok(result.steps.some((step) => step.run === "node scripts/check-ci-results.mjs"));
}
assert.deepEqual(Object.keys(shared.on), ["workflow_call"]);
assert.deepEqual(shared.permissions, { contents: "read" });
assert.equal(shared.jobs.result.if, "always()");
assert.deepEqual(
  new Set(shared.jobs.result.needs),
  new Set(Object.keys(shared.jobs).filter((name) => name !== "result")),
);
const resultStep = shared.jobs.result.steps.find((step) => step.env?.CI_JOB_EXPECTATIONS);
for (const name of ["checks", "platforms", "packages"]) {
  assert.ok(resultStep.env.CI_JOB_EXPECTATIONS.includes(`${name}=`));
  assert.ok(shared.jobs[name].if.includes(`has_${name}`));
  assert.ok(shared.jobs[name].strategy.matrix.includes(`outputs.${name}`));
}
assert.ok(shared.jobs.platforms.steps.some((step) => step.run === "node scripts/run-ci-platform.mjs"));
assert.ok(shared.jobs.platforms.steps.some((step) => step.env?.OPENGROVE_STORAGE_ACCEPTANCE_RECEIPT));
assert.ok(shared.jobs.packages.steps.some((step) => step.run?.includes("scripts/run-ci-desktop-package.mjs")));
assert.ok(
  !JSON.stringify(shared).includes("secrets."),
  "untrusted source and package CI must not receive release or provider secrets",
);
assert.deepEqual(nightly.on.schedule, [{ cron: "0 2,14 * * *" }]);

// Validate the dependency graph, not YAML whitespace or a copied list of jobs.
for (const file of readdirSync(resolve(root, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file))) {
  const value = workflow(file);
  for (const [id, job] of Object.entries(value.jobs)) {
    for (const dependency of typeof job.needs === "string" ? [job.needs] : (job.needs ?? [])) {
      assert.ok(value.jobs[dependency], `${file}: ${id} depends on missing ${dependency}`);
      assert.notEqual(id, dependency);
    }
    if (job.uses?.startsWith("./")) {
      assert.doesNotThrow(() => readFileSync(resolve(root, job.uses)), `${file}: missing reusable workflow`);
    }
  }
}
console.log("CI workflow contract harness ok");

assert.equal(
  shared.jobs.checks.container,
  undefined,
  "permission and process cleanup tests require the standard Linux user/init environment",
);
assert.ok(!nightly.jobs.harness && !nightly.jobs["browser-ui"] && !nightly.jobs["web-package"]);
const live = workflow("real-agent-smoke.yml");
const providerSetup = live.jobs.smoke.steps.find((step) => step.env?.CI_DEEPSEEK_API_KEY);
assert.ok(providerSetup);
assert.equal(live.jobs.smoke.environment, "opengrove-real-agent-test");
for (const kernel of ["claude-code", "opencode", "pi", "codex", "kimi", "hermes", "openclaw"]) {
  const bootstrap = spawnSync("bash", ["-c", providerSetup.run], {
    env: { PATH: process.env.PATH, KERNEL: kernel, CI_DEEPSEEK_API_KEY: "test-only-deepseek-key" },
    encoding: "utf8",
  });
  assert.equal(bootstrap.status, 0, `${kernel}: DeepSeek must not require Cloudflare credentials`);
  assert.equal(`${bootstrap.stdout}${bootstrap.stderr}`.includes("test-only-deepseek-key"), false);
}
assert.ok(live.jobs.coverage.steps.some((step) => step.run?.includes("real-agent-ci.mjs summarize")));
assert.ok(
  !live.on.push && !live.on.pull_request,
  "Nightly owns live service health; PR source checks must not require secrets",
);
const pipeline = workflow("desktop-release-pipeline.yml");
assert.deepEqual(Object.keys(pipeline.on), ["workflow_dispatch"]);
assert.equal(pipeline.on.workflow_dispatch.inputs.stop_after.default, "candidate");
assert.deepEqual(pipeline.on.workflow_dispatch.inputs.stop_after.options, [
  "candidate",
  "finalize",
  "register",
  "promote",
]);

const imageBuild = workflow("build-agent-images.yml");
const imageSteps = imageBuild.jobs.build.steps;
const publishIndex = imageSteps.findIndex((step) => step.id === "publish");
const verifyIndex = imageSteps.findIndex((step) => step.run?.includes("verify-agent-image-version.sh"));
assert.ok(verifyIndex >= 0 && publishIndex > verifyIndex, "verify the actual image before publishing it");
assert.equal(imageSteps[publishIndex].if, "inputs.publish");
assert.equal(imageSteps.find((step) => step.id === "build").with.push, false);
assert.equal(imageSteps.find((step) => step.id === "build").with.load, true);
