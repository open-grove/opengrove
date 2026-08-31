import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { BridgeSecurity } from "../server/bridge-security.js";
import type { BridgeState } from "../server/bridge-types.js";
import { createBridgeRoutes } from "../server/routes/bridge-registry.js";
import { dispatchBridgeRoutes } from "../server/router.js";

function createState(): BridgeState {
  const app = createOpenGrove({
    cwd: mkdtempSync(join(tmpdir(), "opengrove-routine-routes-")),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
  });
  return {
    app,
    profile: "local",
    store: {
      saveFrom(value: unknown) {
        assert.equal(value, app);
      },
    },
  } as unknown as BridgeState;
}

async function dispatch(input: {
  method: string;
  path: string;
  body?: unknown;
  state?: BridgeState;
  security?: BridgeSecurity;
}): Promise<{ handled: boolean; status?: number; data?: unknown }> {
  let status: number | undefined;
  let data: unknown;
  const handled = await dispatchBridgeRoutes(createBridgeRoutes(), {
    traceId: "trace-routine-routes-harness",
    request: { method: input.method, headers: {} } as any,
    response: {} as any,
    url: new URL(input.path, "http://127.0.0.1"),
    state: input.state ?? createState(),
    security: input.security ?? { authMode: "bridge-token", allowedOrigins: [] },
    sendJson(_response, code, payload) {
      status = code;
      data = payload;
    },
    readJsonBody: async () => input.body ?? {},
  });
  return { handled, status, data };
}

const invalidSchedule = await dispatch({
  method: "POST",
  path: "/routines",
  body: {
    title: "Invalid schedule",
    trigger: "schedule",
    schedule: { at: "25:99" },
    steps: [{ memberId: "member-a", prompt: "run" }],
  },
});
assert.equal(invalidSchedule.handled, true);
assert.equal(invalidSchedule.status, 400);
assert.deepEqual(invalidSchedule.data, { ok: false, error: "schedule_required" });

const scheduleState = createState();
const createRoutine = await dispatch({
  method: "POST",
  path: "/routines",
  state: scheduleState,
  body: {
    title: "Schedule UI target",
    steps: [{ memberId: "member-a", prompt: "run" }],
  },
});
assert.equal(createRoutine.handled, true);
assert.equal(createRoutine.status, 200);
const routineId = (createRoutine.data as { routine: { id: string } }).routine.id;

const enableSchedule = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "schedule", schedule: { at: "09:30", daysOfWeek: [1, 3, 5] } },
});
assert.equal(enableSchedule.handled, true);
assert.equal(enableSchedule.status, 200);
assert.equal(scheduleState.app.routines.get(routineId)?.trigger, "schedule");
assert.deepEqual(scheduleState.app.routines.get(routineId)?.schedule, { at: "09:30", daysOfWeek: [1, 3, 5] });

const badScheduleUpdate = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "schedule", schedule: { at: "24:00" } },
});
assert.equal(badScheduleUpdate.handled, true);
assert.equal(badScheduleUpdate.status, 400);
assert.deepEqual(badScheduleUpdate.data, { ok: false, error: "schedule_required" });

const enableIntervalSchedule = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "schedule", schedule: { everyMinutes: 2 } },
});
assert.equal(enableIntervalSchedule.handled, true);
assert.equal(enableIntervalSchedule.status, 200);
assert.equal(scheduleState.app.routines.get(routineId)?.trigger, "schedule");
assert.deepEqual(scheduleState.app.routines.get(routineId)?.schedule, { everyMinutes: 2 });

const badIntervalSchedule = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "schedule", schedule: { everyMinutes: 0 } },
});
assert.equal(badIntervalSchedule.handled, true);
assert.equal(badIntervalSchedule.status, 400);
assert.deepEqual(badIntervalSchedule.data, { ok: false, error: "schedule_required" });

const mixedSchedule = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "schedule", schedule: { at: "09:30", everyMinutes: 2 } },
});
assert.equal(mixedSchedule.handled, true);
assert.equal(mixedSchedule.status, 400);
assert.deepEqual(mixedSchedule.data, { ok: false, error: "schedule_required" });

const disableSchedule = await dispatch({
  method: "POST",
  path: `/routines/${routineId}/schedule`,
  state: scheduleState,
  body: { trigger: "manual" },
});
assert.equal(disableSchedule.handled, true);
assert.equal(disableSchedule.status, 200);
assert.equal(scheduleState.app.routines.get(routineId)?.trigger, "manual");
assert.equal(scheduleState.app.routines.get(routineId)?.schedule, undefined);

console.log("routine-routes-harness passed");
