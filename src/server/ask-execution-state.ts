import type { BridgeAskPayload, BridgeRuntimeOverride, BridgeState } from "./bridge-types.js";
import { recreateBridgeApp } from "./bridge-state.js";
import { resolveKernelProviderSelection } from "./kernel-utils.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";

/**
 * Resolves and reuses the in-memory runtime for one direct Kernel conversation.
 * Persisted settings remain the fallback route and are never rewritten to carry
 * a per-conversation selection.
 */
export function resolveAskExecutionState(
  state: BridgeState,
  payload: Pick<BridgeAskPayload, "kernel" | "model" | "providerId">,
): BridgeState {
  const rootState = state.rootState ?? state;
  const kernel = payload.kernel ?? rootState.kernel;
  const providerId = payload.providerId?.trim();
  const runtimeOverride: BridgeRuntimeOverride = {
    kernel,
    model: payload.model,
    ...(providerId ? { providerOverride: { providerId } } : {}),
  };
  const scopedState = {
    ...rootState,
    rootState,
    appInitialized: rootState.appInitialized,
    directAskExecutionStates: undefined,
    roomKernelAdapters: undefined,
    kernelAdapter: undefined,
    kernelProviderId: undefined,
    kernelRuntimeModel: undefined,
    kernelUnavailableCode: undefined,
    kernelUnavailableReason: undefined,
    runtimeOverride,
    model: rootState.model,
    kernel,
    settings: { ...rootState.settings },
  } satisfies BridgeState;
  const providerRoute = resolveKernelProviderSelection(scopedState, kernel).route;
  const cacheKey = directAskExecutionStateKey({
    kernel,
    model: payload.model,
    providerId: providerRoute.providerId,
    workspaceRoot: resolveBridgeWorkspaceRoot(rootState.settings),
  });

  if (
    rootState.kernelAdapter &&
    !rootState.kernelUnavailableReason &&
    rootState.kernel === kernel &&
    rootState.model === payload.model &&
    rootState.kernelProviderId === providerRoute.providerId
  ) {
    return rootState;
  }

  const cachedState = rootState.directAskExecutionStates?.get(cacheKey);
  if (cachedState) return cachedState;

  recreateBridgeApp(scopedState);
  if (scopedState.kernelAdapter && !scopedState.kernelUnavailableReason) {
    const cache = rootState.directAskExecutionStates ?? new Map<string, BridgeState>();
    cache.set(cacheKey, scopedState);
    rootState.directAskExecutionStates = cache;
  }
  return scopedState;
}

export function directAskExecutionStateKey(input: {
  kernel: string;
  model: string;
  providerId: string;
  workspaceRoot: string;
}): string {
  return JSON.stringify(input);
}
