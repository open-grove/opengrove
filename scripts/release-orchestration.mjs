import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const stages = ["candidate", "finalize", "register", "promote"];
const workflows = {
  candidate: "desktop-release.yml",
  finalize: "desktop-release-finalize.yml",
  register: "desktop-release-deploy.yml",
  promote: "desktop-release-control.yml",
};

export function releaseIdentity({ commit, tag, clientReleaseNumber }) {
  return createHash("sha256").update(JSON.stringify({ commit, tag, clientReleaseNumber })).digest("hex").slice(0, 24);
}
export function restoreReleaseProgress(state, saved) {
  if (
    saved.schemaVersion !== 2 ||
    ["id", "commit", "tag", "clientReleaseNumber"].some((key) => saved[key] !== state[key]) ||
    !saved.stages ||
    Object.keys(saved.stages).some((stage) => !stages.includes(stage))
  )
    throw new Error("Saved release progress identity mismatch");
  for (const entry of Object.values(saved.stages))
    if (!Number.isSafeInteger(entry.runId) || entry.runId <= 0) throw new Error("Saved child run identity is invalid");
  // The current invocation supplies authorization; an old receipt cannot expand it.
  state.stages = saved.stages;
  return state;
}
export function githubWorkflowApi(repository, invoke = execFileSync) {
  return (path, payload) =>
    JSON.parse(
      invoke(
        "gh",
        [
          "api",
          `repos/${repository}/${path}`,
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          ...(payload ? ["--method", "POST", "--input", "-"] : []),
        ],
        {
          input: payload ? JSON.stringify(payload) : undefined,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["pipe", "pipe", "inherit"],
        },
      ),
    );
}
export function dispatchReleaseStage(name, state, api) {
  const common = { orchestration_id: state.id, orchestration_tag: state.tag };
  const inputs =
    name === "candidate"
      ? { ...common, ref: state.commit, platforms: "all", first_public_release: false }
      : name === "promote"
        ? { ...common, action: "promote", client_release_number: String(state.clientReleaseNumber) }
        : { ...common, candidate_run_id: String(state.stages.candidate.runId), tag: state.tag };
  const response = api(`actions/workflows/${workflows[name]}/dispatches`, { ref: "main", inputs });
  if (!Number.isSafeInteger(response.workflow_run_id) || response.workflow_run_id <= 0)
    throw new Error("Dispatch acknowledgement has no run identity; recover before retrying");
  return response;
}
function readProgressArtifact(repository, runId, api) {
  const artifacts = [];
  for (let page = 1; ; page++) {
    const values = api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`).artifacts;
    artifacts.push(...values.filter((entry) => !entry.expired && entry.name.startsWith(`release-progress-${runId}-`)));
    if (values.length < 100) break;
  }
  const artifact = artifacts.sort((a, b) => b.id - a.id)[0];
  if (!artifact) return null; // A dispatch may finish before the first progress upload.
  const directory = mkdtempSync(join(tmpdir(), "opengrove-release-progress-"));
  try {
    execFileSync(
      "gh",
      ["run", "download", String(runId), "--repo", repository, "--name", artifact.name, "--dir", directory],
      { stdio: "inherit", timeout: 60_000 },
    );
    return JSON.parse(readFileSync(join(directory, "release-progress.json"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function title(state, stage) {
  return `OpenGrove ${state.tag} / ${stage} [${state.id}]`;
}
function checkRun(state, stage, run) {
  if (
    run.event !== "workflow_dispatch" ||
    run.path !== `.github/workflows/${workflows[stage]}` ||
    run.display_title !== title(state, stage)
  )
    throw new Error(`Release ${stage} workflow identity mismatch`);
  if (stage === "candidate" && run.head_sha !== state.commit) throw new Error("Release candidate SHA mismatch");
}
export async function runReleaseStage(state, stage, { lookup, dispatch, readRun, save, pause }) {
  const index = stages.indexOf(stage);
  if (index < 0 || !stages.includes(state.stopAfter)) throw new Error("Unknown release stage");
  if (index > stages.indexOf(state.stopAfter)) return;
  for (const previous of stages.slice(0, index)) {
    const proof = state.stages[previous];
    if (!proof || proof.status !== "success")
      throw new Error(`Release ${stage} requires a successful previous stage: ${previous}`);
    const run = await readRun(proof.runId);
    checkRun(state, previous, run);
    if (run.status !== "completed" || run.conclusion !== "success")
      throw new Error(`Previous stage ${previous} is no longer successful`);
  }
  let record = state.stages[stage];
  if (!record) {
    const existing = await lookup(stage, title(state, stage));
    if (existing) checkRun(state, stage, existing);
    const runId = existing?.id ?? (await dispatch(stage, state));
    if (!Number.isSafeInteger(runId) || runId <= 0)
      throw new Error(`No run ID returned for ${stage}; do not redispatch blindly`);
    record = state.stages[stage] = { runId, status: "running" };
    save(state);
  }
  const deadline = Date.now() + (stage === "candidate" ? 210 : 60) * 60_000;
  while (Date.now() < deadline) {
    const run = await readRun(record.runId);
    checkRun(state, stage, run);
    record.url = run.html_url;
    if (run.status === "completed") {
      record.status = run.conclusion;
      save(state);
      if (run.conclusion !== "success")
        throw new Error(
          `${stage} concluded ${run.conclusion}: ${run.html_url}. Fix/rerun that child run, then resume this pipeline; no automatic republishing.`,
        );
      return;
    }
    await pause(15_000);
  }
  throw new Error(`${stage} is still running at ${record.url}; resume with the existing run, without rebuilding.`);
}
async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.CANDIDATE_COMMIT;
  const stopAfter = process.env.STOP_AFTER;
  const id = process.env.RESUME_RUN_ID || process.env.GITHUB_RUN_ID;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[a-f0-9]{40}$/.test(commit ?? "") ||
    !/^\d+$/.test(id ?? "") ||
    !stages.includes(stopAfter)
  )
    throw new Error("A repository, exact candidate SHA, valid run ID and explicit stop stage are required");
  const api = githubWorkflowApi(repository);
  if (process.env.RESUME_RUN_ID) {
    const original = api(`actions/runs/${id}`);
    if (
      original.path !== ".github/workflows/desktop-release-pipeline.yml" ||
      original.event !== "workflow_dispatch" ||
      !original.display_title.startsWith(`OpenGrove pipeline ${commit} / `)
    )
      throw new Error("Resume run is not a pipeline for this candidate SHA");
  }
  const pkg = JSON.parse(execFileSync("git", ["show", `${commit}:package.json`], { encoding: "utf8" }));
  if (
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    !Number.isSafeInteger(pkg.clientReleaseNumber) ||
    pkg.clientReleaseNumber <= 0
  )
    throw new Error("Candidate release identity is invalid");
  const state = {
    schemaVersion: 2,
    id: releaseIdentity({ commit, tag: `v${pkg.version}`, clientReleaseNumber: pkg.clientReleaseNumber }),
    commit,
    tag: `v${pkg.version}`,
    clientReleaseNumber: pkg.clientReleaseNumber,
    stopAfter,
    stages: {},
  };
  const saved = readProgressArtifact(repository, id, api);
  if (saved) restoreReleaseProgress(state, saved);
  const output = resolve(process.env.RELEASE_PROGRESS_FILE);
  mkdirSync(dirname(output), { recursive: true });
  const save = () => writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`);
  save();
  try {
    for (const stage of stages) {
      await runReleaseStage(state, stage, {
        lookup: async (name, expectedTitle) => {
          const matches = [];
          // Exhaust pagination so an older interrupted dispatch cannot be mistaken for an unstarted stage.
          for (let page = 1; ; page++) {
            const runs = api(
              `actions/workflows/${workflows[name]}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
            ).workflow_runs;
            matches.push(...runs.filter((run) => run.display_title === expectedTitle));
            if (runs.length < 100) break;
          }
          if (matches.length > 1)
            throw new Error(`Multiple ${name} runs claim this pipeline; resolve the ambiguity before continuing`);
          return matches[0] ?? null;
        },
        dispatch: async (name) => {
          const response = dispatchReleaseStage(name, state, api);
          const runId = response.workflow_run_id;
          if (process.env.GITHUB_STEP_SUMMARY)
            appendFileSync(
              process.env.GITHUB_STEP_SUMMARY,
              `- ${name}: [run ${runId}](${response.html_url}); pipeline ${id}, stop at ${stopAfter}\n`,
            );
          return runId;
        },
        readRun: async (runId) => api(`actions/runs/${runId}`),
        save,
        pause: setTimeout,
      });
    }
    console.log(`Release pipeline ${id} reached authorized stage: ${stopAfter}`);
  } finally {
    save();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
