import type { AgentEvent, JsonObject } from "../core.js";
import type { BridgeState } from "./bridge-types.js";
import { releaseBridgeKernelAdapter, retainBridgeKernelAdapter } from "./kernel-lifecycle.js";

type InteractionKind = "approval" | "question";

interface InteractionOwner {
  runId: string;
  producerEpoch: number;
  kind: InteractionKind;
}

interface ActiveRunHandle {
  runId: string;
  producerEpoch: number;
  leases: Set<symbol>;
  executionState?: BridgeState;
  adapter?: BridgeState["kernelAdapter"];
  cancel?: () => void;
  interactionIds: Set<string>;
}

interface ActiveRunRegistry {
  handlesByRunId: Map<string, ActiveRunHandle>;
  ownersByInteractionId: Map<string, InteractionOwner>;
  ownersByNativeRequestId: Map<string, InteractionOwner>;
  nextProducerEpoch: number;
}

const registries = new WeakMap<BridgeState, ActiveRunRegistry>();

/** Registers one live producer. A lease release never closes a shared Kernel transport. */
export function registerActiveBridgeRun(
  state: BridgeState,
  runId: string,
  options: { cancel?: () => void } = {},
): () => void {
  const registry = registryForState(state);
  let handle = registry.handlesByRunId.get(runId);
  if (!handle) {
    handle = {
      runId,
      producerEpoch: ++registry.nextProducerEpoch,
      leases: new Set(),
      adapter: state.kernelAdapter,
      cancel: options.cancel,
      interactionIds: new Set(),
    };
    registry.handlesByRunId.set(runId, handle);
    retainBridgeKernelAdapter(handle.adapter);
  } else if (options.cancel) {
    handle.cancel = options.cancel;
  }
  const lease = Symbol(runId);
  handle.leases.add(lease);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = registry.handlesByRunId.get(runId);
    current?.leases.delete(lease);
    if (current && current.leases.size === 0) {
      settleOrphanedInteractions(state, current, "producer_lost");
      removeHandle(registry, current);
    }
  };
}

export function activeBridgeRunIds(state: BridgeState): ReadonlySet<string> {
  return new Set(registryForState(state).handlesByRunId.keys());
}

export function cancelAllActiveBridgeRuns(state: BridgeState): string[] {
  const canceled: string[] = [];
  for (const [runId, handle] of registryForState(state).handlesByRunId) {
    if (!handle.cancel) continue;
    handle.cancel();
    canceled.push(runId);
  }
  return canceled;
}

/** Cancels one Run through its registered producer without touching a shared Kernel transport. */
export function cancelActiveBridgeRun(state: BridgeState, runId: string | undefined): boolean {
  if (!runId) return false;
  const handle = registryForState(state).handlesByRunId.get(runId);
  if (!handle?.cancel) return false;
  handle.cancel();
  return true;
}

export async function waitForActiveBridgeRuns(state: BridgeState, timeoutMs: number): Promise<ReadonlySet<string>> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const active = activeBridgeRunIds(state);
    if (active.size === 0) return active;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    });
  }
  return activeBridgeRunIds(state);
}

/**
 * Records an honest Host-owned terminal boundary after shutdown grace expires.
 * The native Kernel may still have produced side effects, so this is FAILED with
 * outcomeUnknown rather than a synthetic user cancellation.
 */
export function reconcileActiveBridgeRunsAsProducerLost(
  state: BridgeState,
  runIds: Iterable<string>,
  reasonCode = "host_shutdown",
): void {
  const registry = registryForState(state);
  const rootState = state.rootState ?? state;
  let changed = false;
  for (const runId of runIds) {
    const handle = registry.handlesByRunId.get(runId);
    if (!handle) continue;
    settleOrphanedInteractions(state, handle, reasonCode);
    const run = rootState.app.sessions.getRun(runId);
    rootState.app.recordEvent(
      {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: {
          taskState: "TASK_STATE_FAILED",
          reasonCode,
          outcomeUnknown: true,
        },
        synthetic: true,
      },
      {
        sessionId: run?.sessionId ?? "browser-bridge",
        input: "Host shutdown grace expired before the producer confirmed a terminal outcome.",
      },
    );
    changed = true;
  }
  if (changed) rootState.store.saveFrom(rootState.app);
}

export function setActiveBridgeRunExecutionState(state: BridgeState, runId: string, executionState: BridgeState): void {
  const registry = registryForState(state);
  let handle = registry.handlesByRunId.get(runId);
  if (!handle) {
    handle = {
      runId,
      producerEpoch: ++registry.nextProducerEpoch,
      leases: new Set(),
      interactionIds: new Set(),
    };
    registry.handlesByRunId.set(runId, handle);
  }
  if (handle.adapter !== executionState.kernelAdapter) {
    releaseBridgeKernelAdapter(handle.adapter);
    retainBridgeKernelAdapter(executionState.kernelAdapter);
    handle.adapter = executionState.kernelAdapter;
  }
  handle.executionState = executionState;
}

export function registerActiveBridgeRunInteraction(
  state: BridgeState,
  input: { runId: string; kind: InteractionKind; interactionId: string; nativeRequestId?: string },
): void {
  const registry = registryForState(state);
  const handle = registry.handlesByRunId.get(input.runId);
  if (!handle) return;
  const owner = { runId: input.runId, producerEpoch: handle.producerEpoch, kind: input.kind };
  handle.interactionIds.add(input.interactionId);
  registry.ownersByInteractionId.set(input.interactionId, owner);
  if (input.nativeRequestId) registry.ownersByNativeRequestId.set(input.nativeRequestId, owner);
}

export function clearActiveBridgeRunExecutionState(state: BridgeState, runId: string): void {
  const registry = registryForState(state);
  const handle = registry.handlesByRunId.get(runId);
  if (!handle) return;
  if (handle.leases.size === 0) {
    settleOrphanedInteractions(state, handle, "producer_lost");
    removeHandle(registry, handle);
  }
}

export function activeBridgeRunExecutionState(state: BridgeState, runId: string | undefined): BridgeState | undefined {
  if (!runId) return undefined;
  return registryForState(state).handlesByRunId.get(runId)?.executionState;
}

export function activeBridgeRunExecutionStateForApproval(
  state: BridgeState,
  approvalId: string,
): BridgeState | undefined {
  return executionStateForInteraction(state, approvalId, "approval");
}

export function activeBridgeRunExecutionStateForQuestion(
  state: BridgeState,
  questionId: string,
): BridgeState | undefined {
  return executionStateForInteraction(state, questionId, "question");
}

export function activeBridgeRunOwnsInteraction(
  state: BridgeState,
  interactionId: string,
  kind: InteractionKind,
): boolean {
  return Boolean(executionStateForInteraction(state, interactionId, kind));
}

export function activeBridgeRunOwnsNativeRequest(
  state: BridgeState,
  nativeRequestId: string | undefined,
  kind: InteractionKind,
): boolean {
  if (!nativeRequestId) return true;
  const registry = registryForState(state);
  const owner = registry.ownersByNativeRequestId.get(nativeRequestId);
  if (!owner || owner.kind !== kind) return false;
  const handle = registry.handlesByRunId.get(owner.runId);
  return Boolean(handle && handle.producerEpoch === owner.producerEpoch);
}

function executionStateForInteraction(
  state: BridgeState,
  interactionId: string,
  kind: InteractionKind,
): BridgeState | undefined {
  const registry = registryForState(state);
  const owner = registry.ownersByInteractionId.get(interactionId);
  if (!owner || owner.kind !== kind) return undefined;
  const handle = registry.handlesByRunId.get(owner.runId);
  if (!handle || handle.producerEpoch !== owner.producerEpoch) return undefined;
  return handle.executionState;
}

function settleOrphanedInteractions(state: BridgeState, handle: ActiveRunHandle, reasonCode: string): void {
  const rootState = state.rootState ?? state;
  const app = handle.executionState?.app ?? rootState.app;
  const events: AgentEvent[] = [];
  for (const id of handle.interactionIds) {
    const approval = app.approvals.get(id);
    if (approval?.status === "pending" && isSameLoopKernelInteraction(approval.resume)) {
      const resolved = app.approvals.decide(id, "canceled", systemCancellation(reasonCode));
      rootState.app.approvals.upsert(resolved);
      events.push({ type: "approval.resolved", runId: handle.runId, request: resolved });
    }
    const question = app.questions.get(id);
    if (question?.status === "pending" && isSameLoopKernelInteraction(question.resume)) {
      const resolved = app.questions.decide(id, "canceled", systemCancellation(reasonCode));
      rootState.app.questions.upsert(resolved);
      events.push({ type: "question.answered", runId: handle.runId, question: resolved });
    }
  }
  if (!events.length) return;
  const run = rootState.app.sessions.getRun(handle.runId);
  for (const event of events) {
    rootState.app.recordEvent(event, {
      sessionId: run?.sessionId ?? "browser-bridge",
      input: "System settled an interaction after its producer ended.",
    });
  }
  rootState.store.saveFrom(rootState.app);
}

function isSameLoopKernelInteraction(resume: { type: string; continuation?: string } | undefined): boolean {
  return resume?.type === "kernel.native" && resume.continuation === "same-loop";
}

function systemCancellation(reasonCode: string): JsonObject {
  return { system: true, reasonCode };
}

function removeHandle(registry: ActiveRunRegistry, handle: ActiveRunHandle): void {
  registry.handlesByRunId.delete(handle.runId);
  for (const id of handle.interactionIds) {
    const owner = registry.ownersByInteractionId.get(id);
    if (owner?.producerEpoch === handle.producerEpoch) registry.ownersByInteractionId.delete(id);
  }
  for (const [id, owner] of registry.ownersByNativeRequestId) {
    if (owner.runId === handle.runId && owner.producerEpoch === handle.producerEpoch) {
      registry.ownersByNativeRequestId.delete(id);
    }
  }
  releaseBridgeKernelAdapter(handle.adapter);
}

function registryForState(state: BridgeState): ActiveRunRegistry {
  const rootState = state.rootState ?? state;
  let registry = registries.get(rootState);
  if (!registry) {
    registry = {
      handlesByRunId: new Map(),
      ownersByInteractionId: new Map(),
      ownersByNativeRequestId: new Map(),
      nextProducerEpoch: 0,
    };
    registries.set(rootState, registry);
  }
  return registry;
}
