import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readRealAgentRequirements() {
  const rows = JSON.parse(
    readFileSync(
      new URL("../src/kernel/capabilities/certified-contract-test-evidence.generated.json", import.meta.url),
      "utf8",
    ),
  );
  const kernels = new Map();
  for (const row of rows.filter((row) => row.verification === "real_runtime" && row.passed)) {
    const entry = kernels.get(row.kernel) ?? {
      kernel: row.kernel,
      runtime_mode: row.runtimeMode,
      kernel_version: row.kernelVersion,
      capabilities: [],
    };
    if (entry.runtime_mode !== row.runtimeMode || entry.kernel_version !== row.kernelVersion)
      throw new Error(`Conflicting certified runtime identity: ${row.kernel}`);
    if (entry.capabilities.includes(row.capability))
      throw new Error(`Duplicate certified capability: ${row.kernel}/${row.capability}`);
    entry.capabilities.push(row.capability);
    kernels.set(row.kernel, entry);
  }
  if (!kernels.size) throw new Error("No certified real-runtime requirements found");
  return [...kernels.values()];
}
export function planRealAgents(required, images) {
  const include = [];
  const unconfigured = [];
  for (const item of required) {
    const config = images[item.kernel];
    if (!config) {
      unconfigured.push(item.kernel);
      continue;
    }
    if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(config.image ?? ""))
      throw new Error(`${item.kernel} image must be pinned by GHCR digest`);
    const version = config.kernelVersion ?? item.kernel_version;
    if (typeof version !== "string" || !version.trim() || /[\r\n]/.test(version))
      throw new Error(`${item.kernel} needs a single-line expected kernelVersion`);
    include.push({
      ...item,
      case: item.kernel,
      image: config.image,
      kernel_version: version,
      capabilities: item.capabilities.join(","),
    });
  }
  return { matrix: { include }, unconfigured };
}
export function summarizeRealAgentCoverage(required, cases) {
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item.kernel)) throw new Error(`duplicate Real Agent case: ${item.kernel}`);
    seen.add(item.kernel);
  }
  const coverage = required.map((item) => {
    const proof = cases.find((entry) => entry.kernel === item.kernel);
    const passed =
      proof?.passed === true &&
      proof.runtimeMode === item.runtime_mode &&
      typeof proof.kernelVersion === "string" &&
      proof.kernelVersion.length > 0;
    const capabilities = item.capabilities.map((capability) => ({
      capability,
      status: passed && proof.capabilities.includes(capability) ? "passed" : "not_verified",
    }));
    return {
      kernel: item.kernel,
      runtimeMode: item.runtime_mode,
      kernelVersion: proof?.kernelVersion ?? null,
      required: true,
      capabilities,
    };
  });
  return { ready: coverage.every((item) => item.capabilities.every((entry) => entry.status === "passed")), coverage };
}
export function realAgentInputDigest(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Real Agent evidence requires a full commit SHA");
  // Hash tracked inputs from git objects, not platform-dependent working-tree bytes.
  const tree = execFileSync(
    "git",
    [
      "ls-tree",
      "-rz",
      commit,
      "--",
      "src",
      "packages",
      "scripts",
      "docker",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      ".github/workflows/real-agent-smoke.yml",
      ".github/workflows/nightly.yml",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return createHash("sha256").update(tree).digest("hex");
}
async function main() {
  const [command, directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: real-agent-ci.mjs plan|summarize DIRECTORY");
  mkdirSync(directory, { recursive: true });
  const required = readRealAgentRequirements();
  if (command === "plan") {
    const selected = process.env.DISPATCH_KERNEL;
    if (selected && !required.some((item) => item.kernel === selected)) throw new Error("Unknown dispatch kernel");
    const plan = planRealAgents(
      selected ? required.filter((item) => item.kernel === selected) : required,
      JSON.parse(process.env.OPENGROVE_REAL_AGENT_IMAGES || "{}"),
    );
    writeFileSync(join(directory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(plan.matrix)}\nrun=${plan.matrix.include.length > 0}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Real Agent plan: ${plan.matrix.include.length} configured; missing pinned images: ${plan.unconfigured.join(", ") || "none"}. A partial or unconfigured plan does not qualify a release.\n`,
      );
    return;
  }
  if (command !== "summarize") throw new Error("Unknown Real Agent command");
  const cases = readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith("case-receipt.json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  const commit = process.env.GITHUB_SHA;
  for (const item of cases) {
    if (
      item.headSha !== commit ||
      item.runId !== process.env.GITHUB_RUN_ID ||
      item.runAttempt !== process.env.GITHUB_RUN_ATTEMPT
    )
      throw new Error("Real Agent case receipt does not belong to this attempt");
  }
  const summary = {
    schemaVersion: 1,
    headSha: commit,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    inputDigest: realAgentInputDigest(commit),
    ...summarizeRealAgentCoverage(required, cases),
  };
  writeFileSync(join(directory, "real-agent-coverage.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Real Agent coverage\n\n| Kernel | Passed / required |\n|---|---|\n${summary.coverage.map((item) => `| ${item.kernel} | ${item.capabilities.filter((cap) => cap.status === "passed").length} / ${item.capabilities.length} |`).join("\n")}\n\nRelease eligible: **${summary.ready}**\n`,
    );
  if (!summary.ready)
    throw new Error(
      "Incomplete Real Agent coverage; configure missing images/provider access or fix failed probes. See coverage artifact.",
    );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
