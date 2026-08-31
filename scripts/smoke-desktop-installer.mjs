import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { desktopReleaseTargets } from "./desktop-release-targets.mjs";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";
import { seedWindowsInstallerFirewallState } from "./windows-installer-gate-state.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const target = desktopReleaseTargets(packageJson.version).find((item) => item.id === args.target);
if (!target) throw new Error(`unknown or missing --target: ${args.target ?? ""}`);
if (target.buildPlatform !== process.platform) {
  throw new Error(`${target.id} installer smoke must run on ${target.buildPlatform}, not ${process.platform}`);
}
assertExecutableArchitecture(target);

const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const installerPath = resolve(args.installer ?? join(releaseDir, target.installerFile));
if (!existsSync(installerPath)) throw new Error(`final installer is missing: ${installerPath}`);
const expectedVersion = args.expectedVersion ?? packageJson.version;
const tempRoot = mkdtempSync(join(tmpdir(), `opengrove-final-smoke-${target.id}-`));
const evidenceOut = resolve(
  args.evidenceOut ?? join(releaseDir, "release-gates", target.id, "final_artifact_smoke.json"),
);
let mounted = false;
let installedRoot;
let desktopProcess;
let windowsFirewallState;
let windowsInstallerMode;
const processLog = [];
const startedAt = new Date().toISOString();

try {
  const executablePath =
    target.platform === "mac" ? prepareMacApplication(installerPath) : prepareWindowsApplication(installerPath);
  if (args.appOut) copyPreparedApplication(target, resolve(args.appOut));
  const ww = await startFakeWw();
  try {
    const environment = isolatedEnvironment(tempRoot, ww.baseUrl);
    desktopProcess = spawn(executablePath, [], {
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    captureProcessOutput(desktopProcess.stdout, "stdout");
    captureProcessOutput(desktopProcess.stderr, "stderr");
    let result;
    if (args.legacyProcessOnly) {
      await delay(args.survivalMs);
      assertProcessSurvived(desktopProcess, "legacy startup window");
    } else {
      result = await waitForReadyReceipt(
        join(environment.OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR, "release-gate-ready.json"),
        desktopProcess,
        90_000,
      );
      if (
        result.title !== "OpenGrove" ||
        result.desktopMarker !== "true" ||
        result.version !== expectedVersion ||
        result.healthStatus !== 200 ||
        result.health?.ok !== true ||
        result.health?.name !== "opengrove-local-bridge"
      ) {
        throw new Error(`renderer/Bridge assertion failed: ${JSON.stringify(result)}`);
      }
      await delay(args.survivalMs);
      assertProcessSurvived(desktopProcess, "survival window");
    }
    writeEvidence(evidenceOut, {
      schemaVersion: 1,
      gate: "final_artifact_smoke",
      passed: true,
      target: target.id,
      installer: basename(installerPath),
      installerSize: statSync(installerPath).size,
      appVersion: result?.version ?? expectedVersion,
      ...(result ? { title: result.title, healthStatus: result.healthStatus } : { legacyProcessOnly: true }),
      ...(windowsInstallerMode ? { windowsInstallerMode } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    console.log(
      `smoke-desktop-installer: ${target.id} launched from the final installer and survived ${args.survivalMs}ms.`,
    );
  } finally {
    await stopDesktopProcess(desktopProcess);
    await ww.close();
  }
} catch (error) {
  const failureDir = dirname(evidenceOut);
  mkdirSync(failureDir, { recursive: true });
  writeFileSync(join(failureDir, "final-artifact-smoke.log"), `${processLog.join("\n")}\n`);
  copyRuntimeLogs(failureDir);
  throw error;
} finally {
  try {
    if (mounted) spawnSync("hdiutil", ["detach", join(tempRoot, "mount"), "-force"], { stdio: "ignore" });
    if (installedRoot && windowsInstallerMode === "elevated-firewall-provisioned")
      uninstallWindowsApplication(installedRoot);
    windowsFirewallState?.restore();
  } finally {
    removeTemporaryTree(tempRoot);
  }
}

function prepareMacApplication(dmgPath) {
  const mountPoint = join(tempRoot, "mount");
  mkdirSync(mountPoint);
  execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath], { stdio: "pipe" });
  mounted = true;
  const sourceApp = join(mountPoint, "OpenGrove.app");
  if (!existsSync(sourceApp)) throw new Error(`DMG does not contain OpenGrove.app: ${dmgPath}`);
  const copiedApp = join(tempRoot, "OpenGrove.app");
  execFileSync("ditto", [sourceApp, copiedApp], { stdio: "pipe" });
  return join(copiedApp, "Contents", "MacOS", "OpenGrove");
}

function prepareWindowsApplication(installerPath) {
  const installTimeoutMs = 300_000;
  const directRoot = join(tempRoot, "direct-install");
  mkdirSync(directRoot);
  const direct = runSilentWindowsInstaller(installerPath, directRoot, installTimeoutMs);
  if (!direct.error && direct.status === 0) {
    installedRoot = directRoot;
    windowsInstallerMode = "elevated-firewall-provisioned";
  } else if (!direct.error && direct.status === 2) {
    // Hosted runners intentionally have no interactive UAC desktop. Verify
    // that an unelevated unattended install fails closed, then exercise the
    // installer's idempotent path that represents an administrator-prepared
    // firewall rule. The public installer itself receives no bypass flag.
    installedRoot = join(tempRoot, "installed");
    mkdirSync(installedRoot);
    windowsFirewallState = seedWindowsInstallerFirewallState(installedRoot);
    const provisioned = runSilentWindowsInstaller(installerPath, installedRoot, installTimeoutMs);
    if (provisioned.error || provisioned.status !== 0)
      throw silentWindowsInstallError(installerPath, provisioned, installTimeoutMs, "preprovisioned");
    windowsInstallerMode = "unelevated-fail-closed+preprovisioned-idempotent";
  } else {
    throw silentWindowsInstallError(installerPath, direct, installTimeoutMs, "direct");
  }
  const executable = findFile(installedRoot, "OpenGrove.exe");
  if (!executable) throw new Error(`installed OpenGrove.exe was not found below ${installedRoot}`);
  return executable;
}

function runSilentWindowsInstaller(installerPath, root, timeout) {
  return spawnSync(installerPath, ["/S", `/D=${root}`], { encoding: "utf8", timeout });
}

function silentWindowsInstallError(installerPath, result, timeout, mode) {
  const detail = result.error?.message || result.stderr?.trim() || `exit status ${result.status}`;
  return new Error(
    `silent NSIS ${mode} install failed (${timeout}ms limit, ${statSync(installerPath).size} bytes): ${detail}`,
  );
}

function uninstallWindowsApplication(root) {
  const uninstaller = findFile(root, "Uninstall OpenGrove.exe") || findFile(root, "Uninstall.exe");
  if (uninstaller) spawnSync(uninstaller, ["/S"], { stdio: "ignore", timeout: 60_000 });
}

function copyPreparedApplication(value, outputPath) {
  if (existsSync(outputPath)) throw new Error(`--app-out must not already exist: ${outputPath}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const sourcePath = value.platform === "mac" ? join(tempRoot, "OpenGrove.app") : installedRoot;
  if (value.platform === "mac") {
    // Electron Framework uses a relative symlink tree inside the app bundle.
    // ditto preserves that tree and signing metadata; fs.cp can rewrite links
    // to the temporary source, which breaks after the smoke cleanup removes it.
    execFileSync("ditto", [sourcePath, outputPath], { stdio: "pipe" });
  } else {
    cpSync(sourcePath, outputPath, { recursive: true, errorOnExist: true, force: false });
  }
}

function findFile(root, name) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function isolatedEnvironment(root, wwBaseUrl) {
  const common = {
    ...process.env,
    OPENGROVE_DESKTOP_RELEASE_GATE: "1",
    OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR: join(root, "user-data"),
    OPENGROVE_WW_BASE_URL: wwBaseUrl,
  };
  if (process.platform === "win32") {
    const roaming = join(root, "AppData", "Roaming");
    const local = join(root, "AppData", "Local");
    const temporary = join(root, "tmp");
    mkdirSync(roaming, { recursive: true });
    mkdirSync(local, { recursive: true });
    mkdirSync(temporary, { recursive: true });
    return { ...common, USERPROFILE: root, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary };
  }
  const temporary = join(root, "tmp");
  mkdirSync(temporary, { recursive: true });
  return { ...common, HOME: root, TMPDIR: temporary };
}

async function startFakeWw() {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/v1/client/latest-version" ? 401 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: 110201, message: "smoke fixture" } }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

function assertExecutableArchitecture(value) {
  if (value.arch === process.arch) return;
  if (process.platform === "darwin" && process.arch === "arm64" && value.arch === "x64") {
    const rosetta = spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
    if (rosetta.status === 0) return;
    throw new Error("x64 final installer smoke requires Rosetta on this arm64 runner");
  }
  throw new Error(`${value.id} cannot execute on ${process.platform}-${process.arch}; use a matching release runner`);
}

function writeEvidence(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function captureProcessOutput(stream, label) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/u)) {
      if (line) processLog.push(`[${label}] ${line}`);
    }
  });
}

function assertProcessSurvived(child, windowName) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`desktop exited during ${windowName} with code=${child.exitCode} signal=${child.signalCode}`);
  }
}

async function waitForReadyReceipt(path, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // The packaged app may still be completing its small synchronous write.
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`desktop exited before its ready receipt with code=${child.exitCode} signal=${child.signalCode}`);
    }
    await delay(250);
  }
  throw new Error(`desktop did not write its ready receipt within ${timeoutMs}ms: ${path}`);
}

async function stopDesktopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.exitCode === null && child.signalCode === null && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function copyRuntimeLogs(failureDir) {
  const path = join(tempRoot, "user-data", "logs");
  if (existsSync(path)) cpSync(path, join(failureDir, "final-artifact-runtime-logs"), { recursive: true });
}

function parseArgs(values) {
  const result = { survivalMs: 20_000 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--target") result.target = readRequired(values, ++index, value);
    else if (value.startsWith("--target=")) result.target = value.slice("--target=".length);
    else if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--installer") result.installer = readRequired(values, ++index, value);
    else if (value.startsWith("--installer=")) result.installer = value.slice("--installer=".length);
    else if (value === "--expected-version") result.expectedVersion = readRequired(values, ++index, value);
    else if (value.startsWith("--expected-version="))
      result.expectedVersion = value.slice("--expected-version=".length);
    else if (value === "--app-out") result.appOut = readRequired(values, ++index, value);
    else if (value.startsWith("--app-out=")) result.appOut = value.slice("--app-out=".length);
    else if (value === "--evidence-out") result.evidenceOut = readRequired(values, ++index, value);
    else if (value.startsWith("--evidence-out=")) result.evidenceOut = value.slice("--evidence-out=".length);
    else if (value === "--survival-ms") result.survivalMs = Number(readRequired(values, ++index, value));
    else if (value === "--legacy-process-only") result.legacyProcessOnly = true;
    else throw new Error(`Unknown smoke-desktop-installer option: ${value}`);
  }
  if (!Number.isFinite(result.survivalMs) || result.survivalMs < 5_000)
    throw new Error("--survival-ms must be at least 5000");
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
