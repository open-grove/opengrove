import { spawn, spawnSync } from "node:child_process";

// Each test owns a process group. A timeout/cancellation must not leave its
// Bridge or fake runtime alive to interfere with the following test.
export async function runCiProcess(command, args, { timeoutMs = 300_000, ...options } = {}) {
  const startedAt = Date.now();
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  let timedOut = false;
  let interrupted = false;
  let escalation;
  const killTree = (force = false) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      if (result.error) console.warn(`[ci-cleanup] taskkill: ${result.error.code}`);
    } else {
      try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") console.warn(`[ci-cleanup] process group: ${error.code}`);
      }
    }
  };
  const stop = () => {
    killTree();
    escalation ??= setTimeout(() => killTree(true), 1_000);
  };
  const cancel = () => {
    interrupted = true;
    stop();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  try {
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ status: null, signal: null, error: error.code ?? "spawn_failed" }));
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    return { ...result, timedOut, interrupted, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    killTree(true);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
