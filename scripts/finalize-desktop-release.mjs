import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./parallel-release-tasks.mjs";
import { waitForDesktopNotarization } from "./wait-desktop-notarization.mjs";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const statePath = join(projectRoot, ".opengrove", "desktop-notarization-submissions.json");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;

if (process.platform !== "darwin") {
  throw new Error("finalize-desktop-release currently only handles deferred macOS notarization");
}
if (!existsSync(statePath)) {
  throw new Error(`Notarization state file not found: ${statePath}`);
}

let state = JSON.parse(readFileSync(statePath, "utf8"));
validateState(state);
const notarization = await waitForDesktopNotarization({
  statePath,
  packageVersion,
  onStapled: async (item) => {
    const result = await repackage(item);
    collectRepackagedArtifacts(result);
    await finalizeDmg(item.arch);
  },
});
if (notarization.failures.length > 0) {
  const detail = notarization.failures
    .map((item) => `${item.id}: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`)
    .join("; ");
  throw new AggregateError(
    notarization.failures.map((item) => item.reason),
    `macOS architecture finalization failed: ${detail}`,
  );
}
if (notarization.pending > 0) {
  throw new Error(`${notarization.pending} notarization submission(s) did not finish before the timeout`);
}
state = notarization.state;
validateState(state);
for (const item of state.submissions) {
  if (item.status !== "Accepted" || !item.stapledAt) {
    throw new Error(`Notarization is not complete for ${item.arch}: ${item.id}`);
  }
}
rmSync(join(projectRoot, ".opengrove", "desktop-release-repackage"), { recursive: true, force: true });

run("node", [
  "scripts/check-desktop-artifact.mjs",
  ...state.submissions.flatMap((item) => ["--target", `darwin-${item.arch}`]),
]);
run("node", ["scripts/verify-desktop-release.mjs"]);
run("node", ["scripts/write-desktop-release-source.mjs", "--target", "mac-arm64", "--target", "mac-x64"]);
console.log(
  "\nMac artifacts finalized and verified. Run prepare:desktop-release now, then rerun it when the Windows artifact is added.",
);

function validateState(value) {
  const arches = Array.isArray(value.submissions) ? value.submissions.map((item) => item.arch) : [];
  if (
    value.schemaVersion !== 1 ||
    value.version !== packageVersion ||
    arches.length !== 2 ||
    !arches.includes("arm64") ||
    !arches.includes("x64") ||
    new Set(arches).size !== 2
  ) {
    throw new Error(`Notarization state must match package ${packageVersion} and contain exactly arm64 and x64`);
  }
}

async function repackage(item) {
  const appPath = resolvePath(item.appPath);
  const archFlag = item.arch === "arm64" ? "--arm64" : "--x64";
  if (!existsSync(appPath)) {
    throw new Error(`Cannot repackage missing app: ${appPath}`);
  }
  const taskRoot = join(projectRoot, ".opengrove", "desktop-release-repackage", item.arch);
  const outputDir = join(taskRoot, "output");
  rmSync(taskRoot, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const builderTempDir = join(taskRoot, "builder-tmp");
  // Same per-arch persistent cache as the parallel build: avoids concurrent
  // download races without re-downloading Electron on every repackage.
  const builderCacheDir = join(projectRoot, ".opengrove", "desktop-release-cache", item.arch);
  mkdirSync(builderTempDir, { recursive: true });
  mkdirSync(builderCacheDir, { recursive: true });
  const invocation = nodePackageManagerInvocation("npx", [
    "electron-builder",
    "--config",
    "electron-builder.release.cjs",
    "--mac",
    "dmg",
    "zip",
    archFlag,
    "--prepackaged",
    appPath,
  ]);
  await runCommand(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      OPENGROVE_DEFER_NOTARIZATION: "1",
      APP_BUILDER_TMP_DIR: builderTempDir,
      ELECTRON_BUILDER_CACHE: builderCacheDir,
      OPENGROVE_DESKTOP_ARCH: item.arch,
      OPENGROVE_DESKTOP_OUTPUT_DIR: outputDir,
    },
  });
  const baseName = `OpenGrove-${state.version}-mac-${item.arch}`;
  const artifactFiles = ["dmg", "zip", "dmg.blockmap", "zip.blockmap"].map((extension) => `${baseName}.${extension}`);
  const missing = artifactFiles.filter((file) => !existsSync(join(outputDir, file)));
  if (missing.length > 0) {
    throw new Error(`Repackaged ${item.arch} artifacts are incomplete: ${missing.join(", ")}`);
  }
  return { arch: item.arch, outputDir, artifactFiles };
}

function collectRepackagedArtifacts(result) {
  const releaseDir = join(projectRoot, "release", "desktop");
  mkdirSync(releaseDir, { recursive: true });
  for (const file of result.artifactFiles) {
    const destination = join(releaseDir, file);
    rmSync(destination, { force: true });
    renameSync(join(result.outputDir, file), destination);
  }
}

async function finalizeDmg(arch) {
  const args = ["scripts/finalize-mac-dmg-artifacts.mjs", "--arch", arch];
  console.log(`\n$ ${[process.execPath, ...args].join(" ")}`);
  await runCommand(process.execPath, args, { cwd: projectRoot });
}

function resolvePath(filePath) {
  return isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
}

function run(command, args, extraEnv = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}
