import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-app-command-runtime-"));
const entryPath = join(tempDir, "app-command-runtime-entry.ts");
const bundlePath = join(tempDir, "app-command-runtime-entry.cjs");
const modulePath = join(projectRoot, "src/tools/app-command.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import { formatAppCommandFailure, runAppCommandProcess } from ${JSON.stringify(modulePath)};

    export async function runAppCommandRuntimeHarness() {
    const pythonAttempts: Array<{ command: string; args: string[] }> = [];
    const pythonFallbackResult = await runAppCommandProcess(
      "python3",
      ["scripts/sync.py", "sync"],
      ".",
      undefined,
      {
        platform: "win32",
        execute: async (command, args) => {
          pythonAttempts.push({ command, args });
          return command === "python3"
            ? { exitCode: 9009, stdout: "", stderr: "Python was not found" }
            : { exitCode: 0, stdout: "python fallback ok", stderr: "" };
        },
      },
    );
    assert.deepEqual(pythonAttempts, [
      { command: "python3", args: ["scripts/sync.py", "sync"] },
      { command: "py", args: ["-3", "scripts/sync.py", "sync"] },
    ]);
    assert.equal(pythonFallbackResult.resolvedCommand, "py");
    assert.match(pythonFallbackResult.stdout, /python fallback ok/);

    const missingLauncherAttempts: string[] = [];
    const pythonExecutableFallbackResult = await runAppCommandProcess(
      "python3",
      ["scripts/sync.py"],
      ".",
      undefined,
      {
        platform: "win32",
        execute: async (command) => {
          missingLauncherAttempts.push(command);
          return command === "python"
            ? { exitCode: 0, stdout: "python executable ok", stderr: "" }
            : { exitCode: -1, stdout: "", stderr: "", spawnError: "spawn ENOENT" };
        },
      },
    );
    assert.deepEqual(missingLauncherAttempts, ["python3", "py", "python"]);
    assert.equal(pythonExecutableFallbackResult.resolvedCommand, "python");

    const businessFailureAttempts: string[] = [];
    const businessFailureResult = await runAppCommandProcess(
      "python3",
      ["scripts/write-and-fail.py"],
      ".",
      undefined,
      {
        platform: "win32",
        execute: async (command) => {
          businessFailureAttempts.push(command);
          return { exitCode: 1, stdout: "wrote business output", stderr: "no suitable python runtime for this job" };
        },
      },
    );
    assert.deepEqual(
      businessFailureAttempts,
      ["python3"],
      "a started business script that exits 1 must not run again under another interpreter",
    );
    assert.equal(businessFailureResult.exitCode, 1);

    const business9009Attempts: string[] = [];
    const business9009Result = await runAppCommandProcess(
      "python3",
      ["scripts/write-and-exit-9009.py"],
      ".",
      undefined,
      {
        platform: "win32",
        execute: async (command) => {
          business9009Attempts.push(command);
          return { exitCode: 9009, stdout: "side effect completed", stderr: "business rule rejected input" };
        },
      },
    );
    assert.deepEqual(
      business9009Attempts,
      ["python3"],
      "exit 9009 alone does not prove that the Python launcher was unavailable",
    );
    assert.equal(business9009Result.exitCode, 9009);

    const nonPythonAttempts: string[] = [];
    const nonPythonResult = await runAppCommandProcess(
      "demo-cli",
      ["doctor"],
      ".",
      undefined,
      {
        platform: "win32",
        execute: async (command) => {
          nonPythonAttempts.push(command);
          return { exitCode: 9009, stdout: "", stderr: "" };
        },
      },
    );
    assert.deepEqual(nonPythonAttempts, ["demo-cli"]);
    assert.equal(nonPythonResult.exitCode, 9009);

    const unixPythonAttempts: string[] = [];
    await runAppCommandProcess("python3", ["script.py"], ".", undefined, {
      platform: "darwin",
      execute: async (command) => {
        unixPythonAttempts.push(command);
        return { exitCode: 9009, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(unixPythonAttempts, ["python3"], "non-Windows platforms must keep the declared command");

    const oversizedJsonResult = await runAppCommandProcess(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ payload: '暗'.repeat(100000) }))"],
      ".",
      undefined,
    );
    assert.equal(oversizedJsonResult.stdoutTruncated, true);
    assert.equal(oversizedJsonResult.stderrTruncated, false);
    assert.ok(oversizedJsonResult.stdoutBytes > oversizedJsonResult.capturedStdoutBytes);
    assert.ok(
      oversizedJsonResult.capturedStdoutBytes <= 256 * 1024,
      "captured stdout must stay within the Host byte budget",
    );

    const splitUtf8Result = await runAppCommandProcess(
      process.execPath,
      [
        "-e",
        "const bytes = Buffer.from('暗'); process.stdout.write(bytes.subarray(0, 1)); setTimeout(() => process.stdout.write(bytes.subarray(1)), 25)",
      ],
      ".",
      undefined,
    );
    assert.equal(splitUtf8Result.stdout, "暗");

    const spawnFailureResult = await runAppCommandProcess(
      "opengrove-command-that-does-not-exist-784",
      [],
      ".",
      undefined,
      { platform: "darwin" },
    );
    assert.equal(spawnFailureResult.exitCode, -1);
    assert.match(spawnFailureResult.spawnError, /ENOENT|not found/i);
    assert.equal(spawnFailureResult.stderr, "");
    assert.equal(spawnFailureResult.stderrBytes, 0, "Host spawn errors must not count as process stderr bytes");

    const longFailure = formatAppCommandFailure({
      exitCode: 1,
      stdout: "",
      stderr: "failure-detail-".repeat(500),
      spawnError: "",
      stdoutBytes: 0,
      stderrBytes: 7_000,
      capturedStdoutBytes: 0,
      capturedStderrBytes: 7_000,
      stdoutTruncated: false,
      stderrTruncated: false,
      resolvedCommand: "demo",
      resolvedArgs: [],
    });
    assert.ok(longFailure.length <= 2_000);
    assert.match(longFailure, /\[command_failure_truncated\]/);

    const captureTruncatedFailure = formatAppCommandFailure({
      exitCode: 2,
      stdout: "",
      stderr: "retained stderr tail",
      spawnError: "",
      stdoutBytes: 0,
      stderrBytes: 300_000,
      capturedStdoutBytes: 0,
      capturedStderrBytes: 256 * 1024,
      stdoutTruncated: false,
      stderrTruncated: true,
      resolvedCommand: "demo",
      resolvedArgs: [],
    });
    assert.match(captureTruncatedFailure, /\[stderr_capture_truncated\]/);

    const spawnFailure = formatAppCommandFailure({
      exitCode: -1,
      stdout: "process stdout",
      stderr: "process stderr",
      spawnError: "spawn demo ENOENT",
      stdoutBytes: 14,
      stderrBytes: 14,
      capturedStdoutBytes: 14,
      capturedStderrBytes: 14,
      stdoutTruncated: false,
      stderrTruncated: false,
      resolvedCommand: "demo",
      resolvedArgs: [],
    });
    assert.match(spawnFailure, /spawn demo ENOENT/);
    assert.doesNotMatch(spawnFailure, /process stderr/);
    }
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await require(bundlePath).runAppCommandRuntimeHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("app-command-runtime ok");
