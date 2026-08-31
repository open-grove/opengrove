import { appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/iu;

export function validateCandidateCommit(candidateCommit) {
  if (!commitPattern.test(candidateCommit)) throw new Error("Candidate must be a 40-character commit SHA");
}

function runTimestamp(run, label) {
  const value = run?.updated_at;
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp))
    throw new Error(`${label} run ${String(run?.id ?? "unknown")} has no valid updated_at`);
  return timestamp;
}

function latestRun(runs, label) {
  return [...runs].sort((left, right) => runTimestamp(right, label) - runTimestamp(left, label))[0];
}

function describeRun(run) {
  return `${String(run.id)} (${String(run.html_url ?? "no URL")})`;
}

export function evaluateReleaseCiEligibility({
  candidateCommit,
  mainRuns,
  nightlyRuns,
  now = new Date(),
  maxNightlyAgeHours = 24,
  isAncestor,
}) {
  validateCandidateCommit(candidateCommit);
  if (!Array.isArray(mainRuns) || !Array.isArray(nightlyRuns)) throw new Error("Workflow runs must be arrays");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Current time must be a valid Date");
  if (!Number.isFinite(maxNightlyAgeHours) || maxNightlyAgeHours <= 0) {
    throw new Error("Maximum Nightly age must be a positive number of hours");
  }
  if (typeof isAncestor !== "function") throw new Error("An ancestry verifier is required");

  const exactMainRuns = mainRuns.filter(
    (run) => run?.status === "completed" && run?.head_sha?.toLowerCase() === candidateCommit.toLowerCase(),
  );
  if (exactMainRuns.length === 0)
    throw new Error(`No completed Main CI run exists for exact candidate SHA ${candidateCommit}`);

  const mainRun = latestRun(exactMainRuns, "Main CI");
  if (mainRun.conclusion !== "success") {
    throw new Error(`Latest Main CI run ${describeRun(mainRun)} concluded ${String(mainRun.conclusion)}`);
  }

  const completedNightlyRuns = nightlyRuns.filter((run) => run?.status === "completed");
  if (completedNightlyRuns.length === 0) throw new Error("No completed Nightly run exists on main");

  const nightlyRun = latestRun(completedNightlyRuns, "Nightly");
  if (nightlyRun.conclusion !== "success") {
    throw new Error(`Latest Nightly run ${describeRun(nightlyRun)} concluded ${String(nightlyRun.conclusion)}`);
  }
  if (!commitPattern.test(String(nightlyRun.head_sha ?? ""))) {
    throw new Error(`Latest Nightly run ${describeRun(nightlyRun)} has no valid head SHA`);
  }

  const ageHours = (now.getTime() - runTimestamp(nightlyRun, "Nightly")) / (60 * 60 * 1000);
  if (ageHours < -5 / 60) throw new Error(`Latest Nightly run ${describeRun(nightlyRun)} has a future timestamp`);
  if (ageHours > maxNightlyAgeHours) {
    throw new Error(
      `Latest Nightly run ${describeRun(nightlyRun)} is ${ageHours.toFixed(1)} hours old, older than ${maxNightlyAgeHours} hours`,
    );
  }
  if (!isAncestor(nightlyRun.head_sha, candidateCommit)) {
    throw new Error(`Nightly SHA ${nightlyRun.head_sha} is not an ancestor of candidate ${candidateCommit}`);
  }

  return {
    schemaVersion: 1,
    candidateCommit,
    mainCi: {
      runId: mainRun.id,
      runUrl: mainRun.html_url,
      headSha: mainRun.head_sha,
      updatedAt: mainRun.updated_at,
    },
    nightly: {
      runId: nightlyRun.id,
      runUrl: nightlyRun.html_url,
      headSha: nightlyRun.head_sha,
      updatedAt: nightlyRun.updated_at,
      ageHours: Number(ageHours.toFixed(3)),
    },
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${String(name)}`);
    values.set(name.slice(2), value);
  }
  return values;
}

function requireArgument(values, name, fallback = "") {
  const value = values.get(name) ?? fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function fetchWorkflowRuns({ repository, workflow, fields }) {
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(workflow)) throw new Error(`Invalid workflow filename: ${workflow}`);
  const response = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      `repos/${repository}/actions/workflows/${workflow}/runs`,
      ...Object.entries(fields).flatMap(([name, value]) => ["-f", `${name}=${value}`]),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const payload = JSON.parse(response);
  if (!Array.isArray(payload.workflow_runs)) throw new Error(`${workflow} API response has no workflow_runs array`);
  return payload.workflow_runs;
}

function gitIsAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Could not compare Nightly SHA ${ancestor} with candidate ${descendant}`);
}

function writeEvidence(evidence, githubOutput, githubStepSummary) {
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `main_ci_run_url=${evidence.mainCi.runUrl}`,
        `nightly_run_url=${evidence.nightly.runUrl}`,
        `nightly_sha=${evidence.nightly.headSha}`,
        "",
      ].join("\n"),
    );
  }
  if (githubStepSummary) {
    appendFileSync(
      githubStepSummary,
      [
        "## Release CI evidence",
        "",
        `- Candidate: \`${evidence.candidateCommit}\``,
        `- Main CI: [run ${evidence.mainCi.runId}](${evidence.mainCi.runUrl})`,
        `- Nightly: [run ${evidence.nightly.runId}](${evidence.nightly.runUrl}) at \`${evidence.nightly.headSha}\` (${evidence.nightly.ageHours.toFixed(1)} hours old)`,
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const repository = requireArgument(argumentsByName, "repository", process.env.GITHUB_REPOSITORY);
  const candidateCommit = requireArgument(argumentsByName, "candidate");
  validateCandidateCommit(candidateCommit);
  const mainWorkflow = requireArgument(argumentsByName, "main-workflow");
  const nightlyWorkflow = requireArgument(argumentsByName, "nightly-workflow");
  const maxNightlyAgeHours = Number(requireArgument(argumentsByName, "max-nightly-age-hours", "24"));

  const mainRuns = fetchWorkflowRuns({
    repository,
    workflow: mainWorkflow,
    fields: { head_sha: candidateCommit, status: "completed", per_page: 20 },
  });
  const nightlyRuns = fetchWorkflowRuns({
    repository,
    workflow: nightlyWorkflow,
    fields: { branch: "main", status: "completed", per_page: 20 },
  });
  const evidence = evaluateReleaseCiEligibility({
    candidateCommit,
    mainRuns,
    nightlyRuns,
    maxNightlyAgeHours,
    isAncestor: gitIsAncestor,
  });
  writeEvidence(evidence, argumentsByName.get("github-output"), process.env.GITHUB_STEP_SUMMARY);
  console.log(JSON.stringify(evidence, null, 2));
}
