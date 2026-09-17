import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCiProcess } from "./ci-process.mjs";
import { prepareDeepSeekRuntime, startDeepSeekGateway } from "./deepseek-ci.mjs";

const expected = JSON.parse(process.env.CI_CASE_PLAN || "null");
if (!expected || !/^[a-f0-9]{64}$/.test(expected.fingerprint))
  throw new Error("A resolved immutable case plan is required");
const { kernel, runtime_mode: mode, kernel_version: version, capabilities } = expected;
const directory = join(process.env.RUNNER_TEMP, "real-agent-case");
const rawFile = join(directory, "probe.json");
const publicDir = join(directory, "sanitized");
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
let runtimeEnv;
const startedAt = new Date().toISOString();
const { version: hostVersion } = JSON.parse(readFileSync("package.json", "utf8"));
let gateway;
let stage = "configuration";
const receipt = {
  schemaVersion: 2,
  case: expected.case,
  kernel,
  runtimeMode: mode,
  kernelVersion: version,
  image: expected.image,
  provider: expected.provider,
  fingerprint: expected.fingerprint,
  capabilities: capabilities.split(","),
  passed: false,
  generatedAt: startedAt,
  headSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
};
try {
  if (expected.provider.kind !== "deepseek" || !process.env.DEEPSEEK_API_KEY)
    throw new Error("The resolved DeepSeek profile needs DEEPSEEK_API_KEY");
  runtimeEnv = {
    ...process.env,
    ...prepareDeepSeekRuntime(kernel, {
      root: directory,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: expected.provider.model,
    }),
  };
  // Certified profiles have one source of configuration. Extra runtime profiles
  // must be added to the support policy before they can certify a release.
  delete runtimeEnv.CI_RUNTIME_ENVIRONMENTS;
  stage = "gateway";
  if (kernel === "openclaw" && process.env.DEEPSEEK_API_KEY) {
    gateway = await startDeepSeekGateway(runtimeEnv);
    Object.assign(runtimeEnv, gateway.env);
  }
  stage = "probe";
  await run(
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
  stage = "validation";
  await run(
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
  receipt.passed = true;
} catch (error) {
  // The raw probe stays private. Public failure diagnostics contain no model
  // response, environment values, provider URLs or credentials.
  receipt.failure = {
    stage,
    reason: error.timedOut ? "timeout" : "case_failed",
    exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
  };
  process.exitCode = 1;
} finally {
  receipt.durationMs = Date.now() - Date.parse(startedAt);
  writeFileSync(join(publicDir, "case-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await gateway?.stop();
  rmSync(join(directory, "deepseek"), { recursive: true, force: true });
}

async function run(command, args, options) {
  const result = await runCiProcess(command, args, { ...options, timeoutMs: 20 * 60_000 });
  if (result.status !== 0 || result.timedOut || result.interrupted) {
    const error = new Error("Real Agent command failed");
    error.exitCode = result.status;
    error.timedOut = result.timedOut;
    throw error;
  }
}
