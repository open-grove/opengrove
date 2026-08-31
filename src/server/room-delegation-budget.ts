import type { BridgeState } from "./bridge-types.js";

export const DEFAULT_ROOM_DELEGATIONS_PER_RUN = 20;
export const DEFAULT_ROOM_DELEGATION_CHAIN_DEPTH = 5;

interface RoomDelegationBudget {
  targetIds: Set<string>;
  total: number;
}

export type RoomDelegationBudgetRejection = "duplicate_target" | "run_limit";

const budgetsByState = new WeakMap<BridgeState, Map<string, RoomDelegationBudget>>();

export function reserveRoomDelegationBudget(
  state: BridgeState,
  input: { sourceRunId: string; targetMemberId: string; maxDelegationsPerRun: number },
): { ok: true } | { ok: false; reason: RoomDelegationBudgetRejection } {
  const rootState = state.rootState ?? state;
  let budgets = budgetsByState.get(rootState);
  if (!budgets) {
    budgets = new Map();
    budgetsByState.set(rootState, budgets);
  }
  const budget = budgets.get(input.sourceRunId) ?? { targetIds: new Set<string>(), total: 0 };
  if (budget.targetIds.has(input.targetMemberId)) {
    return { ok: false, reason: "duplicate_target" };
  }
  if (budget.total >= input.maxDelegationsPerRun) {
    return { ok: false, reason: "run_limit" };
  }
  budget.targetIds.add(input.targetMemberId);
  budget.total += 1;
  budgets.set(input.sourceRunId, budget);
  return { ok: true };
}

export function releaseRoomDelegationBudget(
  state: BridgeState,
  input: { sourceRunId: string; targetMemberId: string },
): void {
  const rootState = state.rootState ?? state;
  const budgets = budgetsByState.get(rootState);
  const budget = budgets?.get(input.sourceRunId);
  if (!budget?.targetIds.delete(input.targetMemberId)) return;
  budget.total -= 1;
  if (budget.total === 0) budgets?.delete(input.sourceRunId);
}

export function clearRoomDelegationBudget(state: BridgeState, sourceRunId: string): void {
  const rootState = state.rootState ?? state;
  budgetsByState.get(rootState)?.delete(sourceRunId);
}
