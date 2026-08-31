import type { BridgeState } from "./bridge-types.js";
import { releaseBridgeKernelAdapter, retainBridgeKernelAdapter } from "./kernel-lifecycle.js";

interface ActiveRunRegistry {
  leasesByRunId: Map<string, Set<symbol>>;
  executionStatesByRunId: Map<string, BridgeState>;
  adaptersByRunId: Map<string, BridgeState["kernelAdapter"]>;
}

const registries = new WeakMap<BridgeState, ActiveRunRegistry>();

/**
 * Registers a producer that is still capable of resolving pending requests.
 * The returned release function is idempotent so terminal paths can share it.
 */
export function registerActiveBridgeRun(state: BridgeState, runId: string): () => void {
  const registry = registryForState(state);
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
