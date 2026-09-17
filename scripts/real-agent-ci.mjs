import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const livePolicy = JSON.parse(readFileSync(new URL("./ci/real-agent-support.json", import.meta.url), "utf8"));
export function readRealAgentRequirements() {
  if (
    livePolicy.schemaVersion !== 1 ||
    !Number.isSafeInteger(livePolicy.policyVersion) ||
    livePolicy.maxAgeHours !== 24
  )
    throw new Error("Invalid live support policy");
  const seen = new Set();
  for (const item of livePolicy.cases) {
    if (
      !/^[a-z0-9-]+$/.test(item.case) ||
      seen.has(item.case) ||
      !Array.isArray(item.capabilities) ||
      !item.capabilities.length ||
      (item.required === false && !item.deferredReason) ||
      new Set(item.capabilities).size !== item.capabilities.length
    )
      throw new Error("Invalid or duplicate live support case");
    seen.add(item.case);
  }
  return livePolicy.cases;
}
export function identityDigest(value) {
  const canonical = (input) =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value ?? null)))
    .digest("hex");
}
export function planRealAgents(required, images, context) {
  if (!/^[a-f0-9]{64}$/.test(context?.inputDigest ?? "")) throw new Error("Live plan requires an input digest");
  const include = [];
  const unconfigured = [];
  const deferred = [];
  for (const item of required) {
    if (item.required === false && !["diagnostic", "exploratory"].includes(context.purpose)) {
      deferred.push({
        case: item.case,
        kernel: item.kernel,
        capabilities: item.capabilities,
        reason: item.deferredReason,
      });
      continue;
    }
    const config = images[item.case];
    if (!config) {
      unconfigured.push(item.case);
      continue;
    }
    if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(config.image ?? ""))
      throw new Error(`${item.case} image must be pinned by GHCR digest`);
    if (Object.keys(config).some((key) => !["image", "kernelVersion", "model", "configRevision"].includes(key)))
      throw new Error(`Unknown live configuration field: ${item.case}`);
    const version = config.kernelVersion ?? item.kernel_version;
    if (typeof version !== "string" || !version.trim() || /[\r\n]/.test(version))
      throw new Error(`${item.case} needs a single-line expected kernelVersion`);
    const provider = {
      ...item.provider,
      model: config.model ?? item.provider.model,
      configRevision: config.configRevision ?? item.provider.configRevision,
    };
    if (
      !(
        (provider.kind === "deepseek" &&
          /^deepseek-[a-z0-9.-]+$/.test(provider.model) &&
          provider.protocol ===
            (item.kernel === "claude-code"
              ? "anthropic"
              : item.kernel === "codex"
                ? "openai-responses"
                : "openai-completions")) ||
        (provider.kind === "codex-native" &&
          item.kernel === "codex" &&
          provider.protocol === "codex-account" &&
          /^gpt-[a-z0-9.-]+$/.test(provider.model))
      ) ||
      !/^[a-zA-Z0-9._-]+$/.test(provider.configRevision)
    )
      throw new Error(`Invalid certified provider profile: ${item.case}`);
    const entry = {
      ...item,
      image: config.image,
      kernel_version: version,
      provider,
      capabilities: item.capabilities.join(","),
    };
    entry.fingerprint = identityDigest({
      policyVersion: livePolicy.policyVersion,
      inputDigest: context.inputDigest,
      entry,
    });
    include.push(entry);
  }
  const plan = {
    schemaVersion: 2,
    purpose: context.purpose ?? "certification",
    policyVersion: livePolicy.policyVersion,
    ...context,
    matrix: { include },
    unconfigured,
    deferred,
  };
  plan.planDigest = identityDigest({
    purpose: plan.purpose,
    policyVersion: plan.policyVersion,
    inputDigest: plan.inputDigest,
    matrix: plan.matrix,
    unconfigured,
    deferred,
  });
  return plan;
}
export function selectRealAgentCases(cases, { headSha, runId, runAttempt, now = new Date() }) {
  const latest = new Map();
  const seen = new Set();
  for (const item of cases) {
    const attempt = Number(item.runAttempt);
    if (
      item.headSha !== headSha ||
      item.runId !== String(runId) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > Number(runAttempt)
    )
      throw new Error("Real Agent case receipt belongs to another run or future attempt");
    const key = `${item.case}:${attempt}`;
    if (seen.has(key)) throw new Error(`duplicate Real Agent case attempt: ${item.case}`);
    seen.add(key);
    const prior = latest.get(item.case);
    if (!prior || Number(prior.runAttempt) < attempt) latest.set(item.case, item);
  }
  for (const item of latest.values()) {
    const age = now.getTime() - Date.parse(item.generatedAt);
    if (!Number.isFinite(age) || age < -300_000 || age > livePolicy.maxAgeHours * 3_600_000)
      throw new Error(`Real Agent case is stale: ${item.case}; rerun its probe`);
  }
  return [...latest.values()];
}
export function summarizeRealAgentCoverage(plan, cases) {
  if (new Set(cases.map((item) => item.case)).size !== cases.length) throw new Error("duplicate Real Agent case");
  const coverage = plan.matrix.include.map((item) => {
    const proof = cases.find((entry) => entry.case === item.case);
    const passed =
      proof?.passed === true &&
      proof.schemaVersion === 2 &&
      proof.fingerprint === item.fingerprint &&
      proof.kernel === item.kernel &&
      proof.runtimeMode === item.runtime_mode &&
      proof.kernelVersion === item.kernel_version &&
      proof.image === item.image &&
      identityDigest(proof.provider) === identityDigest(item.provider);
    return {
      case: item.case,
      kernel: item.kernel,
      runtimeMode: item.runtime_mode,
      kernelVersion: proof?.kernelVersion ?? null,
      image: proof?.image ?? null,
      provider: proof?.provider ?? null,
      fingerprint: proof?.fingerprint ?? null,
      checkedAt: proof?.generatedAt ?? null,
      caseRunAttempt: proof?.runAttempt ?? null,
      artifactId: proof?.artifactId ?? null,
      required: item.required !== false,
      capabilities: item.capabilities.split(",").map((capability) => ({
        capability,
        status: passed && proof.capabilities?.includes(capability) ? "passed" : "not_verified",
      })),
    };
  });
  return {
    ready:
      plan.unconfigured.length === 0 &&
      coverage.length > 0 &&
      coverage.every((item) => item.capabilities.every((entry) => entry.status === "passed")),
    coverage,
    deferred: plan.deferred ?? [],
  };
}
export function createLiveReceipt(plan, cases, context, executionResult) {
  const selected = selectRealAgentCases(cases, context);
  const summary = summarizeRealAgentCoverage(plan, selected);
  return {
    schemaVersion: 2,
    policyVersion: plan.policyVersion,
    headSha: context.headSha,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    plan,
    ...summary,
    ready: summary.ready && executionResult === "success",
    executionResult,
  };
}
export function realAgentInputDigest(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Real Agent evidence requires a full commit SHA");
  // Keep runtime code/dependencies conservative, while UI and unrelated release
  // orchestration do not invalidate an otherwise identical model certification.
  const tree = execFileSync(
    "git",
    [
      "ls-tree",
      "-rz",
      commit,
      "--",
      "src",
      "packages",
      "docker/agents",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "scripts/ci/real-agent-support.json",
      "scripts/real-agent-ci.mjs",
      "scripts/run-real-agent-ci-case.mjs",
      "scripts/deepseek-ci.mjs",
      "scripts/codex-ci.mjs",
      "scripts/ci-process.mjs",
      "scripts/check-real-runtime-evidence.mjs",
      "scripts/verify-agent-image-version.sh",
      "scripts/build-server.mjs",
      "scripts/copy-workspace-runtimes.mjs",
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
  const context = {
    purpose: process.env.LIVE_PURPOSE || "certification",
    headSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    inputDigest: realAgentInputDigest(process.env.GITHUB_SHA),
  };
  const required = readRealAgentRequirements();
  if (command === "plan") {
    const selected = process.env.DISPATCH_KERNEL;
    if (selected && !required.some((item) => item.kernel === selected)) throw new Error("Unknown dispatch kernel");
    if (selected && context.purpose === "certification") context.purpose = "diagnostic";
    const plan = planRealAgents(
      selected ? required.filter((item) => item.kernel === selected) : required,
      JSON.parse(process.env.OPENGROVE_REAL_AGENT_IMAGES || "{}"),
      context,
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
        `Live support plan: ${plan.matrix.include.length} configured; missing required images: ${plan.unconfigured.join(", ") || "none"}. Deferred, unverified cases: ${plan.deferred.map((item) => item.case).join(", ") || "none"}. Missing required configuration never qualifies a release.\n`,
      );
    return;
  }
  if (command !== "summarize") throw new Error("Unknown Real Agent command");
  const files = readdirSync(directory, { recursive: true });
  const plans = files
    .filter((name) => name.endsWith("/plan.json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  if (!plans.length) throw new Error("Missing immutable live execution plan");
  for (const plan of plans)
    if (
      plan.schemaVersion !== 2 ||
      plan.headSha !== context.headSha ||
      plan.runId !== context.runId ||
      Number(plan.runAttempt) > Number(context.runAttempt)
    )
      throw new Error("Live plan belongs to another run");
  const plan = plans.sort((a, b) => Number(b.runAttempt) - Number(a.runAttempt))[0];
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${context.runId}/artifacts?per_page=100`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const artifacts = pages.flatMap((page) => page.artifacts);
  const cases = files
    .filter((name) => name.endsWith("/case-receipt.json"))
    .map((name) => {
      const artifact = artifacts.find((entry) => entry.name === basename(dirname(name)) && !entry.expired);
      if (!artifact) throw new Error("Missing immutable case artifact identity");
      return { ...JSON.parse(readFileSync(join(directory, name), "utf8")), artifactId: artifact.id };
    });
  const summary = createLiveReceipt(plan, cases, context, process.env.SMOKE_RESULT);
  writeFileSync(join(directory, "real-agent-coverage.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Real Agent coverage\n\n${summary.coverage.map((item) => `- ${item.case}: ${item.capabilities.filter((cap) => cap.status === "passed").length}/${item.capabilities.length}; attempt ${item.caseRunAttempt}; artifact ${item.artifactId}`).join("\n")}\n${summary.deferred.map((item) => `- ${item.case}: UNVERIFIED / deferred (${item.capabilities.join(", ")}); ${item.reason}`).join("\n")}\n\nRelease eligible: **${summary.ready && plan.purpose === "certification"}**\n`,
    );
  if (!summary.ready) throw new Error("Incomplete Real Agent coverage; inspect the plan and case diagnostics");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
