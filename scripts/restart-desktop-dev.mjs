import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isOpenGroveDevProcess, readOpenGroveDevProcessTable } from "./desktop-dev-processes.mjs";
import {
  desktopDevProfileEnvironment,
  desktopDevOpenEnvironmentArguments,
  desktopDevRuntimePaths,
  resolveDesktopDevProfileOptions,
  verifyDesktopDevProfileProbe,
} from "./desktop-dev-runtime.mjs";
import { createDesktopDevStartupMonitor, recoverStaleDesktopDevStateLocks } from "./desktop-dev-startup.mjs";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const devProfile = resolveDesktopDevProfileOptions(process.argv.slice(2));
const startedAt = Date.now();
// The first launch after rebuilding the shared, ad-hoc-signed macOS wrapper
// can spend extra time in LaunchServices validation. Successful probes still
// return immediately; this only avoids reporting a false failure on migration.
const DEV_STARTUP_PROBE_TIMEOUT_MS = 120_000;
const parentPid = readPositiveInteger(process.env.OPENGROVE_RESTART_PARENT_PID) ?? process.ppid;
const protectedPids = new Set([parentPid].filter((pid) => pid > 0));
const devRuntime = desktopDevRuntimePaths();
const devUserDataPath = devProfile?.userDataDir ?? devRuntime.userDataPath;

await waitForProtectedOpenGroveDevProcesses(protectedPids, devProfile);
await terminateOpenGroveDevProcesses(protectedPids, devProfile);
for (const recovered of recoverStaleDesktopDevStateLocks(devUserDataPath)) {
  console.warn(`Recovered stale OpenGrove Dev state lock for dead pid ${recovered.holder.pid}: ${recovered.lockPath}`);
}

let buildStartedAt = Date.now();
if (!skipBuild) {
  buildStartedAt = Date.now();
  const invocation = nodePackageManagerInvocation("npm", ["run", "build"]);
  await run(invocation.command, invocation.args);
}

const executableOutput = execFileSync(process.execPath, ["scripts/launch-desktop-dev.mjs", "--prepare-only"], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const executable =
  executableOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

const launchEnvironment = desktopLaunchEnv(devProfile);
const startupMonitor = createDesktopDevStartupMonitor(devUserDataPath);
let probe;
try {
  await launchDevApp(executable, launchEnvironment, devProfile);
  probe = await waitForOpenGroveProbe(buildStartedAt, startupMonitor, devProfile);
  verifyDesktopDevProfileProbe(devProfile, probe.body);
} catch (error) {
  await terminateOpenGroveDevProcesses(protectedPids, devProfile);
  throw error;
}

console.log(`OpenGrove Dev restarted`);
if (devProfile) {
  console.log(`Profile: ${devProfile.name}`);
  console.log(`WW auth: ${devProfile.wwBaseUrl}`);
  console.log(`App Store / Release Control: ${devProfile.releaseControlUrl}`);
  console.log(`User data: ${devProfile.userDataDir}`);
}
console.log(`Bridge: ${probe.url}`);
console.log(`PID: ${probe.body.pid ?? "unknown"}`);
console.log(`Started: ${probe.body.startedAt ?? "unknown"}`);
console.log(`room-delegation: ${probe.body.build?.modules?.roomDelegation?.mtime ?? "unknown"}`);

async function terminateOpenGroveDevProcesses(protectedProcessIds = new Set(), profile) {
  const targets = listTargetProcesses(protectedProcessIds, profile);
  if (!targets.length) return;

  for (const proc of targets) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }

  await waitForNoTargetProcesses(5_000, protectedProcessIds, profile);
  const remaining = listTargetProcesses(protectedProcessIds, profile);
  for (const proc of remaining) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
  await waitForNoTargetProcesses(5_000, protectedProcessIds, profile);
  const stillRunning = listTargetProcesses(protectedProcessIds, profile);
  if (stillRunning.length) {
    throw new Error(`Could not stop OpenGrove Dev processes: ${stillRunning.map((proc) => proc.pid).join(", ")}`);
  }
}

function listTargetProcesses(protectedProcessIds = new Set(), profile) {
  const output = readOpenGroveDevProcessTable();
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      return match ? { pid: Number(match[1]), command: match[2] } : undefined;
    })
    .filter((proc) => proc && Number.isFinite(proc.pid))
    .filter((proc) => proc.pid !== process.pid && !protectedProcessIds.has(proc.pid))
    .filter((proc) => isOpenGroveDevProcess(proc.command, projectRoot, profile?.name));
}

async function waitForNoTargetProcesses(timeoutMs, protectedProcessIds = new Set(), profile) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listTargetProcesses(protectedProcessIds, profile).length === 0) return;
    await delay(150);
  }
}

async function waitForProtectedOpenGroveDevProcesses(protectedProcessIds, profile) {
  const protectedTargets = () =>
    [...protectedProcessIds]
      .map((pid) => ({ pid, command: commandForPid(pid) }))
      .filter((proc) => proc.command && isOpenGroveDevProcess(proc.command, projectRoot, profile?.name));
  if (!protectedTargets().length) return;

  const gracefulDeadline = Date.now() + 15_000;
  while (Date.now() < gracefulDeadline) {
    if (!protectedTargets().length) return;
    await delay(150);
  }

  const remaining = protectedTargets();
  console.warn(
    `OpenGrove Dev parent process did not exit before relaunch: ${remaining.map((proc) => proc.pid).join(", ")}`,
  );
  for (const proc of remaining) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }

  const terminateDeadline = Date.now() + 3_000;
  while (Date.now() < terminateDeadline) {
    if (!protectedTargets().length) return;
    await delay(150);
  }

  for (const proc of protectedTargets()) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }

  const killDeadline = Date.now() + 3_000;
  while (Date.now() < killDeadline) {
    if (!protectedTargets().length) return;
    await delay(150);
  }

  const stillRunning = protectedTargets();
  if (stillRunning.length) {
    throw new Error(`Could not stop OpenGrove Dev parent process: ${stillRunning.map((proc) => proc.pid).join(", ")}`);
  }
}

function commandForPid(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function launchDevApp(executable, env, profile) {
  if (!existsSync(executable)) {
    throw new Error(`Desktop dev executable not found: ${executable}`);
  }

  if (process.platform === "darwin") {
    const appPath = appBundlePathForExecutable(executable);
    await run(
      "/usr/bin/open",
      ["-n", ...desktopDevOpenEnvironmentArguments(profile?.environmentOverrides), appPath, "--args", projectRoot],
      { env },
    );
    return;
  }

  const child = spawn(executable, [projectRoot], {
    cwd: projectRoot,
    detached: true,
    env,
    stdio: "ignore",
  });
  child.unref();
}

function desktopLaunchEnv(profile) {
  const env = desktopDevProfileEnvironment(process.env, profile);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENGROVE_RESTART_PARENT_PID;
  return env;
}

function appBundlePathForExecutable(executable) {
  const parts = resolve(executable).split(sep);
  const appIndex = parts.findIndex((part) => part.endsWith(".app"));
  if (appIndex < 0) {
    throw new Error(`Could not derive .app path from ${executable}`);
  }
  return parts.slice(0, appIndex + 1).join(sep) || sep;
}

async function waitForOpenGroveProbe(buildStartedAtMs, startupMonitor, profile) {
  const deadline = Date.now() + DEV_STARTUP_PROBE_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    const startupFailure = startupMonitor.readFailure();
    if (startupFailure) {
      throw new Error(`OpenGrove Dev startup failed: ${startupFailure}`);
    }
    for (const port of listeningPorts()) {
      try {
        const body = await fetchProbe(port);
        if (body?.ok !== true || body.product !== "OpenGrove") continue;
        if (typeof body.pid !== "number" || !body.startedAt || !body.build?.modules?.roomDelegation?.mtimeMs) {
          lastError = `probe on ${port} is missing restart metadata`;
          continue;
        }
        const started = Date.parse(String(body.startedAt ?? ""));
        if (Number.isFinite(started) && started < startedAt - 5_000) {
          lastError = `stale probe on ${port}: startedAt=${body.startedAt}`;
          continue;
        }
        const roomDelegationMtime = Number(body.build?.modules?.roomDelegation?.mtimeMs ?? 0);
        if (!skipBuild && roomDelegationMtime && roomDelegationMtime < buildStartedAtMs - 5_000) {
          lastError = `stale build on ${port}: room-delegation mtime ${body.build?.modules?.roomDelegation?.mtime}`;
          continue;
        }
        if (profile) {
          const expectedStatePath = join(profile.userDataDir, "data", "local-state.sqlite");
          if (!existsSync(expectedStatePath)) {
            lastError = `profile ${profile.name} state file is missing at ${expectedStatePath}`;
            continue;
          }
          const expectedStateId = createHash("sha256")
            .update(realpathSync.native(expectedStatePath))
            .digest("hex")
            .slice(0, 16);
          if (body.stateId !== expectedStateId) {
            lastError = `profile ${profile.name} started with unexpected stateId=${body.stateId ?? "missing"}`;
            continue;
          }
        }
        return { url: `http://127.0.0.1:${port}`, body };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(500);
  }
  const startupFailure = startupMonitor.readFailure();
  if (startupFailure) {
    throw new Error(`OpenGrove Dev startup failed: ${startupFailure}`);
  }
  throw new Error(`OpenGrove Dev probe timeout${lastError ? `: ${lastError}` : ""}`);
}

function listeningPorts() {
  try {
    const output = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ports = new Set();
    for (const line of output.split("\n")) {
      const match = /127\.0\.0\.1:(\d+)/.exec(line);
      if (match) ports.add(Number(match[1]));
    }
    return [...ports].filter((port) => Number.isFinite(port));
  } catch {
    return [37371];
  }
}

async function fetchProbe(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/opengrove-probe`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} ${commandArgs.join(" ")} failed: ${code ?? signal ?? "unknown"}`));
    });
    child.on("error", rejectRun);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
