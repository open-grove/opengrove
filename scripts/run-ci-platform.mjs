import { spawnSync } from "node:child_process";
import { harnessGroups, harnessTasksForPlatform } from "./ci-harness-inventory.mjs";

if (!["win32", "darwin"].includes(process.platform)) throw new Error("Native platform checks require Windows or macOS");
const commands = [
  ["scripts/build-server.mjs"],
  ["scripts/test-desktop-rebuildable-cleanup.mjs"],
  ["scripts/run-built-harnesses.mjs", "integration"],
];
if (process.platform === "win32") {
  commands.push(
    [
      "--test",
      "dist/tests/codex-windows-discovery.test.js",
      "dist/tests/windows-discovery-cache.test.js",
      "dist/tests/windows-command-probe.test.js",
      "dist/tests/windows-system-terminal.test.js",
    ],
    ["dist/tests/kernel-login-harness.js"],
    ["scripts/test-desktop-state-lock-recovery.mjs"],
    ["scripts/test-state-ownership.mjs"],
    ["scripts/test-bridge-supervisor-lifecycle.mjs"],
    ["scripts/test-process-started-at.mjs"],
    ["dist/tests/state-file-lock-harness.js"],
    ["dist/tests/sqlite-state-store-harness.js"],
    ["scripts/test-desktop-bridge.mjs"],
    ["dist/tests/app-store-harness.js"],
    ["dist/tests/app-version-activation-harness.js"],
  );
}
const covered = new Set(
  harnessTasksForPlatform(harnessGroups.integration, process.platform)
    .filter((task) => !task.isolation)
    .map((task) => task.path),
);
const failures = [];
for (const args of commands) {
  if (covered.has(args[0])) continue;
  console.log(`[platform] ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) {
    failures.push(args.join(" "));
    if (args[0] === "scripts/build-server.mjs") break;
  }
}
if (failures.length) throw new Error(`Native platform checks failed:\n${failures.join("\n")}`);
