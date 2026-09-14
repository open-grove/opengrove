import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { windowsProbeEnvironment, windowsEnvironmentValue } from "../environment/windows-query.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { queryWindowsCommand, readWindowsPath, refreshWindowsPath } from "../environment/windows-discovery.js";
import { clearCommandVersionCache, commandProbe } from "../kernel/discovery.js";
import { buildCodexAppServerEnv } from "../runtime/codex/app-server-client.js";
import { refreshWindowsAppCodexCandidates } from "../runtime/codex/windows-app-discovery.js";
import { refreshCodexCommandPath, resolveCodexCommandPath } from "../runtime/codex/command-path.js";

test("discovers the official Windows CLI install without an inherited PATH entry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fixture");
  assert.equal(
    resolveCodexCommandPath({
      platform: "win32",
      homeDir: root,
      envPath: "",
      environment: {},
      commandPath: { path: "" },
    }),
    executable,
  );
});

test("discovers a CLI added to the user registry PATH after launch", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "custom install", "bin");
  const executable = join(directory, "codex.exe");
  mkdirSync(directory, { recursive: true });
  writeFileSync(executable, "fixture");
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: {},
    commandPath: { path: "" },
    windowsQuery: (_file: string, args: readonly string[]) =>
      args.at(-1)?.includes("GetEnvironmentVariable") ? JSON.stringify(["", directory]) : undefined,
  };
  await refreshCodexCommandPath(probe);
  assert.equal(resolveCodexCommandPath(probe), executable);
});

test("discovers Codex inside the registered Store package on a custom volume", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installLocation = join(root, "other volume", "WindowsApps", "OpenAI.Codex_1.2.3_arm64__2p2nqsd0c76g0");
  const executable = join(installLocation, "app", "resources", "codex.exe");
  const desktopExecutable = join(installLocation, "app", "Codex.exe");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fixture");
  writeFileSync(desktopExecutable, "desktop app, not the CLI");
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: {},
    commandPath: { path: "" },
    windowsQuery: (_file: string, args: readonly string[]) =>
      args.at(-1)?.includes("Get-AppxPackage")
        ? JSON.stringify({
            installLocation,
            executables: [desktopExecutable, executable],
            desktopExecutables: [desktopExecutable],
          })
        : undefined,
  };
  await refreshCodexCommandPath(probe);
  assert.equal(resolveCodexCommandPath(probe), executable);
});

test("preserves explicit overrides and avoids system queries for inherited PATH commands", (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "codex.exe");
  writeFileSync(executable, "fixture");
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: {},
    commandPath: { path: root },
    windowsQuery: () => {
      throw new Error("explicit/PATH resolution must not query Windows");
    },
  };
  assert.equal(resolveCodexCommandPath(probe), executable);
  assert.equal(resolveCodexCommandPath({ ...probe, envPath: join(root, "missing.exe") }), undefined);
  assert.equal(resolveCodexCommandPath({ ...probe, envPath: executable }), executable);
});

for (const location of ["custom", "local-app-data", "winget"] as const) {
  test(`discovers Windows Codex from ${location}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory =
      location === "custom"
        ? join(root, "custom cli")
        : location === "winget"
          ? join(root, "Microsoft", "WinGet", "Links")
          : join(root, "Programs", "OpenAI", "Codex", "bin");
    const executable = join(directory, "codex.exe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(executable, "fixture");
    assert.equal(
      resolveCodexCommandPath({
        platform: "win32",
        homeDir: root,
        envPath: "",
        commandPath: { path: "" },
        environment: { LocalAppData: root, ...(location === "custom" ? { CODEX_INSTALL_DIR: directory } : {}) },
        windowsQuery: () => undefined,
      }),
      executable,
    );
  });
}

test("observes registry PATH changes on the next scan and handles multiple Windows entries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "中文 用户", "bin");
  const executable = join(directory, "codex.exe");
  mkdirSync(directory, { recursive: true });
  writeFileSync(executable, "fixture");
  let currentPath = "";
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    commandPath: { path: "" },
    environment: {},
    windowsQuery: (_file: string, args: readonly string[]) =>
      args.at(-1)?.includes("GetEnvironmentVariable") ? JSON.stringify(["", currentPath]) : undefined,
  };
  await refreshCodexCommandPath(probe);
  assert.equal(resolveCodexCommandPath(probe), undefined);
  currentPath = `${join(root, "missing")};${directory}`;
  await refreshCodexCommandPath({ ...probe, force: true });
  assert.equal(resolveCodexCommandPath(probe), executable);
});

test("merges registry PATH case-insensitively, expands variables and preserves Unicode", async () => {
  const environment = { Path: 'C:\\Existing;"C:\\Mixed Case"', LOCALAPPDATA: "D:\\中文 用户" };
  const result = await refreshWindowsPath(environment, {
    platform: "win32",
    query: () => JSON.stringify(["c:\\existing;C:\\System", "%localappdata%\\工具;C:\\Mixed Case"]),
  });
  assert.equal(result.PATH, "C:\\Existing;C:\\Mixed Case;C:\\System;D:\\中文 用户\\工具");
  assert.equal(result.Path, undefined);
  assert.equal(environment.Path, 'C:\\Existing;"C:\\Mixed Case"');
});

test("Codex app-server receives the recovered PATH without forwarding credentials to the query", async () => {
  const environment = { ...process.env, PATH: "C:\\Existing", OPENAI_API_KEY: "private-test-key" };
  const probe = {
    platform: "win32" as const,
    query: (_file: string, _args: readonly string[], env: NodeJS.ProcessEnv) => {
      assert.equal(env.OPENAI_API_KEY, undefined);
      return JSON.stringify(["C:\\Tools\\node", "D:\\中文\\bin"]);
    },
  };
  await refreshWindowsPath(environment, probe);
  const result = buildCodexAppServerEnv("codex", environment, probe);
  assert.equal(result.PATH, "C:\\Existing;C:\\Tools\\node;D:\\中文\\bin");
  assert.equal(result.OPENAI_API_KEY, "private-test-key", "the runtime still needs its selected Provider credential");
});

test("ignores malformed Windows discovery output and keeps the inherited PATH", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  for (const output of ["not json", "null", "{}", '["valid", 123]']) {
    assert.equal(
      (await refreshWindowsPath({ PATH: "C:\\Existing" }, { platform: "win32", query: () => output })).PATH,
      "C:\\Existing",
    );
    assert.deepEqual(await refreshWindowsAppCodexCandidates({}, { query: () => output }), []);
  }
  assert.equal(warnings.mock.callCount(), 8);
});

test("rejects Store candidates outside the registered package and non-Codex executables", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installLocation = join(root, "package");
  const expected = join(installLocation, "resources", "codex.exe");
  assert.deepEqual(
    await refreshWindowsAppCodexCandidates(
      {},
      {
        query: () =>
          JSON.stringify({
            installLocation,
            desktopExecutables: [],
            executables: [
              join(root, "outside", "codex.exe"),
              "relative/codex.exe",
              join(installLocation, "ChatGPT.exe"),
              expected,
            ],
          }),
      },
    ),
    [expected],
  );
});

test("does not query Windows on macOS or Linux", async () => {
  const environment = { PATH: "/usr/bin" };
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(
      await refreshWindowsPath(environment, {
        platform,
        query: () => {
          throw new Error("unexpected Windows query");
        },
      }),
      environment,
    );
  }
});

test("system Windows PowerShell returns UTF-8 and the actual registry/package queries execute", {
  skip: process.platform !== "win32",
}, async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const output = await queryWindowsCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Write-Output '中文 用户'",
    ],
    process.env,
  );
  if (output === undefined) await diagnosePowerShellEnvironment();
  assert.equal(output?.trim(), "中文 用户", JSON.stringify(warnings.mock.calls.map((call) => call.arguments)));
  const refreshed = await refreshWindowsPath({ ...process.env, PATH: "" });
  assert.ok(refreshed.PATH?.toLowerCase().includes("system32"));
  assert.equal(readWindowsPath({ ...process.env, PATH: "" }).PATH, refreshed.PATH);
  assert.ok(Array.isArray(await refreshWindowsAppCodexCandidates(process.env)));
  assert.equal(warnings.mock.callCount(), 0);
});

test("Windows can validate a discovered CLI command with spaces and Unicode in its path", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove codex 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "codex.cmd");
  writeFileSync(executable, "@echo off\r\necho codex-cli 0.153.4\r\n");
  const discovered = resolveCodexCommandPath({
    platform: "win32",
    envPath: "",
    environment: {},
    commandPath: { path: root },
  });
  assert.equal(discovered, executable);
  assert.deepEqual(commandProbe(discovered), { status: "ok", version: "codex-cli 0.153.4" });
});

test("Windows retries a failed version probe after an explicit refresh of its repaired environment", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-windows-probe-"));
  const original = process.env.OPENGROVE_TEST_CODEX_READY;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.OPENGROVE_TEST_CODEX_READY;
    else process.env.OPENGROVE_TEST_CODEX_READY = original;
  });
  const command = join(root, "codex.mjs");
  writeFileSync(
    command,
    'if (process.env.OPENGROVE_TEST_CODEX_READY === "yes") console.log("codex-cli 0.153.4"); else process.exit(1);',
  );
  delete process.env.OPENGROVE_TEST_CODEX_READY;
  assert.equal(commandProbe(command).status, "failed");
  process.env.OPENGROVE_TEST_CODEX_READY = "yes";
  clearCommandVersionCache();
  assert.deepEqual(commandProbe(command), { status: "ok", version: "codex-cli 0.153.4" });
});

async function diagnosePowerShellEnvironment(): Promise<void> {
  const minimal = windowsProbeEnvironment(process.env);
  const command = join(minimal.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'ready'"];
  const groups = [
    ["ComSpec", "PATHEXT"],
    [
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "CommonProgramFiles",
      "CommonProgramFiles(x86)",
      "CommonProgramW6432",
      "ALLUSERSPROFILE",
      "SystemDrive",
    ],
    [
      "USERNAME",
      "USERDOMAIN",
      "COMPUTERNAME",
      "HOMEDRIVE",
      "HOMEPATH",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
    ],
    ["PSModulePath"],
  ];
  const profiles = [
    { name: "minimal", env: minimal },
    ...groups.map((keys) => ({
      name: keys.join(","),
      env: { ...minimal, ...Object.fromEntries(keys.map((key) => [key, windowsEnvironmentValue(process.env, key)])) },
    })),
    { name: "inherited-control", env: process.env },
  ];
  for (const profile of profiles) {
    const started = performance.now();
    const result = await new Promise((resolve) => {
      const child = execFile(
        command,
        args,
        { env: profile.env, encoding: "utf8", timeout: 5_000, windowsHide: true },
        (error, stdout, stderr) => {
          resolve({
            profile: profile.name,
            elapsed: performance.now() - started,
            code: error?.code,
            killed: error?.killed,
            stdout,
            stderr,
          });
        },
      );
      child.stdin?.end();
    });
    console.info("[DEBUG-windows-query]", JSON.stringify(result));
  }
  const started = performance.now();
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: minimal,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("close", (code, signal) =>
      resolve({ profile: "minimal-stdin-ignore", elapsed: performance.now() - started, code, signal, output }),
    );
    child.once("error", (error) => resolve({ profile: "minimal-stdin-ignore", error: error.message }));
  });
  console.info("[DEBUG-windows-query]", JSON.stringify(result));
}
