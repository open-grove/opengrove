import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-main-window-lifecycle-"));
const bundlePath = join(tempDir, "main-window-lifecycle.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "main-window-lifecycle.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const { activateBridgeInRetainedMainWindow, clearClosedMainWindow, focusOrCreateMainWindow } = await import(
    pathToFileURL(bundlePath).href
  );

  const active = fakeWindow({ minimized: true });
  let createCalls = 0;
  assert.equal(
    focusOrCreateMainWindow(active, () => {
      createCalls += 1;
      return fakeWindow();
    }),
    active,
  );
  assert.equal(createCalls, 0);
  assert.deepEqual(active.calls, ["isDestroyed", "isMinimized", "restore", "focus"]);

  const destroyed = fakeWindow({ destroyed: true });
  const replacement = fakeWindow();
  assert.equal(
    focusOrCreateMainWindow(destroyed, () => {
      createCalls += 1;
      return replacement;
    }),
    replacement,
  );
  assert.equal(createCalls, 1);
  assert.deepEqual(destroyed.calls, ["isDestroyed"]);
  assert.deepEqual(replacement.calls, ["isDestroyed", "isMinimized", "focus"]);

  const created = fakeWindow();
  assert.equal(
    focusOrCreateMainWindow(undefined, () => created),
    created,
  );
  assert.equal(clearClosedMainWindow(created, created), undefined);
  assert.equal(clearClosedMainWindow(replacement, created), replacement);

  const activationSteps = [];
  await activateBridgeInRetainedMainWindow(() => activationSteps.push("bridge-ready"));
  assert.deepEqual(
    activationSteps,
    ["bridge-ready"],
    "Bridge readiness must keep the existing renderer document instead of navigating to refresh a dynamic CSP",
  );

  console.log("desktop-main-window-lifecycle-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function fakeWindow(options = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed() {
      calls.push("isDestroyed");
      return options.destroyed === true;
    },
    isMinimized() {
      calls.push("isMinimized");
      return options.minimized === true;
    },
    restore() {
      calls.push("restore");
    },
    focus() {
      calls.push("focus");
    },
  };
}
