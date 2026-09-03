import { randomUUID } from "node:crypto";
import type { BridgeState } from "./bridge-types.js";
import { releaseBridgeKernelAdapter, retainBridgeKernelAdapter } from "./kernel-lifecycle.js";

interface ActiveRunRegistry {
  leasesByRunId: Map<string, Set<symbol>>;
  executionStatesByRunId: Map<string, BridgeState>;
  adaptersByRunId: Map<string, BridgeState["kernelAdapter"]>;
  maintenanceLease?: { id: string; lastActivityAt: number };
}

const registries = new WeakMap<BridgeState, ActiveRunRegistry>();
const BRIDGE_RUN_MAINTENANCE_IDLE_TTL_MS = 5 * 60_000;

/**
 * Registers a producer that is still capable of resolving pending requests.
 * The returned release function is idempotent so terminal paths can share it.
 */
export function registerActiveBridgeRun(state: BridgeState, runId: string, now = Date.now()): () => void {
  const registry = registryForState(state);
  expireIdleMaintenanceLease(registry, now);
  if (registry.maintenanceLease) {
    throw new Error("bridge_runs_paused_for_storage_maintenance");
  }
  const lease = Symbol(runId);
  const leases = registry.leasesByRunId.get(runId) ?? new Set<symbol>();
  if (leases.size === 0) {
    registry.adaptersByRunId.set(runId, state.kernelAdapter);
    retainBridgeKernelAdapter(state.kernelAdapter);
  }
  leases.add(lease);
  registry.leasesByRunId.set(runId, leases);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = registry.leasesByRunId.get(runId);
    current?.delete(lease);
    if (current?.size === 0) {
      registry.leasesByRunId.delete(runId);
      registry.executionStatesByRunId.delete(runId);
      releaseBridgeKernelAdapter(registry.adaptersByRunId.get(runId));
      registry.adaptersByRunId.delete(runId);
    }
  };
}

export type BridgeRunMaintenanceAdmission =
  | { ok: true; leaseId: string }
  | { ok: false; error: "storage_maintenance_in_progress" | "storage_maintenance_active_runs"; activeRuns: number };

/**
 * Atomically closes run admission only when no producer lease is active.
 * JavaScript executes this check-and-set synchronously, so a new run cannot
 * enter between observing the empty registry and installing the gate.
 */
export function beginBridgeRunMaintenance(state: BridgeState, now = Date.now()): BridgeRunMaintenanceAdmission {
  const registry = registryForState(state);
  expireIdleMaintenanceLease(registry, now);
  if (registry.maintenanceLease) {
    return { ok: false, error: "storage_maintenance_in_progress", activeRuns: registry.leasesByRunId.size };
  }
  if (registry.leasesByRunId.size > 0) {
    return { ok: false, error: "storage_maintenance_active_runs", activeRuns: registry.leasesByRunId.size };
  }
  const leaseId = randomUUID();
  registry.maintenanceLease = { id: leaseId, lastActivityAt: now };
  return { ok: true, leaseId };
}

export function endBridgeRunMaintenance(state: BridgeState, leaseId: string): boolean {
  const registry = registryForState(state);
  if (!leaseId || registry.maintenanceLease?.id !== leaseId) return false;
  registry.maintenanceLease = undefined;
  return true;
}

export function bridgeRunMaintenanceActive(state: BridgeState, now = Date.now()): boolean {
  const registry = registryForState(state);
  expireIdleMaintenanceLease(registry, now);
  return Boolean(registry.maintenanceLease);
}

export function bridgeRunMaintenanceLeaseMatches(state: BridgeState, leaseId: string, now = Date.now()): boolean {
  const registry = registryForState(state);
  expireIdleMaintenanceLease(registry, now);
  if (!leaseId || registry.maintenanceLease?.id !== leaseId) return false;
  registry.maintenanceLease.lastActivityAt = now;
  return true;
}

export function renewBridgeRunMaintenanceLease(state: BridgeState, leaseId: string, now = Date.now()): boolean {
  const lease = registryForState(state).maintenanceLease;
  if (!leaseId || lease?.id !== leaseId) return false;
  lease.lastActivityAt = now;
  return true;
}

export function activeBridgeRunIds(state: BridgeState): ReadonlySet<string> {
  return new Set(registryForState(state).leasesByRunId.keys());
}

export function setActiveBridgeRunExecutionState(state: BridgeState, runId: string, executionState: BridgeState): void {
  const registry = registryForState(state);
  const previousAdapter = registry.adaptersByRunId.get(runId);
  if (previousAdapter !== executionState.kernelAdapter) {
    releaseBridgeKernelAdapter(previousAdapter);
    retainBridgeKernelAdapter(executionState.kernelAdapter);
    registry.adaptersByRunId.set(runId, executionState.kernelAdapter);
  }
  registry.executionStatesByRunId.set(runId, executionState);
}

export function clearActiveBridgeRunExecutionState(state: BridgeState, runId: string): void {
  const registry = registryForState(state);
  registry.executionStatesByRunId.delete(runId);
  releaseBridgeKernelAdapter(registry.adaptersByRunId.get(runId));
  registry.adaptersByRunId.delete(runId);
}

export function activeBridgeRunExecutionState(state: BridgeState, runId: string | undefined): BridgeState | undefined {
  if (!runId) return undefined;
  return registryForState(state).executionStatesByRunId.get(runId);
}

export function activeBridgeRunExecutionStateForApproval(
  state: BridgeState,
  approvalId: string,
): BridgeState | undefined {
  for (const executionState of registryForState(state).executionStatesByRunId.values()) {
    if (executionState.app.approvals.get(approvalId)) return executionState;
  }
  return undefined;
}

export function activeBridgeRunExecutionStateForQuestion(
  state: BridgeState,
  questionId: string,
): BridgeState | undefined {
  for (const executionState of registryForState(state).executionStatesByRunId.values()) {
    if (executionState.app.questions.get(questionId)) return executionState;
  }
  return undefined;
}

function registryForState(state: BridgeState): ActiveRunRegistry {
  const rootState = state.rootState ?? state;
  let registry = registries.get(rootState);
  if (!registry) {
    registry = {
      leasesByRunId: new Map(),
      executionStatesByRunId: new Map(),
      adaptersByRunId: new Map(),
    };
    registries.set(rootState, registry);
  }
  return registry;
}

function expireIdleMaintenanceLease(registry: ActiveRunRegistry, now: number): void {
  const lease = registry.maintenanceLease;
  if (lease && now - lease.lastActivityAt >= BRIDGE_RUN_MAINTENANCE_IDLE_TTL_MS) {
    registry.maintenanceLease = undefined;
  }
}
