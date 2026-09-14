import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crossSpawn from "cross-spawn";
import { test, type TestContext } from "node:test";
import { clearCommandVersionCache, commandProbe } from "../kernel/discovery.js";
import { defaultBridgeSettings, getBridgeSettingsSnapshot } from "../server/bridge-settings-store.js";
import type { BridgeState } from "../server/bridge-types.js";

function windowsEnvironment(t: TestContext, path: string): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const environment = process.env;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  process.env = { PATH: path };
  clearCommandVersionCache();
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    process.env = environment;
    clearCommandVersionCache();
  });
}

test("Windows remembers failed version checks briefly, then retries without a restart", (t) => {
  windowsEnvironment(t, "C:\\Tools");
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const spawn = t.mock.method(crossSpawn, "sync", () => ({
    pid: 1,
    output: [],
    stdout: "",
    stderr: "broken CLI",
    status: 1,
    signal: null,
  }));
  assert.equal(commandProbe(process.execPath).status, "failed");
  assert.equal(commandProbe(process.execPath).status, "failed");
  assert.equal(spawn.mock.callCount(), 1, "repeated reads must reuse the failed verdict");
  now += 60_001;
  assert.equal(commandProbe(process.execPath).status, "failed");
  assert.equal(spawn.mock.callCount(), 2, "a later scan must be able to recover");
});

test("PATH formatting changes alone do not execute a failed version command twice", (t) => {
  windowsEnvironment(t, 'C:\\Tools;"C:\\Tools";');
  const spawn = t.mock.method(crossSpawn, "sync", () => ({
    pid: 1,
    output: [],
    stdout: "",
    stderr: "broken CLI",
    status: 1,
    signal: null,
  }));
  assert.equal(commandProbe(process.execPath).status, "failed");
  assert.equal(spawn.mock.callCount(), 1, "only a new search directory can justify a retry");
  process.env.PATH = "c:\\tools";
  assert.equal(commandProbe(process.execPath).status, "failed");
  assert.equal(spawn.mock.callCount(), 1, "equivalent PATH values share a cache entry");
  process.env.PATH = "c:\\tools;C:\\NewTools";
  commandProbe(process.execPath);
  assert.equal(spawn.mock.callCount(), 2, "an effective PATH change invalidates the verdict");
});

test("hung Windows version checks are cached and explicit refresh can retry immediately", (t) => {
  windowsEnvironment(t, "C:\\Tools");
  const spawn = t.mock.method(crossSpawn, "sync", () => ({
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: null,
    signal: null,
    error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  }));
  assert.equal(commandProbe(process.execPath).status, "timeout");
  assert.equal(commandProbe(process.execPath).status, "timeout");
  assert.equal(spawn.mock.callCount(), 1);
  clearCommandVersionCache();
  assert.equal(commandProbe(process.execPath).status, "timeout");
  assert.equal(spawn.mock.callCount(), 2);
});

test("repeated Settings snapshots without Codex never start synchronous PowerShell", (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-settings-no-codex-"));
  windowsEnvironment(t, "");
  Object.assign(process.env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root });
  const result = { pid: 1, output: [], stdout: "fixture-cli 1.0", stderr: "", status: 0, signal: null };
  const native = t.mock.method(childProcess, "spawnSync", () => result);
  syncBuiltinESMExports();
  const version = t.mock.method(crossSpawn, "sync", () => result);
  t.after(() => {
    native.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const state = {
    appInitialized: false,
    kernel: "claude-code",
    model: "claude-opus-4-8",
    store: { kind: "memory" },
    settings: {
      ...defaultBridgeSettings(),
      workspaceRoot: root,
      kernelPathOverrides: { "claude-code": { binaryPath: process.execPath, configHome: root } },
    },
  } as unknown as BridgeState;
  for (let i = 0; i < 3; i++) {
    const snapshot = getBridgeSettingsSnapshot(state);
    assert.ok(Array.isArray(snapshot.kernels));
  }
  const powershellCalls = native.mock.calls.filter((call) =>
    /(?:powershell|pwsh)(?:\.exe)?$/i.test(String(call.arguments[0])),
  );
  assert.equal(powershellCalls.length, 0, "Settings cannot synchronously enumerate the registry or Store");
  assert.equal(
    version.mock.calls.filter((call) => call.arguments[0] === process.execPath).length,
    1,
    "the installed Claude fixture only needs one version probe",
  );
});
