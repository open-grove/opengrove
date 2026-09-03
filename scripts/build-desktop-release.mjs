import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macArchitectureBuildPlan } from "./desktop-release-build-plan.mjs";
import { desktopReleaseWebBuildId, readDesktopReleaseCandidateSource } from "./desktop-release-targets.mjs";
import { runCommand, runParallelTasks } from "./parallel-release-tasks.mjs";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const syncNotarization =
  process.argv.includes("--sync-notarization") || process.env.OPENGROVE_SYNC_NOTARIZATION === "1";

run("node", ["scripts/preflight-desktop-release.mjs"]);
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const releaseSource = readDesktopReleaseCandidateSource(projectRoot, packageJson.version);
runNodePackageManager("npm", ["run", "build"], {
  OPENGROVE_WEB_BUILD_ID: desktopReleaseWebBuildId(packageJson.version, releaseSource.gitCommit),
  OPENGROVE_WEB_DEV_FIXTURE_ACCOUNTS: "0",
});
run("node", ["scripts/check-web-fixture-account-boundary.mjs"]);
runNodePackageManager("npm", ["run", "minify:dist"]);
runNodePackageManager("npm", ["run", "check:desktop-package"]);

const builderArgs = ["--config", "electron-builder.release.cjs"];
if (process.platform === "darwin") {
  run("node", ["scripts/stage-desktop-runtime.mjs", "--target", "mac"]);
  await buildMacArchitectures(builderArgs, packageJson.version);
} else if (process.platform === "win32") {
  run("node", ["scripts/stage-desktop-runtime.mjs", "--target", "windows"]);
  builderArgs.push("--win", "--x64");
  runNodePackageManager("npx", ["electron-builder", ...builderArgs]);
} else {
  throw new Error(
    `Desktop release builds are currently supported on macOS and Windows only. Current platform: ${process.platform}`,
  );
}

if (process.platform === "darwin") {
  run("node", ["scripts/check-desktop-artifact.mjs", "--target", "darwin-arm64", "--target", "darwin-x64"]);
  if (!syncNotarization) {
    run("node", ["scripts/submit-desktop-notarization.mjs"]);
    console.log("\nmacOS notarization has been submitted asynchronously.");
    console.log(
      "Run `npm run notarize:desktop:wait` to poll/staple, or `npm run finalize:desktop-release` to wait, repackage, and verify Mac artifacts. Run prepare:desktop-release separately for the completed platform(s).",
    );
    process.exit(0);
  }
  run("node", ["scripts/finalize-mac-dmg-artifacts.mjs"]);
} else {
  run("node", ["scripts/check-desktop-artifact.mjs", "--target", "win32-x64"]);
}
run("node", ["scripts/verify-desktop-release.mjs"]);
if (process.platform === "darwin") {
  run("node", ["scripts/write-desktop-release-source.mjs", "--target", "mac-arm64", "--target", "mac-x64"]);
} else {
  run("node", ["scripts/write-desktop-release-source.mjs", "--target", "windows-x64"]);
}
console.log(
  "\nDesktop platform build verified. Run prepare:desktop-release now for this platform, or rerun it later after the other platform is added.",
);

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

function runNodePackageManager(manager, args, extraEnv = {}) {
  const invocation = nodePackageManagerInvocation(manager, args);
  run(invocation.command, invocation.args, extraEnv);
}

async function buildMacArchitectures(baseBuilderArgs, version) {
  const buildRoot = join(projectRoot, ".opengrove", "desktop-release-build");
  const releaseDir = join(projectRoot, "release", "desktop");
  const targets = [
    { arch: "arm64", finalAppDir: "mac-arm64", appDirCandidates: ["mac-arm64", "mac"] },
    { arch: "x64", finalAppDir: "mac", appDirCandidates: ["mac", "mac-x64"] },
  ].map((target) => ({
    ...target,
    taskRoot: join(buildRoot, target.arch),
    outputDir: join(buildRoot, target.arch, "output"),
    buildPlan: macArchitectureBuildPlan({
      baseBuilderArgs,
      arch: target.arch,
      version,
      deferNotarization: !syncNotarization,
    }),
  }));

  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(buildRoot, { recursive: true });
  const builderEnv = !syncNotarization ? { OPENGROVE_DEFER_NOTARIZATION: "1" } : {};
  await runParallelTasks(
    "macOS architecture build",
    targets.map((target) => ({
      id: target.arch,
      run: () => {
        const builderTempDir = join(target.taskRoot, "builder-tmp");
        // Per-arch cache: concurrent electron-builder downloads into a shared
        // cache can race; persistent so Electron is not re-downloaded per run.
        const builderCacheDir = join(projectRoot, ".opengrove", "desktop-release-cache", target.arch);
        mkdirSync(builderTempDir, { recursive: true });
        mkdirSync(builderCacheDir, { recursive: true });
        const invocation = nodePackageManagerInvocation("npx", target.buildPlan.builderArgs);
        return runCommand(invocation.command, invocation.args, {
          cwd: projectRoot,
          env: {
            ...process.env,
            ...builderEnv,
            APP_BUILDER_TMP_DIR: builderTempDir,
            ELECTRON_BUILDER_CACHE: builderCacheDir,
            OPENGROVE_DESKTOP_ARCH: target.arch,
            OPENGROVE_DESKTOP_OUTPUT_DIR: target.outputDir,
          },
        });
      },
    })),
  );

  const prepared = targets.map((target) => {
    const sourceAppDir = target.appDirCandidates
      .map((name) => join(target.outputDir, name))
      .find((path) => existsSync(join(path, "OpenGrove.app")));
    if (!sourceAppDir) {
      throw new Error(`Parallel ${target.arch} build did not produce OpenGrove.app in ${target.outputDir}`);
    }
    const artifactFiles = target.buildPlan.artifactFiles;
    const missing = artifactFiles.filter((file) => !existsSync(join(target.outputDir, file)));
    if (missing.length > 0) {
      throw new Error(`Parallel ${target.arch} build is incomplete: ${missing.join(", ")}`);
    }
    return { ...target, sourceAppDir, artifactFiles };
  });

  mkdirSync(releaseDir, { recursive: true });
  for (const target of prepared) {
    const destinationAppDir = join(releaseDir, target.finalAppDir);
    rmSync(destinationAppDir, { recursive: true, force: true });
    renameSync(target.sourceAppDir, destinationAppDir);
    for (const file of target.artifactFiles) {
      const destination = join(releaseDir, file);
      rmSync(destination, { force: true });
      renameSync(join(target.outputDir, file), destination);
    }
  }
  rmSync(buildRoot, { recursive: true, force: true });
  console.log("macOS architecture build: collected isolated arm64 and x64 outputs.");
}
