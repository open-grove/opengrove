import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

test("domain help includes both Host operations and local packaging tools", () => {
  const employee = spawnSync(process.execPath, [cli, "employee", "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(employee.status, 0, employee.stderr);
  assert.match(employee.stdout, /upsert/u);
  assert.match(employee.stdout, /pack\s+Package/u);
  const app = spawnSync(process.execPath, [cli, "app", "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(app.status, 0, app.stderr);
  assert.match(app.stdout, /release publish/u);
  assert.match(app.stdout, /inspect\s+Classify/u);
  const inspect = spawnSync(process.execPath, [cli, "app", "inspect", "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /opengrove app inspect <source>/u);
  assert.doesNotMatch(inspect.stdout, /Start the local OpenGrove bridge/u);
});
