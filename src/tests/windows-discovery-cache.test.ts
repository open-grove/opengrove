import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readWindowsPath, refreshWindowsPath } from "../environment/windows-discovery.js";
import { queryWindowsCommand, windowsProbeEnvironment } from "../environment/windows-query.js";
import { refreshCodexCommandPath, resolveCodexCommandPath } from "../runtime/codex/command-path.js";

test("missing Codex reads never query Windows; concurrent refreshes share work and let the Host run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-missing-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let queries = 0;
  let releaseRegistry!: () => void;
  const registryReady = new Promise<void>((resolve) => {
    releaseRegistry = resolve;
  });
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: { PATH: "", LOCALAPPDATA: root },
    windowsQuery: async (_file: string, args: readonly string[]) => {
      queries++;
      if (args.at(-1)?.includes("GetEnvironmentVariable")) {
        await registryReady;
        return "[]";
      }
      return "";
    },
  };
  for (let i = 0; i < 20; i++) assert.equal(resolveCodexCommandPath(probe), undefined);
  assert.equal(queries, 0, "cold settings reads must not launch PowerShell");
  const scans = Promise.all([refreshCodexCommandPath(probe), refreshCodexCommandPath(probe)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queries, 1, "overlapping registry queries must share a subprocess");
  for (let i = 0; i < 20; i++) assert.equal(resolveCodexCommandPath(probe), undefined);
  releaseRegistry();
  assert.deepEqual(await scans, [undefined, undefined]);
  assert.equal(queries, 2, "the Store is queried only once after the registry misses");
  await refreshCodexCommandPath(probe);
  assert.equal(queries, 2, "absence must also be cached");
});

test("registry and Store absence expire separately, and manual refresh bypasses both", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-codex-ttl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  let registry = 0;
  let packages = 0;
  const probe = {
    platform: "win32" as const,
    homeDir: root,
    envPath: "",
    environment: { PATH: "", LOCALAPPDATA: root },
    windowsQuery: (_file: string, args: readonly string[]) => {
      if (args.at(-1)?.includes("GetEnvironmentVariable")) {
        registry++;
        return "[]";
      }
      packages++;
      return "";
    },
  };
  await refreshCodexCommandPath(probe);
  await refreshCodexCommandPath(probe);
  assert.deepEqual([registry, packages], [1, 1]);
  now += 60_001;
  await refreshCodexCommandPath(probe);
  assert.deepEqual([registry, packages], [2, 1]);
  now += 240_000;
  await refreshCodexCommandPath(probe);
  assert.deepEqual([registry, packages], [3, 2]);
  await refreshCodexCommandPath({ ...probe, force: true });
  assert.deepEqual([registry, packages], [4, 3]);
});

test("failed or timed-out registry queries are throttled without erasing the last result", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  const environment = { PATH: "C:\\Existing" };
  const probe = {
    platform: "win32" as const,
    query: () => {
      calls++;
      if (calls === 1) return '["C:\\\\Tools"]';
      if (calls === 2) throw new Error("timeout");
      return undefined;
    },
  };
  assert.equal((await refreshWindowsPath(environment, probe)).PATH, "C:\\Existing;C:\\Tools");
  now += 60_001;
  await refreshWindowsPath(environment, probe);
  await refreshWindowsPath(environment, probe);
  assert.equal(calls, 2);
  assert.equal(readWindowsPath(environment, probe).PATH, "C:\\Existing;C:\\Tools");
  now += 60_001;
  await refreshWindowsPath(environment, probe);
  await refreshWindowsPath(environment, probe);
  assert.equal(calls, 3);
});

test("Windows helper environment allows system/user paths but excludes credentials and project PATH", async () => {
  const source = {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    PROCESSOR_ARCHITECTURE: "AMD64",
    TEMP: "D:\\中文 用户",
    USERPROFILE: "D:\\User",
    PATH: "project-bin",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    PSModulePath:
      "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    PSModuleAnalysisCachePath: "C:\\Windows\\Temp\\ModuleAnalysisCache",
    NODE_OPTIONS: "--require project.js",
  };
  const safe = windowsProbeEnvironment(source);
  assert.deepEqual(Object.keys(safe).sort(), [
    "PATH",
    "PROCESSOR_ARCHITECTURE",
    "PSModuleAnalysisCachePath",
    "PSModulePath",
    "ProgramFiles",
    "SystemRoot",
    "TEMP",
    "USERPROFILE",
  ]);
  assert.equal(safe.TEMP, "D:\\中文 用户");
  assert.equal(safe.PSModuleAnalysisCachePath, source.PSModuleAnalysisCachePath);
  assert.equal(safe.PSModulePath, source.PSModulePath, "preserve the configured Windows module search path");
  await refreshWindowsPath(source, {
    platform: "win32",
    query: (_file, _args, environment) => {
      assert.deepEqual(environment, safe);
      return "[]";
    },
  });
});

test("manual refresh during an older query waits for a new query and shares that forced query", async () => {
  let calls = 0;
  let finish!: () => void;
  const olderQuery = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const probe = {
    platform: "win32" as const,
    query: async () => {
      calls++;
      if (calls === 1) {
        await olderQuery;
        return "[]";
      }
      return '["C:\\\\NewInstall"]';
    },
  };
  const environment = { PATH: "C:\\Existing" };
  const original = refreshWindowsPath(environment, probe);
  const afterInstall = refreshWindowsPath(environment, { ...probe, force: true });
  const overlap = refreshWindowsPath(environment, { ...probe, force: true });
  finish();
  await original;
  assert.equal((await afterInstall).PATH, "C:\\Existing;C:\\NewInstall");
  assert.equal((await overlap).PATH, "C:\\Existing;C:\\NewInstall");
  assert.equal(calls, 2);
});

test("non-interactive Windows queries close stdin instead of waiting for input until timeout", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-query-stdin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, "#!/bin/sh\n/bin/cat >/dev/null\nprintf 'query completed'\n", { mode: 0o700 });
  assert.equal(await queryWindowsCommand("powershell.exe", [], { SystemRoot: root }), "query completed");
});
