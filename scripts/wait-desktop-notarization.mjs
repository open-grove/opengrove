import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppleNotaryCredentials } from "./desktop-release-credentials.mjs";
import { waitForNotarizationPipelines } from "./desktop-notarization-pipeline.mjs";
import { readDesktopReleaseCandidateSource } from "./desktop-release-targets.mjs";
import { runCommand } from "./parallel-release-tasks.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStatePath = join(projectRoot, ".opengrove", "desktop-notarization-submissions.json");

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  await main();
}

export async function waitForDesktopNotarization({
  statePath = defaultStatePath,
  packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version,
  currentSource = readDesktopReleaseCandidateSource(projectRoot, packageVersion),
  timeoutMinutes = process.env.OPENGROVE_NOTARIZATION_TIMEOUT_MINUTES || "90",
  pollSeconds = process.env.OPENGROVE_NOTARIZATION_POLL_SECONDS || "60",
  once = false,
  onStapled = async () => {},
} = {}) {
  if (process.platform !== "darwin") throw new Error("desktop notarization wait only runs on macOS");
  if (!existsSync(statePath)) throw new Error(`state file not found: ${statePath}`);

  const timeoutMs = Number(timeoutMinutes) * 60_000;
  const pollMs = Number(pollSeconds) * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMinutes must be non-negative");
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("pollSeconds must be positive");

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  validateState(state, packageVersion, currentSource);
  const credentials = resolveAppleNotaryCredentials();
  if (state.credentialStrategy !== credentials.strategy || state.credentialFingerprint !== credentials.fingerprint) {
    throw new Error("the current Apple notarization credentials do not match the submission state");
  }

  const result = await waitForNotarizationPipelines({
    submissions: state.submissions,
    refreshSubmission: (item) => refreshSubmission(item, credentials),
    persistState: () => writeState(state, statePath),
    onStapled,
    once,
    timeoutMs,
    pollMs,
  });
  return { ...result, state, statePath, timeoutMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statePath = resolve(projectRoot, args.state || ".opengrove/desktop-notarization-submissions.json");
  let result;
  try {
    result = await waitForDesktopNotarization({
      statePath,
      timeoutMinutes: args.timeoutMinutes,
      pollSeconds: args.pollSeconds,
      once: args.once,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (result.failures.length > 0) {
    const rejected = result.state.submissions.filter((item) => item.status === "Invalid" || item.status === "Rejected");
    if (rejected.length > 0) fail(`${rejected.length} notarization submission(s) failed; see ${statePath}`);
    fail(`could not refresh ${result.failures.map((item) => item.id).join(", ")}; state preserved in ${statePath}`);
  }
  if (result.pending === 0) {
    console.log("wait-desktop-notarization: all submissions accepted and stapled.");
    return;
  }
  if (args.once) {
    console.log(`wait-desktop-notarization: ${result.pending} submission(s) still in progress.`);
  } else {
    console.log(
      `wait-desktop-notarization: timed out with ${result.pending} submission(s) still in progress. State: ${statePath}`,
    );
  }
  process.exitCode = 2;
}

async function refreshSubmission(item, credentials) {
  const info = await notaryInfo(item.id, credentials);
  const update = {
    status: info.status,
    updatedAt: new Date().toISOString(),
  };
  if (info.status === "Accepted") {
    update.stapledAt = await staple(item);
  } else if (info.status === "Invalid" || info.status === "Rejected") {
    update.log = await notaryLog(item.id, credentials);
  }
  return update;
}

async function notaryInfo(id, credentials) {
  console.log(`\n$ xcrun notarytool info ${id} ${credentials.redactedArgs.join(" ")} --output-format json`);
  const { stdout: output } = await runCommand(
    "xcrun",
    ["notarytool", "info", id, ...credentials.args, "--output-format", "json"],
    { captureStdout: true },
  );
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return JSON.parse(output);
}

async function notaryLog(id, credentials) {
  try {
    const { stdout } = await runCommand("xcrun", ["notarytool", "log", id, ...credentials.args], {
      captureStdout: true,
      inheritStderr: false,
    });
    return stdout;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function staple(item) {
  const appPath = resolvePath(item.appPath);
  if (!existsSync(appPath)) throw new Error(`accepted submission app path is missing: ${appPath}`);
  console.log(`\n$ xcrun stapler staple ${appPath}`);
  await runCommand("xcrun", ["stapler", "staple", appPath]);
  console.log(`\n$ xcrun stapler validate ${appPath}`);
  await runCommand("xcrun", ["stapler", "validate", appPath]);
  return new Date().toISOString();
}

function validateState(value, packageVersion, currentSource) {
  const arches = Array.isArray(value.submissions) ? value.submissions.map((item) => item.arch) : [];
  if (
    value.schemaVersion !== 1 ||
    value.version !== packageVersion ||
    value.source?.gitCommit !== currentSource.gitCommit ||
    (value.source?.expectedGitTag ?? value.source?.gitTag) !== (currentSource.expectedGitTag ?? currentSource.gitTag) ||
    value.source?.releasedAt !== currentSource.releasedAt ||
    arches.length !== 2 ||
    !arches.includes("arm64") ||
    !arches.includes("x64") ||
    new Set(arches).size !== 2 ||
    value.submissions.some((item) => typeof item.id !== "string" || !item.id)
  ) {
    throw new Error(`state must match package ${packageVersion} and contain exactly arm64 and x64 submissions`);
  }
}

function writeState(value, statePath) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, statePath);
}

function resolvePath(path) {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

function parseArgs(values) {
  const parsed = {
    timeoutMinutes: process.env.OPENGROVE_NOTARIZATION_TIMEOUT_MINUTES || "90",
    pollSeconds: process.env.OPENGROVE_NOTARIZATION_POLL_SECONDS || "60",
    once: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--state") parsed.state = readRequired(values, ++index, value);
    else if (value.startsWith("--state=")) parsed.state = value.slice("--state=".length);
    else if (value === "--timeout-minutes") parsed.timeoutMinutes = readRequired(values, ++index, value);
    else if (value.startsWith("--timeout-minutes=")) parsed.timeoutMinutes = value.slice("--timeout-minutes=".length);
    else if (value === "--poll-seconds") parsed.pollSeconds = readRequired(values, ++index, value);
    else if (value.startsWith("--poll-seconds=")) parsed.pollSeconds = value.slice("--poll-seconds=".length);
    else if (value === "--once") parsed.once = true;
    else throw new Error(`Unknown wait-desktop-notarization option: ${value}`);
  }
  if (!Number.isFinite(Number(parsed.timeoutMinutes)) || Number(parsed.timeoutMinutes) < 0) {
    throw new Error("--timeout-minutes must be a non-negative number");
  }
  if (!Number.isFinite(Number(parsed.pollSeconds)) || Number(parsed.pollSeconds) <= 0) {
    throw new Error("--poll-seconds must be a positive number");
  }
  return parsed;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function fail(message) {
  console.error(`wait-desktop-notarization: ${message}`);
  process.exit(1);
}
