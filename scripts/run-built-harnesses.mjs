import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessGroups } from "./ci-harness-inventory.mjs";

export { harnessGroups } from "./ci-harness-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runGroup(groupName) {
  const tasks = harnessGroups[groupName];
  if (!tasks) {
    console.error(`Unknown harness group: ${groupName || "(missing)"}`);
    console.error(`Available groups: ${Object.keys(harnessGroups).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const missing = tasks.filter((task) => !existsSync(resolve(projectRoot, task.path)));
  if (missing.length) {
    console.error(`Harness group ${groupName} has missing built inputs:`);
    for (const task of missing) console.error(`- ${task.id}: ${task.path}`);
    process.exitCode = 2;
    return;
  }

  const failures = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    console.log(`[harness] START ${task.id}`);
    const cleanHomeRoot =
      task.isolation === "clean-home" ? mkdtempSync(join(tmpdir(), "opengrove-clean-home-")) : undefined;
    try {
      const result = spawnSync(process.execPath, [resolve(projectRoot, task.path)], {
        cwd: projectRoot,
        env: cleanHomeRoot ? cleanHomeEnvironment(cleanHomeRoot) : process.env,
        stdio: "inherit",
      });
      const durationMs = Date.now() - startedAt;
      if (result.status !== 0) {
        failures.push({
          id: task.id,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          durationMs,
        });
      } else {
        console.log(`[harness] PASS ${task.id} (${formatDuration(durationMs)})`);
      }
    } finally {
      if (cleanHomeRoot) rmSync(cleanHomeRoot, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.error("Harness failures:");
    for (const failure of failures) {
      console.error(
        `- ${failure.id} (${formatDuration(failure.durationMs)}): ${failure.error || failure.signal || `exit ${failure.status ?? "unknown"}`}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(`[harness] ${groupName} passed (${tasks.length}/${tasks.length})`);
  }
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function cleanHomeEnvironment(homeRoot) {
  return {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    XDG_CACHE_HOME: join(homeRoot, ".cache"),
    XDG_CONFIG_HOME: join(homeRoot, ".config"),
    XDG_DATA_HOME: join(homeRoot, ".local", "share"),
    XDG_STATE_HOME: join(homeRoot, ".local", "state"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGroup(process.argv[2]);
}
