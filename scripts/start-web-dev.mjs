import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const watchedRoots = [resolve(projectRoot, "src"), resolve(projectRoot, "packages", "agent-protocol", "src")];
const children = new Set();
const watchers = [];
let backend;
let frontend;
let rebuildTimer;
let rebuilding = false;
let rebuildPending = false;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await runBuild();
backend = startBackend();
frontend = startFrontend();

for (const root of watchedRoots) {
  watchers.push(
    watch(root, { recursive: true }, (_event, fileName) => {
      if (!fileName || !/\.(?:json|ts)$/u.test(fileName)) return;
      scheduleBackendRebuild();
    }),
  );
}

function startBackend() {
  const child = start(process.execPath, ["dist/cli.js", "web"], "Web backend");
  child.once("exit", (code, signal) => {
    if (stopping || rebuilding) return;
    console.error(`Web backend stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`);
    void shutdown(undefined, code ?? 1);
  });
  return child;
}

function startFrontend() {
  const child = start(process.execPath, ["scripts/start-web-frontend-dev.mjs"], "Vite frontend");
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`Vite frontend stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`);
    void shutdown(undefined, code ?? 1);
  });
  return child;
}

function start(command, args, label) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`${label} failed to start: ${error.message}`);
    void shutdown(undefined, 1);
  });
  child.once("exit", () => {
    children.delete(child);
  });
  return child;
}

function scheduleBackendRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    void rebuildBackend();
  }, 120);
}

async function rebuildBackend() {
  if (rebuilding) {
    rebuildPending = true;
    return;
  }
  rebuilding = true;
  try {
    console.log("\n[opengrove-dev] Server source changed; rebuilding Bridge...");
    await runBuild();
    await stopChild(backend);
    if (!stopping) backend = startBackend();
  } catch (error) {
    console.error(`[opengrove-dev] Bridge rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rebuilding = false;
    if (rebuildPending && !stopping) {
      rebuildPending = false;
      void rebuildBackend();
    }
  }
}

async function runBuild() {
  await new Promise((resolveBuild, rejectBuild) => {
    const invocation = nodePackageManagerInvocation("npm", ["run", "build:server"]);
    const child = start(invocation.command, invocation.args, "Server build");
    child.once("exit", (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(signal ? `signal ${signal}` : `exit ${code ?? 1}`));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function shutdown(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(rebuildTimer);
  for (const watcher of watchers) watcher.close();
  await Promise.all([...children].map(stopChild));
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = exitCode;
}
