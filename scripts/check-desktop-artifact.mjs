import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopDistInventory,
  desktopPackageInventoryProblems,
  forbiddenDesktopRuntimePackagePrefixes,
  historicalDesktopRuntimeForbiddenPackagePrefixes,
  historicalDesktopRuntimePackageFiles,
  requiredDesktopRuntimePackageFiles,
} from "./desktop-package-inventory.mjs";
import { desktopAsarLookupPath, normalizeDesktopAsarPath } from "./desktop-asar-path.mjs";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";
import { readAsarPackageVersion } from "./asar-package-version.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const { listPackage, statFile } = require("@electron/asar");
const { load: loadYaml } = require("js-yaml");
const options = parseOptions(process.argv.slice(2));

for (const target of options.targets) {
  await verifyTarget(target, options);
}

async function verifyTarget(target, verificationOptions) {
  const historicalReplay = verificationOptions.expectedDistInventorySha256 !== undefined;
  const artifact = resolveDesktopArtifact(target, verificationOptions.releaseDir);
  const resourcesDir =
    target.platform === "darwin" ? join(artifact, "Contents", "Resources") : join(artifact, "resources");
  verifyPackageInventory(resourcesDir, target, verificationOptions);
  const enginePath = resolveEnginePath(resourcesDir, target);

  if (!enginePath) {
    fail(
      [
        `missing bundled Claude engine for ${target.platform}-${target.arch}`,
        `artifact: ${artifact}`,
        `searched under: ${join(resourcesDir, "app.asar.unpacked", "node_modules", "@anthropic-ai")}`,
      ].join("\n"),
    );
  }
  if (!historicalReplay) verifyAnthropicLicense(join(dirname(enginePath), "LICENSE.md"), target);

  const stats = statSync(enginePath);
  if (stats.size < 50_000_000) {
    fail(`bundled Claude engine is unexpectedly small (${stats.size} bytes): ${enginePath}`);
  }
  if (target.platform !== "win32" && (stats.mode & 0o111) === 0) {
    fail(`bundled Claude engine is not executable: ${enginePath}`);
  }

  if (!canExecuteTarget(target)) {
    console.log(`bundled Claude engine present for ${target.platform}-${target.arch}: ${enginePath}`);
    return;
  }

  await verifyPackagedBridge(artifact, resourcesDir, target);

  const tempHome = mkdtempSync(join(tmpdir(), "opengrove-desktop-artifact-"));
  try {
    const command = executionCommand(enginePath, target);
    const result = spawnSync(command.command, command.args, {
      encoding: "utf8",
      env: sanitizedEnv(tempHome, target),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: executionTimeoutMs(target),
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.error) {
      fail(`failed to execute bundled Claude engine: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`bundled Claude engine --version exited with ${result.status}: ${output}`);
    }
    if (!output.includes("(Claude Code)")) {
      fail(`bundled Claude engine --version did not look like Claude Code: ${output}`);
    }
    console.log(`bundled Claude engine verified for ${target.platform}-${target.arch}: ${enginePath} :: ${output}`);
  } finally {
    removeTemporaryTree(tempHome);
  }
}

function verifyAnthropicLicense(path, target) {
  if (!existsSync(path)) {
    fail(`bundled Claude engine license is missing for ${target.platform}-${target.arch}: ${path}`);
  }
  const license = readFileSync(path, "utf8");
  if (!license.includes("Anthropic PBC") || !license.includes("All rights reserved")) {
    fail(`bundled Claude engine license is unexpected for ${target.platform}-${target.arch}: ${path}`);
  }
}

function verifyPackageInventory(resourcesDir, target, verificationOptions) {
  const asarPath = join(resourcesDir, "app.asar");
  if (!existsSync(asarPath)) fail(`missing app.asar for ${target.platform}-${target.arch}: ${asarPath}`);
  const localSourceFiles = listFiles(join(projectRoot, "dist"), "dist").filter(
    (path) => !path.startsWith("dist/tests/") && !path.startsWith("dist/examples/") && !path.endsWith(".map"),
  );
  const packagedFiles = listPackage(asarPath)
    .filter((path) => !statFile(asarPath, desktopAsarLookupPath(path)).files)
    .map(normalizeDesktopAsarPath);
  const resourceFiles = readdirSync(resourcesDir, { withFileTypes: true }).map((entry) => entry.name);
  const appUpdatePath = join(resourcesDir, "app-update.yml");
  const appUpdateConfig = existsSync(appUpdatePath) ? loadYaml(readFileSync(appUpdatePath, "utf8")) : undefined;
  const historicalReplay = verificationOptions.expectedDistInventorySha256 !== undefined;
  const sourceFiles = historicalReplay ? packagedFiles.filter((path) => path.startsWith("dist/")) : localSourceFiles;
  const problems = desktopPackageInventoryProblems({
    sourceFiles,
    packagedFiles,
    resourceFiles,
    appUpdateConfig,
    requiredPackageFiles: historicalReplay ? historicalDesktopRuntimePackageFiles : requiredDesktopRuntimePackageFiles,
    forbiddenPackagePrefixes: historicalReplay
      ? historicalDesktopRuntimeForbiddenPackagePrefixes
      : forbiddenDesktopRuntimePackagePrefixes,
  });
  if (problems.length > 0) fail(`${target.platform}-${target.arch} package inventory failed:\n${problems.join("\n")}`);
  const inventory = desktopDistInventory(packagedFiles);
  if (
    historicalReplay &&
    (inventory.sha256 !== verificationOptions.expectedDistInventorySha256 ||
      inventory.fileCount !== verificationOptions.expectedDistFileCount)
  ) {
    fail(
      [
        `${target.platform}-${target.arch} historical dist inventory does not match the pinned baseline`,
        `expected: ${verificationOptions.expectedDistFileCount} files / ${verificationOptions.expectedDistInventorySha256}`,
        `actual: ${inventory.fileCount} files / ${inventory.sha256}`,
      ].join("\n"),
    );
  }
  if (verificationOptions.expectedAppVersion !== undefined) {
    const appVersion = readAsarPackageVersion(asarPath);
    if (appVersion !== verificationOptions.expectedAppVersion) {
      fail(
        `${target.platform}-${target.arch} app.asar version is ${appVersion}; expected ${verificationOptions.expectedAppVersion}`,
      );
    }
  }
  const targetId =
    target.platform === "darwin"
      ? `mac-${target.arch}`
      : target.platform === "win32"
        ? `windows-${target.arch}`
        : `linux-${target.arch}`;
  const evidencePath = join(verificationOptions.releaseDir, "release-gates", targetId, "package_inventory.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: "package_inventory",
        passed: true,
        target: targetId,
        sourceFileCount: sourceFiles.length,
        packagedFileCount: inventory.fileCount,
        packagedDistInventorySha256: inventory.sha256,
        appUpdate: appUpdateConfig,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `desktop package inventory verified for ${target.platform}-${target.arch}: ${inventory.fileCount} compiled runtime files`,
  );
}

async function verifyPackagedBridge(artifact, resourcesDir, target) {
  const executableCandidates =
    target.platform === "darwin"
      ? [join(artifact, "Contents", "MacOS", "OpenGrove")]
      : target.platform === "win32"
        ? [join(artifact, "OpenGrove.exe")]
        : [join(artifact, "opengrove"), join(artifact, "OpenGrove")];
  const executable = executableCandidates.find((candidate) => existsSync(candidate));
  if (!executable) fail(`desktop executable is missing; checked:\n${executableCandidates.join("\n")}`);
  const entry = join(resourcesDir, "app.asar", "dist", "server", "desktop-bridge-entry.js");
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-packaged-bridge-"));
  const token = "packaged-release-smoke-token";
  let child;
  let stdout = "";
  let stderr = "";
  try {
    child = fork(entry, [], {
      cwd: resourcesDir,
      execPath: executable,
      execArgv: ["--max-old-space-size=4096"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENGROVE_DATA_DIR: join(tempRoot, "data"),
        OPENGROVE_LOG_DIR: join(tempRoot, "logs"),
        OPENGROVE_DIAGNOSTICS_DIR: join(tempRoot, "diagnostics"),
        OPENGROVE_STATE_PATH: join(tempRoot, "data", "local-state.sqlite"),
        OPENGROVE_BRIDGE_SETTINGS_PATH: join(tempRoot, "data", "bridge-settings.json"),
        OPENGROVE_BRIDGE_TOKEN: token,
        OPENGROVE_BRIDGE_HOST: "127.0.0.1",
        OPENGROVE_BRIDGE_PORT: "0",
        OPENGROVE_WEB_AUTH_MODE: "bridge-token",
        OPENGROVE_WW_BASE_URL: "",
      },
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const ready = await waitForBridgeReady(child, () => `${stdout}\n${stderr}`);
    const health = await fetch(`${ready.apiBase}/health`, {
      headers: { "x-opengrove-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) fail(`packaged Bridge health check failed: HTTP ${health.status}`);
    child.send({ type: "opengrove.desktop.bridge.shutdown" });
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("packaged Bridge shutdown timed out")), 10_000)),
    ]);
    if (code !== 0) fail(`packaged Bridge exited with ${code ?? signal}: ${stderr || stdout}`);
    console.log(`packaged Bridge startup verified for ${target.platform}-${target.arch}: ${ready.apiBase}`);
  } catch (error) {
    fail(
      `packaged Bridge startup failed for ${target.platform}-${target.arch}: ${error instanceof Error ? error.message : String(error)}\n${stderr || stdout}`,
    );
  } finally {
    if (child && child.exitCode === null) child.kill();
    removeTemporaryTree(tempRoot);
  }
}

function waitForBridgeReady(child, output) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`timed out waiting for packaged Bridge readiness\n${output()}`)),
      45_000,
    );
    child.on("message", (message) => {
      if (message?.type !== "opengrove.desktop.bridge.ready") return;
      clearTimeout(timer);
      resolveReady(message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`packaged Bridge exited before readiness: ${code ?? signal}\n${output()}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
}

function listFiles(root, prefix) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(path, relativePath));
    else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
  }
  return files;
}

function parseOptions(args) {
  const values = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--target") {
      values.push(readRequired(args, ++index, value));
    } else if (value.startsWith("--target=")) {
      values.push(value.slice("--target=".length));
    } else if (value === "--expected-dist-inventory-sha256") {
      options.expectedDistInventorySha256 = readRequired(args, ++index, value);
    } else if (value.startsWith("--expected-dist-inventory-sha256=")) {
      options.expectedDistInventorySha256 = value.slice("--expected-dist-inventory-sha256=".length);
    } else if (value === "--expected-dist-file-count") {
      options.expectedDistFileCount = Number(readRequired(args, ++index, value));
    } else if (value.startsWith("--expected-dist-file-count=")) {
      options.expectedDistFileCount = Number(value.slice("--expected-dist-file-count=".length));
    } else if (value === "--expected-app-version") {
      options.expectedAppVersion = readRequired(args, ++index, value);
    } else if (value.startsWith("--expected-app-version=")) {
      options.expectedAppVersion = value.slice("--expected-app-version=".length);
    } else if (value === "--release-dir") {
      options.releaseDir = resolve(readRequired(args, ++index, value));
    } else if (value.startsWith("--release-dir=")) {
      options.releaseDir = resolve(value.slice("--release-dir=".length));
    } else {
      throw new Error(`Unknown check-desktop-artifact option: ${value}`);
    }
  }
  const hasInventoryHash = options.expectedDistInventorySha256 !== undefined;
  const hasInventoryCount = options.expectedDistFileCount !== undefined;
  if (hasInventoryHash !== hasInventoryCount) {
    throw new Error("historical replay requires both --expected-dist-inventory-sha256 and --expected-dist-file-count");
  }
  if (hasInventoryHash && !/^[a-f0-9]{64}$/.test(options.expectedDistInventorySha256)) {
    throw new Error("--expected-dist-inventory-sha256 must be a lowercase SHA-256 digest");
  }
  if (hasInventoryCount && (!Number.isInteger(options.expectedDistFileCount) || options.expectedDistFileCount < 1)) {
    throw new Error("--expected-dist-file-count must be a positive integer");
  }
  return {
    ...options,
    releaseDir: options.releaseDir ?? join(projectRoot, "release", "desktop"),
    targets: (values.length ? values : [`${process.platform}-${process.arch}`]).map(normalizeTarget),
  };
}

function normalizeTarget(value) {
  const match = /^(darwin|mac|macos|win32|windows|win|linux)[-_](x64|arm64)$/.exec(value.trim().toLowerCase());
  if (!match) throw new Error(`Invalid desktop artifact target: ${value}`);
  const platform =
    match[1] === "mac" || match[1] === "macos"
      ? "darwin"
      : match[1] === "windows" || match[1] === "win"
        ? "win32"
        : match[1];
  return { platform, arch: match[2] };
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function resolveDesktopArtifact(target, releaseDir) {
  const candidates =
    target.platform === "darwin"
      ? [
          join(releaseDir, `mac-${target.arch}`, "OpenGrove.app"),
          target.arch === "x64" ? join(releaseDir, "mac", "OpenGrove.app") : "",
        ].filter(Boolean)
      : target.platform === "win32"
        ? [join(releaseDir, "win-unpacked")]
        : [join(releaseDir, `linux-${target.arch}-unpacked`), join(releaseDir, "linux-unpacked")];
  const artifactPath = candidates.find((candidate) => existsSync(candidate));
  if (!artifactPath) {
    fail(`desktop artifact was not found for ${target.platform}-${target.arch}. Checked:\n${candidates.join("\n")}`);
  }
  return artifactPath;
}

function resolveEnginePath(resourcesDir, target) {
  return engineCandidates(resourcesDir, target).find((candidate) => existsSync(candidate));
}

function engineCandidates(resourcesDir, target) {
  const binaryName = target.platform === "win32" ? "claude.exe" : "claude";
  const packageNames =
    target.platform === "linux"
      ? [`claude-agent-sdk-linux-${target.arch}-musl`, `claude-agent-sdk-linux-${target.arch}`]
      : [`claude-agent-sdk-${target.platform}-${target.arch}`];
  return packageNames.map((packageName) =>
    join(resourcesDir, "app.asar.unpacked", "node_modules", "@anthropic-ai", packageName, binaryName),
  );
}

function canExecuteTarget(target) {
  if (target.platform !== process.platform) return false;
  if (target.arch === process.arch) return true;
  return (
    target.platform === "darwin" &&
    process.arch === "arm64" &&
    target.arch === "x64" &&
    process.env.OPENGROVE_CHECK_TRANSLATED_ENGINES === "1"
  );
}

function executionCommand(enginePath, target) {
  if (target.platform === "darwin" && process.arch === "arm64" && target.arch === "x64") {
    return { command: "/usr/bin/arch", args: ["-x86_64", enginePath, "--version"] };
  }
  return { command: enginePath, args: ["--version"] };
}

function executionTimeoutMs(target) {
  const override = process.env.OPENGROVE_DESKTOP_ARTIFACT_CHECK_TIMEOUT_MS;
  if (override) {
    const value = Number(override);
    if (!Number.isFinite(value) || value <= 0) {
      fail(`OPENGROVE_DESKTOP_ARTIFACT_CHECK_TIMEOUT_MS must be a positive number, got: ${override}`);
    }
    return value;
  }
  return target.platform === "darwin" && process.arch === "arm64" && target.arch === "x64" ? 60_000 : 20_000;
}

function sanitizedEnv(home, target) {
  if (target.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return {
      Path: `${systemRoot}\\System32;${systemRoot}`,
      SystemRoot: systemRoot,
      TEMP: home,
      TMP: home,
      USERPROFILE: home,
    };
  }
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: home,
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
