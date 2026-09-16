import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";

test("CLI accepts JSON files with spaces and field flags override their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-cli-input-"));
  try {
    const path = join(root, "room input.json");
    await writeFile(path, JSON.stringify({ title: "File title", badge: "FILE" }));
    const result = await runHostOperationCommand([
      "room",
      "room",
      "create",
      "--input",
      `@${path}`,
      "--title",
      "Flag title",
      "--dry-run",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "null");
    assert.equal(output.request.body.title, "Flag title");
    assert.equal(output.request.body.badge, "FILE");
    const missing = await runHostOperationCommand([
      "room",
      "room",
      "create",
      `--input=@${join(root, "missing.json")}`,
      "--dry-run",
    ]);
    assert.equal(missing.exitCode, 2);
    assert.equal(JSON.parse(missing.stderr ?? "null").error.subtype, "input_file_unreadable");
    const help = await runHostOperationCommand(["room", "room", "create", "--input", "@missing.json", "--help"]);
    assert.equal(help.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI process accepts piped JSON and keeps errors on stderr", () => {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const args = [cli, "room", "room", "create", "--input=-", "--dry-run"];
  const valid = spawnSync(process.execPath, args, {
    input: JSON.stringify({ title: "管道输入", badge: "PIPE" }),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stderr, "");
  assert.equal(JSON.parse(valid.stdout).request.body.title, "管道输入");
  const invalid = spawnSync(process.execPath, args, { input: "{", encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(JSON.parse(invalid.stderr).error.subtype, "invalid_json");
});
