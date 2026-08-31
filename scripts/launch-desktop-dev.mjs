import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopDevBootstrapSource,
  desktopDevExecutableLauncherSource,
  desktopDevRuntimePaths,
  DEV_APP_NAME,
  DEV_APP_VERSION,
  DEV_BUNDLE_ID,
  DEV_EXECUTABLE_FILE,
  DEV_ICON_FILE,
  DEV_URL_SCHEME,
  isLegacyDesktopDevAppPath,
  parseLaunchServicesDevAppPaths,
} from "./desktop-dev-runtime.mjs";

const LAUNCH_SERVICES =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const { createPackage } = require("@electron/asar");
const electronExecutable = String(require("electron"));
const appArgs = process.argv.slice(2);
const prepareOnly = removeFlag(appArgs, "--prepare-only");

const launchTarget = process.platform === "darwin" ? await prepareMacDevApp(electronExecutable) : electronExecutable;

if (prepareOnly) {
  console.log(launchTarget);
  process.exit(0);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(launchTarget, appArgs.length ? appArgs : ["."], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(
    "Could not launch OpenGrove Dev. Another worktree may be replacing the shared Dev app; retry the command.",
  );
  console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

async function prepareMacDevApp(executablePath) {
  const sourceApp = findAppBundle(executablePath);
  const sourceInfoPath = join(sourceApp, "Contents", "Info.plist");
  const electronVersion = plistValue(sourceInfoPath, "CFBundleShortVersionString") || "unknown";
  const runtime = desktopDevRuntimePaths();
  const sourceIcon = join(projectRoot, "build", DEV_ICON_FILE);
  const targetRoot = dirname(runtime.appPath);
  const marker = {
    version: DEV_APP_VERSION,
    electronVersion,
    bundleIdentifier: DEV_BUNDLE_ID,
    appName: DEV_APP_NAME,
    architecture: process.arch,
    iconHash: fileHash(sourceIcon),
  };
  let rebuilt = false;

  if (
    !isPrepared(runtime.appPath, runtime.executablePath, runtime.electronExecutablePath, runtime.markerPath, marker)
  ) {
    const temporaryApp = join(targetRoot, `.${DEV_APP_NAME}.${process.pid}.app`);
    rmSync(temporaryApp, { recursive: true, force: true });
    mkdirSync(targetRoot, { recursive: true });
    try {
      execFileSync("/usr/bin/ditto", [sourceApp, temporaryApp], { stdio: "inherit" });
      installDevIcon(temporaryApp, sourceIcon);
      installDevExecutableLauncher(temporaryApp);
      rewriteInfoPlist(join(temporaryApp, "Contents", "Info.plist"));
      await installBareLaunchBootstrap(temporaryApp, runtime.activeProjectPath);
      writeFileSync(
        join(temporaryApp, "Contents", "Resources", "opengrove-dev-electron.json"),
        `${JSON.stringify(marker, null, 2)}\n`,
      );
      signApp(temporaryApp);
      // Concurrent worktrees are intentionally last-writer-wins. Both build a
      // complete app before this small replacement window; a launch that lands
      // inside the window gets the retryable error above.
      rmSync(runtime.appPath, { recursive: true, force: true });
      renameSync(temporaryApp, runtime.appPath);
      rebuilt = true;
    } finally {
      rmSync(temporaryApp, { recursive: true, force: true });
    }
  }

  writeActiveProject(runtime.activeProjectPath);
  if (rebuilt) {
    retireLegacyMacDevRegistrations(runtime.appPath);
  }
  registerMacDevApp(runtime.appPath);
  return runtime.executablePath;
}

function isPrepared(targetApp, targetExecutable, electronExecutable, markerPath, marker) {
  if (!existsSync(targetExecutable) || !existsSync(electronExecutable) || !existsSync(markerPath)) return false;
  try {
    if (JSON.stringify(JSON.parse(readFileSync(markerPath, "utf8"))) !== JSON.stringify(marker)) return false;
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetApp], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function rewriteInfoPlist(infoPath) {
  const replacements = [
    ["CFBundleIdentifier", DEV_BUNDLE_ID],
    ["CFBundleName", DEV_APP_NAME],
    ["CFBundleDisplayName", DEV_APP_NAME],
    ["CFBundleIconFile", DEV_ICON_FILE],
    ["CFBundleExecutable", DEV_EXECUTABLE_FILE],
    ["LSApplicationCategoryType", "public.app-category.productivity"],
    [
      "NSAppleEventsUsageDescription",
      "OpenGrove Dev accepts Apple Events so development tools can identify and capture its window.",
    ],
  ];
  for (const [key, value] of replacements) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, infoPath]);
  }
  const urlTypes = JSON.stringify([
    {
      CFBundleTypeRole: "Viewer",
      CFBundleURLName: "OpenGrove Dev",
      CFBundleURLSchemes: [DEV_URL_SCHEME],
    },
  ]);
  try {
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleURLTypes", "-json", urlTypes, infoPath], {
      stdio: "ignore",
    });
  } catch {
    execFileSync("/usr/bin/plutil", ["-insert", "CFBundleURLTypes", "-json", urlTypes, infoPath]);
  }
}

function installDevIcon(appPath, sourceIcon) {
  if (!existsSync(sourceIcon)) {
    throw new Error(`OpenGrove desktop icon not found: ${sourceIcon}`);
  }
  copyFileSync(sourceIcon, join(appPath, "Contents", "Resources", DEV_ICON_FILE));
}

function installDevExecutableLauncher(appPath) {
  writeFileSync(join(appPath, "Contents", "MacOS", DEV_EXECUTABLE_FILE), desktopDevExecutableLauncherSource(), {
    mode: 0o755,
  });
}

async function installBareLaunchBootstrap(appPath, activeProjectPath) {
  const sourceDir = mkdtempSync(join(tmpdir(), "opengrove-dev-bootstrap-"));
  const targetAsar = join(appPath, "Contents", "Resources", "default_app.asar");
  try {
    writeFileSync(
      join(sourceDir, "package.json"),
      `${JSON.stringify(
        {
          name: "opengrove-dev-bootstrap",
          version: "1.0.0",
          main: "main.cjs",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(sourceDir, "main.cjs"), desktopDevBootstrapSource(activeProjectPath));
    rmSync(targetAsar, { recursive: true, force: true });
    await createPackage(sourceDir, targetAsar);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
}

function writeActiveProject(activeProjectPath) {
  const temporaryPath = `${activeProjectPath}.${process.pid}.tmp`;
  mkdirSync(dirname(activeProjectPath), { recursive: true });
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(
      {
        version: 1,
        projectRoot,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  renameSync(temporaryPath, activeProjectPath);
}

function retireLegacyMacDevRegistrations(canonicalAppPath) {
  let output = "";
  try {
    output = execFileSync(LAUNCH_SERVICES, ["-dump"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return;
  }

  for (const appPath of parseLaunchServicesDevAppPaths(output)) {
    if (!isLegacyDesktopDevAppPath(appPath, canonicalAppPath)) continue;
    try {
      execFileSync(LAUNCH_SERVICES, ["-u", appPath], { stdio: "ignore" });
    } catch {
      // Stale LaunchServices entries can point to worktrees that no longer exist.
    }
  }
}

function registerMacDevApp(appPath) {
  try {
    execFileSync(LAUNCH_SERVICES, ["-f", appPath], { stdio: "ignore" });
  } catch {
    // Direct-path launching still works if LaunchServices is unavailable.
    console.warn(`Could not register ${DEV_APP_NAME} with macOS LaunchServices.`);
  }
}

function signApp(appPath) {
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}

function fileHash(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`OpenGrove desktop icon not found: ${filePath}`);
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function findAppBundle(executablePath) {
  const parts = resolve(executablePath).split(sep);
  const appIndex = parts.findIndex((part) => part.endsWith(".app"));
  if (appIndex === -1) {
    throw new Error(`Could not find Electron .app bundle for ${executablePath}`);
  }
  return parts.slice(0, appIndex + 1).join(sep) || sep;
}

function plistValue(infoPath, key) {
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPath], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function removeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}
