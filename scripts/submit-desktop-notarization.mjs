import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppleNotaryCredentials } from "./desktop-release-credentials.mjs";
import { readDesktopReleaseCandidateSource } from "./desktop-release-targets.mjs";
import { parallelTaskFailures, runCommand, settleParallelTasks } from "./parallel-release-tasks.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(projectRoot, "release", "desktop");
const statePath = join(projectRoot, ".opengrove", "desktop-notarization-submissions.json");
const notaryDir = join(projectRoot, ".opengrove", "notary");
const version = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
const credentials = resolveAppleNotaryCredentials();
const source = readDesktopReleaseCandidateSource(projectRoot, version);

if (process.platform !== "darwin") fail("desktop notarization submit only runs on macOS");

mkdirSync(notaryDir, { recursive: true });
const apps = resolveMacApps();
assertExactArches(
  apps.map((app) => app.arch),
  "macOS app bundles",
);

const state = readOrCreateState();
const pendingApps = [];
for (const app of apps) {
  const existing = state.submissions.find((item) => item.arch === app.arch);
  if (existing?.id) {
    console.log(`submit-desktop-notarization: reusing ${app.arch} submission ${existing.id}`);
    continue;
  }
  pendingApps.push(app);
}

const tasks = pendingApps.map((app) => ({
  id: app.arch,
  run: async () => {
    const zipPath = join(notaryDir, `OpenGrove-${version}-mac-${app.arch}-notary.zip`);
    console.log(`\n$ ditto -c -k --keepParent ${app.path} ${zipPath}`);
    await runCommand("ditto", ["-c", "-k", "--keepParent", app.path, zipPath]);

    console.log(`\n$ xcrun notarytool submit ${zipPath} ${credentials.redactedArgs.join(" ")} --output-format json`);
    const { stdout: output } = await runCommand(
      "xcrun",
      ["notarytool", "submit", zipPath, ...credentials.args, "--output-format", "json"],
      { captureStdout: true },
    );
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    const response = JSON.parse(output);
    if (typeof response.id !== "string" || !response.id) {
      throw new Error(`notarytool did not return a submission id for ${app.arch}`);
    }

    const submission = {
      arch: app.arch,
      appPath: relativeToProject(app.path),
      zipPath: relativeToProject(zipPath),
      id: response.id,
      status: "Submitted",
      submittedAt: new Date().toISOString(),
    };
    // Persist synchronously as each upload succeeds, so an interrupted run
    // (not only a failed sibling) never re-submits an accepted upload.
    state.submissions.push(submission);
    state.submissions.sort((left, right) => left.arch.localeCompare(right.arch));
    writeState(state);
    return submission;
  },
}));
const results = await settleParallelTasks("App notarization upload", tasks);
const failures = parallelTaskFailures(tasks, results);
if (failures.length > 0) {
  fail(
    `notarization upload failed for ${failures.map((item) => item.id).join(", ")}; successful submission ids were preserved in ${statePath}`,
  );
}

assertExactArches(
  state.submissions.map((item) => item.arch),
  "notarization submissions",
);
console.log(`\nsubmit-desktop-notarization: wrote ${statePath}`);
for (const item of state.submissions) console.log(`- ${item.arch}: ${item.id}`);

function readOrCreateState() {
  if (!existsSync(statePath)) {
    const created = {
      schemaVersion: 1,
      version,
      createdAt: new Date().toISOString(),
      credentialStrategy: credentials.strategy,
      credentialFingerprint: credentials.fingerprint,
      source,
      submissions: [],
    };
    writeState(created);
    return created;
  }
  const existing = JSON.parse(readFileSync(statePath, "utf8"));
  if (
    existing.schemaVersion !== 1 ||
    existing.version !== version ||
    existing.credentialStrategy !== credentials.strategy ||
    existing.credentialFingerprint !== credentials.fingerprint ||
    existing.source?.gitCommit !== source.gitCommit ||
    (existing.source?.expectedGitTag ?? existing.source?.gitTag) !== source.expectedGitTag ||
    existing.source?.releasedAt !== source.releasedAt ||
    !Array.isArray(existing.submissions)
  ) {
    fail(
      `existing notarization state does not match version ${version} and the current credential strategy; move or remove ${statePath} explicitly`,
    );
  }
  const arches = existing.submissions.map((item) => item.arch);
  if (new Set(arches).size !== arches.length || arches.some((arch) => arch !== "arm64" && arch !== "x64")) {
    fail("existing notarization state contains duplicate or unsupported architectures");
  }
  return existing;
}

function resolveMacApps() {
  const candidates = [
    { arch: "arm64", path: join(releaseDir, "mac-arm64", "OpenGrove.app") },
    { arch: "x64", path: join(releaseDir, "mac-x64", "OpenGrove.app") },
    { arch: "x64", path: join(releaseDir, "mac", "OpenGrove.app") },
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!existsSync(candidate.path) || seen.has(candidate.arch)) return false;
    seen.add(candidate.arch);
    return true;
  });
}

function assertExactArches(arches, label) {
  if (arches.length !== 2 || !arches.includes("arm64") || !arches.includes("x64") || new Set(arches).size !== 2) {
    fail(`${label} must contain exactly arm64 and x64`);
  }
}

function writeState(value) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, statePath);
}

function relativeToProject(path) {
  return path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path;
}

function fail(message) {
  console.error(`submit-desktop-notarization: ${message}`);
  process.exit(1);
}
