import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(projectRoot, "release", "desktop");
const targetDirs =
  process.platform === "darwin"
    ? [`mac-${process.arch}`]
    : process.platform === "win32"
      ? ["win-unpacked", `win-${process.arch}-unpacked`]
      : ["linux-unpacked", `linux-${process.arch}-unpacked`];
const targetDir = targetDirs.find((candidate) => existsSync(join(releaseRoot, candidate)));
assert.ok(targetDir, `Packaged OpenGrove directory not found under ${releaseRoot}`);
const appRoot =
  process.platform === "darwin" ? join(releaseRoot, targetDir, "OpenGrove.app") : join(releaseRoot, targetDir);
const executable =
  process.platform === "darwin"
    ? join(appRoot, "Contents", "MacOS", "OpenGrove")
    : process.platform === "win32"
      ? join(appRoot, "OpenGrove.exe")
      : [join(appRoot, "opengrove"), join(appRoot, "OpenGrove")].find(existsSync);
assert.ok(executable && existsSync(executable), `Packaged OpenGrove executable not found under ${appRoot}`);

const probe = join(projectRoot, "dist", "tests", "kimi-acp-room-host-tool-real-probe.js");
const child = spawn(executable, [probe], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPENGROVE_PACKAGED_APP_ROOT: appRoot,
  },
  stdio: "inherit",
});
const [code, signal] = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (...result) => resolveExit(result));
});
assert.equal(code, 0, `Packaged Kimi ACP Host Tool probe exited with ${code ?? signal}`);
