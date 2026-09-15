import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const kernel = process.env.CI_KERNEL;
const mode = process.env.CI_RUNTIME_MODE;
const version = process.env.CI_KERNEL_VERSION;
const capabilities = process.env.CI_CAPABILITIES;
const directory = join(process.env.RUNNER_TEMP, "real-agent-case");
const rawFile = join(directory, "probe.json");
const publicDir = join(directory, "sanitized");
mkdirSync(publicDir, { recursive: true });
const profiles = JSON.parse(process.env.CI_RUNTIME_ENVIRONMENTS || "{}");
const extraEnv = profiles[kernel] ?? {};
for (const [name, value] of Object.entries(extraEnv)) {
  if (
    !/^(OPENGROVE_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|HERMES_|KIMI_|PI_|OPENCLAW_|OPENCODE_)[A-Z0-9_]+$/.test(name) ||
    typeof value !== "string" ||
    /[\r\n]/.test(value)
  )
    throw new Error(`Invalid runtime environment entry for ${kernel}: ${name}`);
  // Mask each value before the runtime sees it. Never persist credentials in artifacts.
  console.log(`::add-mask::${value.replaceAll("%", "%25")}`);
}
const runtimeEnv = { ...process.env, ...extraEnv };
delete runtimeEnv.CI_RUNTIME_ENVIRONMENTS;
const startedAt = new Date().toISOString();
const { version: hostVersion } = JSON.parse(readFileSync("package.json", "utf8"));
execFileSync(
  process.execPath,
  [
    "dist/tests/kernel-capability-real-runtime-probe-runner.js",
    "--kernels",
    kernel,
    "--capabilities",
    capabilities,
    "--cwd",
    join(directory, "workspace"),
    "--out",
    rawFile,
    "--timeout-ms",
    "180000",
  ],
  { stdio: "inherit", env: runtimeEnv },
);
execFileSync(
  process.execPath,
  [
    "scripts/check-real-runtime-evidence.mjs",
    "--file",
    rawFile,
    "--kernel",
    kernel,
    "--require",
    capabilities,
    "--fail-on-failed",
    "--max-age-days",
    "1",
    "--not-before",
    startedAt,
    "--host-version",
    hostVersion,
    "--kernel-version",
    version,
    "--runtime-mode",
    mode,
  ],
  { stdio: "inherit" },
);
// Only evidence that passed schema, identity, coverage and leak checks is publishable.
writeFileSync(join(publicDir, "evidence.json"), readFileSync(rawFile));
writeFileSync(
  join(publicDir, "case-receipt.json"),
  `${JSON.stringify({ kernel, runtimeMode: mode, kernelVersion: version, image: process.env.CI_AGENT_IMAGE, capabilities: capabilities.split(","), passed: true, headSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }, null, 2)}\n`,
);
