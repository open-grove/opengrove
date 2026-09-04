import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-host-controller-"));
const bundlePath = join(tempDir, "bridge-host-controller.mjs");
const stateBundlePath = join(tempDir, "bridge-startup-state.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-host-controller.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
  });
  await build({
    entryPoints: [join(projectRoot, "src", "desktop-bridge-startup-state.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: stateBundlePath,
  });
  const { DesktopBridgeHostController } = await import(pathToFileURL(bundlePath).href);
  const { isDesktopBridgeStartupActivityMessage, isDesktopBridgeStartupState } = await import(
    pathToFileURL(stateBundlePath).href
  );

  assert.equal(isDesktopBridgeStartupState({ stage: "migrating", attempt: 1 }), true);
  assert.equal(isDesktopBridgeStartupState({ stage: "migrating", attempt: 0 }), false);
  assert.equal(
    isDesktopBridgeStartupActivityMessage({
      type: "opengrove.desktop.bridge.startup-activity",
      activity: "migrating_local_data",
    }),
    true,
  );
  assert.equal(
    isDesktopBridgeStartupActivityMessage({
      type: "opengrove.desktop.bridge.startup-activity",
      activity: "untrusted_activity",
    }),
    false,
  );

  const published = [];
  const host = new DesktopBridgeHostController((state) => published.push(state));
  assert.deepEqual(host.state, { stage: "starting", attempt: 1 });
  assert.equal(host.runtime, undefined);

  const first = runtime("http://127.0.0.1:43123/api", 101);
  assert.equal(host.activate(first), true);
  assert.equal(host.runtime, first);
  assert.equal(host.readyRuntime, first, "ready requests must target the active Bridge runtime");
  assert.deepEqual(host.state, { stage: "ready", generation: 1 });
  assert.equal("apiBase" in host.state, false, "renderer startup state must not expose a dynamic port");

  assert.equal(host.activate(first), false, "repeated status events for one runtime must be idempotent");
  assert.equal(published.length, 1);

  host.maintenance("storage_cleanup");
  assert.equal(host.runtime, first, "planned maintenance keeps the retained renderer bound to its runtime identity");
  assert.equal(host.readyRuntime, undefined, "maintenance requests must not target the retained Bridge runtime");
  assert.deepEqual(host.state, { stage: "maintenance", operation: "storage_cleanup" });
  assert.equal(
    host.activate(first),
    true,
    "maintenance completion must republish ready even when the runtime is reused",
  );
  assert.equal(host.readyRuntime, first, "requests may resume only after the runtime is republished as ready");
  assert.deepEqual(host.state, { stage: "ready", generation: 2 });

  host.retrying({ attempt: 2, retryInMs: 1_000, message: "bridge crashed" });
  assert.equal(host.runtime, undefined, "requests must stop targeting a crashed runtime");
  assert.deepEqual(host.state, {
    stage: "retrying",
    attempt: 2,
    retryInMs: 1_000,
    message: "bridge crashed",
  });

  host.migrating();
  assert.equal(host.runtime, undefined);
  assert.deepEqual(host.state, { stage: "migrating", attempt: 2 });

  const replacement = runtime("http://127.0.0.1:44888/api", 202);
  assert.equal(host.activate(replacement), true);
  assert.equal(host.runtime, replacement);
  assert.deepEqual(host.state, { stage: "ready", generation: 3 });

  host.blocked({
    attempt: 3,
    code: "LOCAL_STATE_LOCKED",
    message: "locked",
    actions: ["open_data_dir", "retry"],
  });
  assert.equal(host.runtime, undefined);
  assert.deepEqual(host.state, {
    stage: "blocked",
    attempt: 3,
    code: "LOCAL_STATE_LOCKED",
    message: "locked",
    actions: ["open_data_dir", "retry"],
  });

  console.log("desktop-bridge-host-controller harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function runtime(apiBase, pid) {
  return { apiBase, pid };
}
