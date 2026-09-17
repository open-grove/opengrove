import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("external provider credentials cannot certify Codex native account refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-provider-probe-"));
  try {
    const out = join(root, "evidence.json");
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./kernel-capability-real-runtime-probe-runner.js", import.meta.url)),
        "--kernels",
        "codex",
        "--capabilities",
        "auth.refresh",
        "--cwd",
        root,
        "--out",
        out,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CODEX_HOME: root,
          OPENGROVE_CODEX_BIN: join(root, "not-installed"),
          OPENGROVE_REAL_RUNTIME_OPENAI_BASE_URL: "https://provider.invalid/v1",
          OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY: "test-only-key",
          OPENGROVE_REAL_RUNTIME_MODEL: "test-model",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(evidence.probes.length, 1);
    assert.equal(evidence.probes[0].status, "skipped");
    assert.match(evidence.probes[0].reason, /requires a native account/);
    assert.equal(evidence.contractTests.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
