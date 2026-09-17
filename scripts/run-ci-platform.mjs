import { nativePlatformTasks } from "./ci-harness-inventory.mjs";
import { runCiProcess } from "./ci-process.mjs";
import { runHarnessTasks } from "./run-built-harnesses.mjs";

if (!["win32", "darwin"].includes(process.platform)) throw new Error("Native platform checks require Windows or macOS");
const build = await runCiProcess(process.execPath, ["scripts/build-server.mjs"], {
  stdio: "inherit",
  timeoutMs: 300_000,
});
if (build.status !== 0 || build.timedOut || build.interrupted) throw new Error("Native platform build failed");
await runHarnessTasks(nativePlatformTasks(process.platform), `native-${process.platform}`);
