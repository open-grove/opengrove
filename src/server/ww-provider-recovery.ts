import type { AgentEvent } from "../core.js";
import type { BridgeState } from "./bridge-types.js";
import { WW_PROVIDER_ID } from "./provider-profiles.js";
import { createWwHostedServices } from "./ww/index.js";
import {
  blockWwProviderAfterRepeatedApiKeyInvalid,
  repairWwProviderAfterApiKeyInvalid,
  type WwKeyReconciliationState,
} from "./ww-provider-provisioning.js";
import { canonicalWwIssuer, readWwProviderLocalState } from "./ww-provider-local-state.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";

export interface WwApiKeyRecoveryResult {
  repaired: boolean;
  reason?: "not_ww" | "account_changed" | "unsafe_retry" | "repair_failed";
  error?: string;
  keyState?: WwKeyReconciliationState;
}

export function isWwApiKeyInvalidError(value: string | undefined): boolean {
  const message = value?.trim();
  if (!message) return false;
  return /(?:\b110203\b|API_KEY_INVALID|api_key_invalid|invalid[^\n]{0,80}api key)/i.test(message);
}

export function isSafeWwApiKeyRetry(events: AgentEvent[]): boolean {
  return events.every(
    (event) =>
      event.type === "turn.started" ||
      event.type === "context.assembled" ||
      (event.type === "runtime.diagnostic" &&
        !/(?:hook|tool|approval|question|elicitation|plugin_install)/i.test(event.name)) ||
      event.type === "model.requested" ||
      event.type === "error" ||
      event.type === "turn.finished",
  );
}

export async function recoverWwApiKeyForExecution(input: {
  state: BridgeState;
  auth: BridgeWwRuntimeAuth | undefined;
  attemptEvents: AgentEvent[];
  error: string;
}): Promise<WwApiKeyRecoveryResult> {
  const rootState = input.state.rootState ?? input.state;
  if (!input.auth || input.state.kernelProviderId !== WW_PROVIDER_ID || !isWwApiKeyInvalidError(input.error)) {
    return { repaired: false, reason: "not_ww" };
  }
  if (!wwRecoveryAccountIsCurrent(rootState, input.auth)) {
    return { repaired: false, reason: "account_changed" };
  }
  if (!isSafeWwApiKeyRetry(input.attemptEvents)) {
    return { repaired: false, reason: "unsafe_retry" };
  }

  const result = await repairWwProviderAfterApiKeyInvalid({
    state: rootState,
    client: createWwHostedServices(input.auth.baseUrl).providerCredentials,
    baseUrl: input.auth.baseUrl,
    accessToken: input.auth.accessToken,
    userId: input.auth.userId,
  });
  if (result.status === "failed") {
    return { repaired: false, reason: "repair_failed", error: result.error };
  }
  if (result.status === "skipped") {
    return { repaired: false, reason: "repair_failed", error: result.reason };
  }
  return { repaired: true, keyState: result.keyState };
}

export function blockWwApiKeyRecoveryForExecution(input: {
  state: BridgeState;
  auth: BridgeWwRuntimeAuth | undefined;
  attemptEvents: AgentEvent[];
  error: string;
}): boolean {
  const rootState = input.state.rootState ?? input.state;
  if (
    !input.auth ||
    input.state.kernelProviderId !== WW_PROVIDER_ID ||
    !isWwApiKeyInvalidError(input.error) ||
    !isSafeWwApiKeyRetry(input.attemptEvents) ||
    !wwRecoveryAccountIsCurrent(rootState, input.auth)
  ) {
    return false;
  }
  blockWwProviderAfterRepeatedApiKeyInvalid({
    state: rootState,
    baseUrl: input.auth.baseUrl,
    userId: input.auth.userId,
  });
  return true;
}

function wwRecoveryAccountIsCurrent(state: BridgeState, auth: BridgeWwRuntimeAuth): boolean {
  try {
    const localState = readWwProviderLocalState(state);
    if (!localState.ownerIssuer && !localState.ownerUserId) return true;
    return localState.ownerIssuer === canonicalWwIssuer(auth.baseUrl) && localState.ownerUserId === auth.userId.trim();
  } catch {
    return false;
  }
}
