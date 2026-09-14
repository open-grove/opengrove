import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchSystemTerminalCommand } from "../server/system-terminal.js";

test("the production Start-Process launcher executes a login script under a Unicode path with spaces", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-terminal 中文 用户 "));
  const environment = { ...process.env };
  t.after(() => {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.TEMP = root;
  process.env.TMP = root;
  const cli = join(root, "fixture cli.cjs");
  const output = join(root, "received.json");
  writeFileSync(cli, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
  const launched = launchSystemTerminalCommand({
    command: process.execPath,
    args: [cli, output, "中文 参数", "path with spaces"],
    cwd: root,
    environment: {},
    unsetEnvironment: [],
  });
  assert.ok(launched.cleanupRoot.startsWith(root), "the generated .ps1 path itself must contain spaces and Unicode");
  const launcherResult = await new Promise<number | null>((resolve, reject) => {
    launched.launcher.once("error", reject);
    launched.launcher.once("close", resolve);
  });
  assert.equal(launcherResult, 0);
  const deadline = Date.now() + 20_000;
  while (
    (!existsSync(launched.resultPath) || !readFileSync(launched.resultPath, "utf8").trim()) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(readFileSync(launched.resultPath, "utf8").trim(), "0");
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), ["中文 参数", "path with spaces"]);
});
