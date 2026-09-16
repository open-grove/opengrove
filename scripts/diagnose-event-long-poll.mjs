// Run after build:server. Wrap the real inventory harness without changing Host behavior.
// --delay-mutation-response-ms=1600 delays only the test client's PATCH completion,
// distinguishing event delivery from the trigger request's response time.
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { EventLog } from "../dist/core/events.js";
import { hostOperations } from "../dist/protocol/index.js";

const option = process.argv.slice(2);
if (option.length > 1 || (option.length === 1 && !/^--delay-mutation-response-ms=\d+$/.test(option[0]))) {
  throw new Error("Usage: node scripts/diagnose-event-long-poll.mjs [--delay-mutation-response-ms=1600]");
}
const mutationDelayMs = Number(option[0]?.split("=")[1] ?? 0);
if (!Number.isSafeInteger(mutationDelayMs) || mutationDelayMs > 10_000) throw new Error("delay must be 0..10000 ms");
const timings = {};
const sql = { totalMs: 0, maxMs: 0, calls: 0 };
let pollStartedAt;
const restore = [];
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

function elapsed() {
  return Math.round((performance.now() - pollStartedAt) * 100) / 100;
}
function replace(target, key, wrap) {
  const original = target[key];
  target[key] = wrap(original);
  restore.push(() => {
    target[key] = original;
  });
}
for (const [target, key] of [
  [DatabaseSync.prototype, "exec"],
  [StatementSync.prototype, "run"],
]) {
  replace(
    target,
    key,
    (original) =>
      function (...args) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          if (pollStartedAt !== undefined) {
            const duration = performance.now() - start;
            sql.totalMs += duration;
            sql.maxMs = Math.max(sql.maxMs, duration);
            sql.calls++;
          }
        }
      },
  );
}
replace(
  EventLog.prototype,
  "append",
  (original) =>
    function (...args) {
      if (pollStartedAt !== undefined) timings.firstEventMs ??= elapsed();
      return original.apply(this, args);
    },
);
replace(
  EventLog.prototype,
  "waitForEventsAfter",
  (original) =>
    function (...args) {
      if (pollStartedAt !== undefined) timings.waitRegisteredMs = elapsed();
      return original.apply(this, args).then((value) => {
        if (pollStartedAt !== undefined) timings.waitResolvedMs = elapsed();
        return value;
      });
    },
);
const eventSchema = hostOperations.find((operation) => operation.id === "run.event.list")?.success.body;
if (eventSchema)
  replace(
    eventSchema,
    "safeParse",
    (original) =>
      function (...args) {
        const start = performance.now();
        const result = original.apply(this, args);
        if (pollStartedAt !== undefined) timings.responseValidationMs = performance.now() - start;
        return result;
      },
  );
replace(
  globalThis,
  "fetch",
  (original) =>
    async function (input, init) {
      const url = new URL(String(input));
      const poll = url.pathname === "/api/events" && url.searchParams.has("waitMs");
      const mutation = url.pathname === "/api/computer-state" && init?.method === "PATCH";
      if (poll) {
        pollStartedAt = performance.now();
        loop.reset();
      }
      if (mutation) timings.mutationStartedMs = elapsed();
      const response = await original(input, init);
      if (poll) {
        timings.pollHeadersMs = elapsed();
        const json = response.json.bind(response);
        response.json = async () => {
          const body = await json();
          timings.pollBodyMs = elapsed();
          return body;
        };
      }
      if (mutation) {
        timings.mutationHeadersMs = elapsed();
        if (mutationDelayMs) await delay(mutationDelayMs);
        timings.mutationObservedMs = elapsed();
      }
      return response;
    },
);
function report() {
  loop.disable();
  for (const undo of restore.reverse()) undo();
  console.log(JSON.stringify({ mutationDelayMs, timings, sql, eventLoopMaxMs: loop.max / 1e6 }, null, 2));
}
// The harness deliberately exits after closing its isolated Bridge.
process.once("exit", report);
try {
  await import("../dist/tests/packaged-inventory-harness.js");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.removeListener("exit", report);
  report();
}
