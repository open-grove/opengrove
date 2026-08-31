import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { isOpenGroveDevProcess, readOpenGroveDevProcessTable } from "./desktop-dev-processes.mjs";

const projectRoot = resolve("workspace", "current-opengrove");
const otherWorktree = resolve("workspace", "other-opengrove");
const legacyDevExecutable = join(
  otherWorktree,
  ".opengrove",
  "electron",
  "OpenGrove Dev.app",
  "Contents",
  "MacOS",
  "Electron",
);

assert.equal(
  isOpenGroveDevProcess(`${legacyDevExecutable} ${otherWorktree}`, projectRoot),
  true,
  "a legacy Dev app launched from another worktree must be stopped before restart",
);

const secret = "OPENGROVE_APP_STORE_REGISTRY_TOKEN=must-not-leak";
assert.throws(
  () =>
    readOpenGroveDevProcessTable({
      execFile: () => {
        const error = new Error("spawnSync ps ENOBUFS");
        error.code = "ENOBUFS";
        error.stdout = Buffer.from(secret);
        error.output = [null, Buffer.from(secret), null];
        throw error;
      },
    }),
  (error) =>
    error instanceof Error &&
    error.message === "OpenGrove Dev process scan failed (ENOBUFS)" &&
    !error.message.includes(secret),
  "process scan failures must not retain or print the environment-bearing process table",
);
assert.equal(
  isOpenGroveDevProcess(
    join(
      resolve("Users", "developer", "Library", "Application Support", "OpenGroveDev"),
      "runtime",
      "electron",
      "OpenGrove Dev.app",
      "Contents",
      "MacOS",
      "Electron",
    ),
    projectRoot,
  ),
  true,
  "the user-level Dev app must be stopped before restart",
);
const profiledDevCommand = `${join(
  resolve("Users", "developer", "Library", "Application Support", "OpenGroveDev"),
  "runtime",
  "electron",
  "OpenGrove Dev.app",
  "Contents",
  "MacOS",
  "Electron",
)} OPENGROVE_DESKTOP_DEV_PROFILE=test`;
assert.equal(
  isOpenGroveDevProcess(profiledDevCommand, projectRoot, "test"),
  true,
  "a profiled restart must select its own Dev process",
);
assert.equal(
  isOpenGroveDevProcess(
    `${profiledDevCommand} npm_lifecycle_script=node scripts/restart-desktop-dev.mjs`,
    projectRoot,
    "test",
  ),
  true,
  "a Dev process inheriting the npm restart lifecycle must still be selected",
);
assert.equal(
  isOpenGroveDevProcess(profiledDevCommand, projectRoot, "production"),
  false,
  "a profiled restart must leave other Dev profiles running",
);
assert.equal(
  isOpenGroveDevProcess(profiledDevCommand.replace("PROFILE=test", "PROFILE=test-production"), projectRoot, "test"),
  false,
  "profile matching must not accept a longer profile with the same prefix",
);
assert.equal(
  isOpenGroveDevProcess(profiledDevCommand, projectRoot),
  false,
  "the default Dev restart must leave explicitly profiled processes running",
);
assert.equal(
  isOpenGroveDevProcess(join(projectRoot, "dist", "server", "desktop-bridge-entry.js"), projectRoot),
  true,
  "the current worktree bridge must still be recognized",
);
assert.equal(
  isOpenGroveDevProcess(join(otherWorktree, "dist", "server", "desktop-bridge-entry.js"), projectRoot),
  false,
  "an unrelated source bridge without the shared Dev app identity must not be killed",
);
assert.equal(
  isOpenGroveDevProcess("/Applications/OpenGrove.app/Contents/MacOS/OpenGrove", projectRoot),
  false,
  "the installed stable app must never be classified as OpenGrove Dev",
);

process.stdout.write("desktop-dev-process matching: ok\n");
