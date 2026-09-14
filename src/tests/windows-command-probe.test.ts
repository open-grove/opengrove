import assert from "node:assert/strict";
import crossSpawn from "cross-spawn";
import { test, type TestContext } from "node:test";
import { clearCommandVersionCache, commandProbe } from "../kernel/discovery.js";

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
});
