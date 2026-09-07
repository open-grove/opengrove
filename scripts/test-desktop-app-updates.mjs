import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dir = await mkdtemp(join(tmpdir(), "opengrove-desktop-app-updates-"));
const originalFetch = globalThis.fetch;
let scheduler;
try {
  const bundle = join(dir, "scheduler.mjs");
  await build({
    entryPoints: [join(root, "desktop/app-update-scheduler.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
  });
  const { DesktopAppUpdateScheduler } = await import(pathToFileURL(bundle));
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  let connection = {
    apiBase: "http://127.0.0.1:43210/api",
    bridgeToken: "desktop-token",
    cookieHeader: "saved-session",
  };
  const requests = [];
  const logs = [];
  let status = 200;
  let pendingSignal;
  let hold = false;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: new Headers(init.headers) });
    if (hold) {
      pendingSignal = init.signal;
      await new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    }
    return Response.json(
      status === 200
        ? { ok: true, status: "scheduled" }
        : { error: status === 401 ? "not_authenticated" : "unavailable" },
      { status },
    );
  };
  scheduler = new DesktopAppUpdateScheduler({ getConnection: () => connection, log: (message) => logs.push(message) });
  scheduler.start();
  mock.timers.tick(8_000);
  await settle();
  assert.equal(requests.length, 1, "desktop startup schedules Apps without a renderer");

  // Execute the application's actual macOS close handler while the real
  // scheduler remains alive; no renderer or client updater participates.
  const main = await readFile(join(root, "desktop/main.ts"), "utf8");
  const closeHandler = main.slice(main.indexOf('app.on("window-all-closed"'), main.indexOf('app.on("activate"'));
  let close;
  let quitCalls = 0;
  vm.runInNewContext(closeHandler, {
    process: { platform: "darwin" },
    app: {
      on: (_event, handler) => {
        close = handler;
      },
      quit: () => {
        quitCalls++;
      },
    },
    appUpdateScheduler: scheduler,
  });
  close();
  assert.equal(quitCalls, 0);
  for (let tick = 0; tick < 2; tick++) {
    mock.timers.tick(6 * 60 * 60_000);
    await settle();
    assert.equal(requests.length, tick + 2, "closing the window preserves each App update heartbeat");
  }
  for (const request of requests) {
    assert.equal(request.url, "http://127.0.0.1:43210/api/app-store/updates");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-opengrove-token"), "desktop-token");
    assert.equal(request.headers.get("cookie"), "saved-session");
  }

  connection = { ...connection, apiBase: "http://127.0.0.1:43211/api", cookieHeader: "renewed-session" };
  mock.timers.tick(60_000);
  status = 401;
  await scheduler.check("auth-cookie");
  assert.equal(requests.at(-1).headers.get("cookie"), "renewed-session");
  assert.equal(requests.at(-1).url, "http://127.0.0.1:43211/api/app-store/updates");
  assert.ok(
    logs.some((message) => message.includes("not_authenticated")),
    "expired accounts are observable skips",
  );
  status = 503;
  mock.timers.tick(60_000);
  await scheduler.check("auth-cookie");
  assert.ok(logs.some((message) => message.includes("app_update_schedule_failed")));
  status = 200;
  mock.timers.tick(60_000);
  await scheduler.check("auth-cookie");
  const recoveredCount = requests.length;
  await scheduler.check("auth-cookie");
  assert.equal(requests.length, recoveredCount, "cookie events are throttled independently of client versions");

  connection = { ...connection, bridgeToken: "" };
  mock.timers.tick(6 * 60 * 60_000);
  await settle();
  assert.equal(
    requests.length,
    recoveredCount,
    "background calls require a trusted Bridge token to avoid credential refresh",
  );
  connection = { ...connection, bridgeToken: "desktop-token", cookieHeader: "" };
  mock.timers.tick(6 * 60 * 60_000);
  await settle();
  assert.equal(requests.length, recoveredCount, "logout stops background network requests");
  connection = { ...connection, cookieHeader: "restored-session" };
  hold = true;
  const pending = scheduler.check("auth-cookie");
  await settle();
  await scheduler.check("auth-cookie", 0);
  assert.equal(requests.length, recoveredCount + 1, "overlapping checks are coalesced");
  scheduler.stop();
  assert.equal(pendingSignal.aborted, true, "shutdown aborts the non-refreshing request");
  await pending;
  mock.timers.tick(12 * 60 * 60_000);
  await settle();
  assert.equal(requests.length, recoveredCount + 1, "quit cancels subsequent heartbeats");

  const startup = main.slice(
    main.indexOf("async function startAndActivateDesktopBridge"),
    main.indexOf("async function startBridgeWithAutomaticRecovery"),
  );
  assert.match(startup, /appUpdateScheduler\.start\(\)/u, "Bridge startup must wire the independent scheduler");
  const quitting = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('app.on("window-all-closed"'));
  assert.match(quitting, /appUpdateScheduler\.stop\(\)/u);
} finally {
  scheduler?.stop();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
console.log("desktop App update scheduler ok");
