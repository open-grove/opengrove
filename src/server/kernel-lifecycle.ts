import type { BridgeState } from "./bridge-types.js";

type BridgeKernelAdapter = NonNullable<BridgeState["kernelAdapter"]>;

const activeAdapterReferences = new WeakMap<BridgeKernelAdapter, number>();
const retiredAdaptersByRoot = new WeakMap<BridgeState, Set<BridgeKernelAdapter>>();
const retiredAdapterRoots = new WeakMap<BridgeKernelAdapter, BridgeState>();

export function retainBridgeKernelAdapter(adapter: BridgeState["kernelAdapter"]): void {
  if (!adapter) return;
  activeAdapterReferences.set(adapter, (activeAdapterReferences.get(adapter) ?? 0) + 1);
}

export function releaseBridgeKernelAdapter(adapter: BridgeState["kernelAdapter"]): void {
  if (!adapter) return;
  const remaining = (activeAdapterReferences.get(adapter) ?? 0) - 1;
  if (remaining > 0) {
    activeAdapterReferences.set(adapter, remaining);
    return;
  }
  activeAdapterReferences.delete(adapter);
  const rootState = retiredAdapterRoots.get(adapter);
  if (!rootState) return;
  retiredAdapterRoots.delete(adapter);
  retiredAdaptersByRoot.get(rootState)?.delete(adapter);
  void disposeKernelWorker(adapter);
}

/** Keeps a replaced worker alive until the Runs that reference it finish. */
export function retireBridgeKernelAdapter(state: BridgeState, adapter: BridgeKernelAdapter): void {
  const rootState = state.rootState ?? state;
  if ((activeAdapterReferences.get(adapter) ?? 0) === 0) {
    void disposeKernelWorker(adapter);
    return;
  }
  const retired = retiredAdaptersByRoot.get(rootState) ?? new Set<BridgeKernelAdapter>();
  retired.add(adapter);
  retiredAdaptersByRoot.set(rootState, retired);
  retiredAdapterRoots.set(adapter, rootState);
}

/** Disposes current, pooled, and retired workers during server shutdown. */
export async function disposeBridgeKernelWorkers(state: BridgeState): Promise<void> {
  const rootState = state.rootState ?? state;
  const adapters = new Set<BridgeKernelAdapter>();
  if (rootState.kernelAdapter) adapters.add(rootState.kernelAdapter);
  for (const executionState of rootState.directAskExecutionStates?.values() ?? []) {
    if (executionState.kernelAdapter) adapters.add(executionState.kernelAdapter);
  }
  for (const adapter of rootState.roomKernelAdapters?.values() ?? []) adapters.add(adapter);
  for (const adapter of retiredAdaptersByRoot.get(rootState) ?? []) {
    adapters.add(adapter);
    retiredAdapterRoots.delete(adapter);
  }
  retiredAdaptersByRoot.delete(rootState);
  rootState.directAskExecutionStates?.clear();
  rootState.roomKernelAdapters?.clear();
  await Promise.all([...adapters].map(disposeKernelWorker));
}

async function disposeKernelWorker(adapter: BridgeKernelAdapter): Promise<void> {
  try {
    await adapter.dispose?.();
  } catch (error) {
    console.warn("bridge_kernel_worker_dispose_failed", {
      kernelId: adapter.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
