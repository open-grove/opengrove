import assert from "node:assert/strict";
import {
  activeBridgeRunIds,
  beginBridgeRunMaintenance,
  bridgeRunMaintenanceActive,
  endBridgeRunMaintenance,
  registerActiveBridgeRun,
} from "../server/active-runs.js";
import type { BridgeState } from "../server/bridge-types.js";

const rootState = {} as BridgeState;
const scopedState = { rootState } as BridgeState;

const firstAdmission = beginBridgeRunMaintenance(scopedState);
assert.equal(firstAdmission.ok, true);
assert.equal(bridgeRunMaintenanceActive(rootState), true);
assert.throws(
  () => registerActiveBridgeRun(rootState, "run-during-maintenance"),
  /bridge_runs_paused_for_storage_maintenance/,
  "run admission remains closed until the matching maintenance lease is released",
);
assert.equal(endBridgeRunMaintenance(rootState, "wrong-lease"), false);
assert.equal(firstAdmission.ok && endBridgeRunMaintenance(scopedState, firstAdmission.leaseId), true);
assert.equal(bridgeRunMaintenanceActive(rootState), false);

const releaseRun = registerActiveBridgeRun(scopedState, "active-run");
assert.deepEqual([...activeBridgeRunIds(rootState)], ["active-run"]);
assert.deepEqual(beginBridgeRunMaintenance(rootState), {
  ok: false,
  error: "storage_maintenance_active_runs",
  activeRuns: 1,
});
releaseRun();

const secondAdmission = beginBridgeRunMaintenance(rootState);
assert.equal(secondAdmission.ok, true);
assert.deepEqual(beginBridgeRunMaintenance(rootState), {
  ok: false,
  error: "storage_maintenance_in_progress",
  activeRuns: 0,
});
assert.equal(secondAdmission.ok && endBridgeRunMaintenance(rootState, secondAdmission.leaseId), true);

console.log("storage-maintenance-gate-harness ok");
