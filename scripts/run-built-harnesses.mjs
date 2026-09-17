import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessGroups, harnessInventory, nativeTasks, harnessTasksForPlatform } from "./ci-harness-inventory.mjs";

import { runCiProcess } from "./ci-process.mjs";

export { harnessGroups } from "./ci-harness-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runHarnessTasks(tasks, groupName) {
  if (!tasks) {
    console.error(`Unknown harness group: ${groupName || "(missing)"}`);
    console.error(`Available groups: ${Object.keys(harnessGroups).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const selected = harnessTasksForPlatform(tasks, process.platform);
  const skipped = tasks.filter((task) => !selected.includes(task));
  for (const task of skipped) {
    console.log(
      `[harness] SKIP ${task.id} (runs on ${task.platforms.join(", ")}; current platform is ${process.platform})`,
    );
  }
  const missing = selected.filter(
    (task) =>
      !(task.path.startsWith("--")
        ? (task.args ?? []).every((path) => existsSync(resolve(projectRoot, path)))
        : existsSync(resolve(projectRoot, task.path))),
  );
  if (missing.length) {
    console.error(`Harness group ${groupName} has missing built inputs:`);
    for (const task of missing) console.error(`- ${task.id}: ${task.path}`);
    process.exitCode = 2;
    return;
  }

  const failures = [];
  const results = skipped.map((task) => ({ id: task.id, status: "skipped", reason: "platform" }));
  for (const task of selected) {
    const startedAt = Date.now();
    console.log(`[harness] START ${task.id}`);
    const cleanHomeRoot =
      task.isolation === "clean-home" ? mkdtempSync(join(tmpdir(), "opengrove-clean-home-")) : undefined;
    try {
      const result = await runCiProcess(
        process.execPath,
        [task.path.startsWith("--") ? task.path : resolve(projectRoot, task.path), ...(task.args ?? [])],
        {
          timeoutMs: task.timeoutMs,
          cwd: projectRoot,
          env: cleanHomeRoot ? cleanHomeEnvironment(cleanHomeRoot) : process.env,
          stdio: "inherit",
        },
      );
      const durationMs = Date.now() - startedAt;
      const passed = result.status === 0 && !result.timedOut && !result.interrupted;
      results.push({ id: task.id, ...result, passed });
      if (!passed) {
        failures.push({
          id: task.id,
          status: result.status,
          signal: result.signal,
          error: result.timedOut ? "timeout" : result.interrupted ? "cancelled" : result.error,
          durationMs,
        });
      } else {
        console.log(`[harness] PASS ${task.id} (${formatDuration(durationMs)})`);
      }
      if (result.interrupted) break;
    } finally {
      if (cleanHomeRoot) rmSync(cleanHomeRoot, { recursive: true, force: true });
    }
  }

  const reportPath = resolve(process.env.CI_TASK_REPORT ?? `test-results/ci/${groupName}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({ schemaVersion: 1, group: groupName, platform: process.platform, node: process.version, results }, null, 2)}\n`,
  );
  if (failures.length) {
    console.error("Harness failures:");
    for (const failure of failures) {
      console.error(
        `- ${failure.id} (${formatDuration(failure.durationMs)}): ${failure.error || failure.signal || `exit ${failure.status ?? "unknown"}`}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[harness] ${groupName} passed (${selected.length}/${selected.length}; ${skipped.length} platform-specific skipped)`,
    );
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
  const groupName = process.argv[2];
  const ids = groupName === "--tasks" ? (process.argv[3] ?? "").split(",") : null;
  const inventory = [...harnessInventory, ...nativeTasks];
  if (ids && (new Set(ids).size !== ids.length || ids.some((id) => !inventory.some((task) => task.id === id))))
    throw new Error("Unknown or duplicate CI task id");
  const tasks = ids ? ids.map((id) => inventory.find((task) => task.id === id)) : harnessGroups[groupName];
  await runHarnessTasks(tasks, ids ? "selected" : groupName);
}
