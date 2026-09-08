import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "opengrove-supervisor-lifecycle-"));
try {
  const bundle = join(root, "supervisor.mjs");
  await build({
    stdin: {
      contents: 'export * from "./desktop/bridge-supervisor.ts"; export { children } from "test:children";',
      resolveDir: projectRoot,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    plugins: [
      {
        name: "controlled-child-processes",
        setup(build) {
          build.onResolve({ filter: /^(node:child_process|test:children)$/ }, (args) => {
            if (args.path === "test:children" || args.importer.endsWith("bridge-supervisor.ts")) {
              return { path: "children", namespace: "test" };
            }
          });
          build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `
            import { EventEmitter } from "node:events";
            export const children = [];
            export function fork(_file, _args, { env }) {
              const child = Object.assign(new EventEmitter(), {
                pid: 30000 + children.length, exitCode: null, signalCode: null, connected: true,
                failStop: false,
                finish() { this.exitCode = 0; this.connected = false; this.emit("exit", 0, null); },
                kill() { if (this.failStop) throw new Error("desktop_bridge_exit_timeout"); this.finish(); return true; },
                send(_message, callback) {
                  queueMicrotask(() => this.failStop ? callback(new Error("IPC failed")) : this.finish());
                },
                ready() { this.emit("message", {
                  type: "opengrove.desktop.bridge.ready", host: "127.0.0.1", port: 43123,
                  url: "http://127.0.0.1:43123", apiBase: "http://127.0.0.1:43123/api",
                  authMode: "bridge-token", pid: this.pid, dataDir: env.OPENGROVE_DATA_DIR,
                  statePath: env.OPENGROVE_STATE_PATH, settingsPath: env.OPENGROVE_BRIDGE_SETTINGS_PATH,
                  logDir: env.OPENGROVE_LOG_DIR,
                }); },
              });
              children.push(child);
              queueMicrotask(() => child.ready());
              return child;
            }
          `,
          }));
        },
      },
    ],
  });
  const { DesktopBridgeSupervisor, children } = await import(pathToFileURL(bundle).href);
  const create = (name, recoverStateLocks = () => ({ recovered: [], blockers: [] })) =>
    new DesktopBridgeSupervisor({
      appRoot: projectRoot,
      resourcesPath: projectRoot,
      userDataDir: join(root, name),
      token: "test-token",
      isPackaged: false,
      channel: "dev",
      recoverStateLocks,
    });

  const supervisor = create("failed-stop");
  await supervisor.start({ allowReuse: false });
  const original = children.at(-1);
  original.failStop = true;
  const stopped = supervisor.stop();
  const started = supervisor.start({ allowReuse: false });
  const outcomes = await Promise.allSettled([stopped, started]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(
    outcomes[1].reason.code,
    "LOCAL_STATE_LOCKED",
    "concurrent start must return an actionable stop blocker",
  );
  assert.deepEqual(outcomes[1].reason.blockingPids, [original.pid]);
  assert.ok(outcomes[1].reason.actions.includes("stop_blocking_process"));
  assert.equal(supervisor.diagnostics().status, "failed");
  assert.equal(children.length, 1, "a failed stop must not admit another child");
  await assert.rejects(supervisor.start({ allowReuse: false }), { code: "LOCAL_STATE_LOCKED" });
  original.finish();
  const replacement = await supervisor.start({ allowReuse: false });
  original.ready();
  assert.equal(
    supervisor.currentRuntime().pid,
    replacement.pid,
    "late messages from an old child cannot replace runtime state",
  );
  await supervisor.stop();

  let finishRecovery;
  let inspections = 0;
  const recovering = create("cancel-recovery", () => {
    inspections += 1;
    return inspections === 1
      ? new Promise((resolve) => {
          finishRecovery = resolve;
        })
      : { recovered: [], blockers: [] };
  });
  const countBeforeRecovery = children.length;
  const initialStart = recovering.start({ allowReuse: false });
  const cancellation = recovering.stop();
  const nextStart = recovering.start({ allowReuse: false });
  finishRecovery({ recovered: [], blockers: [] });
  const cancelled = await Promise.allSettled([initialStart, cancellation, nextStart]);
  assert.equal(cancelled[0].status, "rejected");
  assert.match(cancelled[0].reason.message, /stopped_during_startup/);
  assert.equal(cancelled[1].status, "fulfilled");
  assert.equal(cancelled[2].status, "fulfilled");
  assert.equal(
    children.length,
    countBeforeRecovery + 1,
    "cancelled startup must finish before exactly one replacement starts",
  );
  await recovering.stop();

  const crashing = create("cancel-restart");
  await crashing.start({ allowReuse: false });
  const countBeforeCrash = children.length;
  children.at(-1).finish();
  await crashing.stop();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(children.length, countBeforeCrash, "quitting must cancel a scheduled crash restart");
  assert.equal(crashing.diagnostics().status, "stopped");

  const busy = create("busy", () => ({
    recovered: [],
    blockers: [
      {
        statePath: "state.sqlite",
        lockPath: "state.sqlite.lock",
        reason: "ownership_busy",
        detail: "OS lock is held",
      },
    ],
  }));
  await assert.rejects(busy.start({ allowReuse: false }), (error) => {
    assert.equal(error.code, "LOCAL_STATE_LOCKED");
    assert.match(error.message, /in use by another OpenGrove process/);
    assert.doesNotMatch(error.message, /recovered/);
    return true;
  });
  await busy.stop();
  console.log("bridge supervisor lifecycle: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
