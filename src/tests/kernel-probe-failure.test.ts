import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("a cold version failure writes failed evidence and cleans probe resources", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-probe-failure-"));
  try {
    const executable = join(root, "hermes.cjs");
    const counter = join(root, "counter");
    writeFileSync(
      executable,
      `const fs=require('node:fs'); const p=${JSON.stringify(counter)}; const count=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0; fs.writeFileSync(p,String(count+1)); if(count===0) console.log('Hermes 1.2.3'); else { console.error('private-diagnostic-sentinel'); process.exit(7); }`,
    );
    const output = join(root, "result.json");
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/tests/kernel-capability-real-runtime-probe-runner.js"),
        "--kernels",
        "hermes",
        "--capabilities",
        "turn.lifecycle,message.streamText",
        "--cwd",
        root,
        "--out",
        output,
      ],
      {
        env: { ...process.env, OPENGROVE_HERMES_BIN: executable, HOME: root, USERPROFILE: root },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const evidence = JSON.parse(readFileSync(output, "utf8")) as { probes: { status: string; reason: string }[] };
    assert.equal(evidence.probes.length, 2);
    assert.ok(evidence.probes.every((probe) => probe.status === "failed" && probe.reason === "probe_case_failed"));
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(evidence)}`.includes("private-diagnostic-sentinel"));
    assert.ok(
      !readdirSync(root, { recursive: true }).some((path) => String(path).includes(".opengrove-real-runtime-probes")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
