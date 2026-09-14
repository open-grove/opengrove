import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { queryWindowsCommand, readWindowsPath, refreshWindowsPath } from "../environment/windows-discovery.js";
import { clearCommandVersionCache, commandProbe } from "../kernel/discovery.js";
import { buildCodexAppServerEnv } from "../runtime/codex/app-server-client.js";
import { refreshWindowsAppCodexCandidates } from "../runtime/codex/windows-app-discovery.js";
import { refreshCodexCommandPath, resolveCodexCommandPath } from "../runtime/codex/command-path.js";

function desktopCliFixture(root: string): string {
  const executable = join(root, "fixture.exe");
  if (process.platform === "win32") {
    const source = join(root, "fixture.cs");
    writeFileSync(
      source,
      `
using System;
using System.IO;
using System.Reflection;
class Fixture {
  static int Main(string[] args) {
    string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    File.AppendAllText(Path.Combine(root, "calls.txt"), String.Join(" ", args) + "\\n");
    if (args.Length != 1 || args[0] != "--version") return 2;
    Console.WriteLine(File.ReadAllText(Path.Combine(root, "version.txt")));
    return 0;
  }
}
`,
    );
    execFileSync(
      join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -Path $env:OPENGROVE_TEST_SOURCE -OutputAssembly $env:OPENGROVE_TEST_EXE -OutputType ConsoleApplication",
      ],
      { env: { ...process.env, OPENGROVE_TEST_SOURCE: source, OPENGROVE_TEST_EXE: executable }, timeout: 15_000 },
    );
  } else {
    writeFileSync(
      executable,
      '#!/bin/sh\ndir="${0%/*}"\nprintf "%s\\n" "$*" >> "$dir/calls.txt"\n[ "$1" = "--version" ] || exit 2\n/bin/cat "$dir/version.txt"\n',
      { mode: 0o700 },
    );
  }
  return executable;
}

test("discovers a runnable desktop CLI one directory below LocalAppData/OpenAI/Codex/bin", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove desktop 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "OpenAI", "Codex", "bin", "bffc5354119c8421", "codex.exe");
  mkdirSync(dirname(executable), { recursive: true });
  copyFileSync(desktopCliFixture(root), executable);
  writeFileSync(join(dirname(executable), "version.txt"), "codex-cli 0.153.4");
  let packageQueries = 0;
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: { ...process.env, LOCALAPPDATA: root, PATH: "" },
    commandPath: { path: "" },
    windowsQuery: (_file: string, args: readonly string[]) => {
      if (args.at(-1)?.includes("Get-AppxPackage")) packageQueries++;
      return "";
    },
  };
  assert.equal(resolveCodexCommandPath(probe), undefined);
  const scans = await Promise.all([refreshCodexCommandPath(probe), refreshCodexCommandPath(probe)]);
  assert.deepEqual(scans, [executable, executable]);
  for (let index = 0; index < 10; index++) assert.equal(resolveCodexCommandPath(probe), executable);
  assert.equal(readFileSync(join(dirname(executable), "calls.txt"), "utf8"), "--version\n");
  assert.equal(packageQueries, 0, "a validated desktop CLI does not need a Store package scan");
});

test("desktop CLI discovery skips unusable candidates and follows updated generation directories", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove desktop refresh "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warnings = t.mock.method(console, "warn", () => {});
  const fixture = desktopCliFixture(root);
  const bin = join(root, "OpenAI", "Codex", "bin");
  const working = join(bin, "older-working", "codex.exe");
  const unrelated = join(bin, "newer-unrelated", "codex.exe");
  const broken = join(bin, "newest-broken", "codex.exe");
  const nested = join(bin, "other", "nested", "codex.exe");
  for (const [index, command] of [working, unrelated, broken, nested].entries()) {
    mkdirSync(dirname(command), { recursive: true });
    copyFileSync(fixture, command);
    writeFileSync(
      join(dirname(command), "version.txt"),
      command === unrelated ? "another-tool 1.0.0" : "codex-cli 0.153.4",
    );
    utimesSync(command, 1_700_000_000 + index, 1_700_000_000 + index);
  }
  writeFileSync(broken, "invalid executable", { mode: 0o700 });
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: { ...process.env, LOCALAPPDATA: root, PATH: "" },
    commandPath: { path: "" },
    windowsQuery: () => "",
  };
  assert.equal(await refreshCodexCommandPath(probe), working);
  assert.equal(warnings.mock.callCount(), 2);
  assert.throws(() => readFileSync(join(dirname(nested), "calls.txt")), { code: "ENOENT" });

  const updated = join(bin, "different-generation", "codex.exe");
  mkdirSync(dirname(updated), { recursive: true });
  copyFileSync(fixture, updated);
  writeFileSync(join(dirname(updated), "version.txt"), "codex-cli 0.154.0");
  rmSync(dirname(working), { recursive: true });
  assert.equal(resolveCodexCommandPath(probe), undefined, "deleted cached paths must not remain available");
  assert.equal(await refreshCodexCommandPath({ ...probe, force: true }), updated);
  assert.equal(resolveCodexCommandPath(probe), updated);

  assert.equal(await refreshCodexCommandPath({ ...probe, envPath: join(root, "missing.exe") }), undefined);
  assert.equal(await refreshCodexCommandPath({ ...probe, commandPath: { path: dirname(unrelated) } }), unrelated);
  assert.equal(
    readFileSync(join(dirname(updated), "calls.txt"), "utf8"),
    "--version\n",
    "explicit/PATH commands retain precedence without probing desktop candidates again",
  );
});

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
  assert.equal(output?.trim(), "中文 用户", JSON.stringify(warnings.mock.calls.map((call) => call.arguments)));
  const refreshed = await refreshWindowsPath({ ...process.env, PATH: "" });
  assert.ok(refreshed.PATH?.toLowerCase().includes("system32"));
  assert.equal(readWindowsPath({ ...process.env, PATH: "" }).PATH, refreshed.PATH);
  assert.ok(Array.isArray(await refreshWindowsAppCodexCandidates(process.env)));
  assert.equal(warnings.mock.callCount(), 0, JSON.stringify(warnings.mock.calls.map((call) => call.arguments)));
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
