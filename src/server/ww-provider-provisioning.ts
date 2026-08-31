import type { DiagnosticFacts } from "../diagnostics/problem-schema.js";
import type { BridgeKernelId, BridgeProviderProfile, BridgeState } from "./bridge-types.js";
import { recreateBridgeApp, saveBridgeSettings } from "./bridge-state.js";
import {
  WW_DEFAULT_MODEL_ID,
  WW_PROVIDER_ID,
  getAllBridgeProviderProfiles,
  providerCanBindKernel,
  resolveProviderApiKey,
  wwDefaultProviderModels,
} from "./provider-profiles.js";
import { providerServesModelSelection } from "./models-dev-catalog.js";
import {
  wwDiagnosticFacts,
  type WwApiKeySummary,
  type WwCreatedApiKey,
  type WwProviderCredentialsClient,
} from "./ww/index.js";
import {
  blockWwProviderRecovery,
  canonicalWwIssuer,
  claimWwProviderAccount,
  completeWwProviderProductDefaults,
  ensureWwProvisioningAttempt,
  hasPendingWwProviderProductDefaults,
  hasPendingWwProvisioningAttempt,
  isWwProviderRecoveryBlocked,
  readWwProviderLocalState,
  recordWwProviderOwnership,
  requestWwProviderProductDefaults,
  type WwProviderLocalState,
} from "./ww-provider-local-state.js";

const WW_PROVIDER_NAME = "WW";
const WW_PROVIDER_API_KEY_NAME = "OpenGrove WW Provider";
const WW_PROVIDER_KERNELS: BridgeKernelId[] = ["claude-code"];

interface ProvisioningCoordinator {
  byOperation: Map<string, Promise<WwProviderProvisioningResult>>;
  tail: Promise<void>;
}

interface WwProviderCredential {
  apiKey?: string;
  apiKeyEnv?: string;
}

type WwProvisioningMode = "login" | "recover-invalid-key";

export type WwKeyReconciliationState =
  | "pending-create-replay"
  | "no-local-key"
  | "owner-mismatch"
  | "missing"
  | "inactive"
  | "active"
  | "active-but-rejected";

interface WwKeyInspection {
  state: "owner-mismatch" | "missing" | "inactive" | "active";
  key?: WwApiKeySummary;
}

const provisioningByState = new WeakMap<BridgeState, ProvisioningCoordinator>();

export type WwProviderProvisioningResult =
  | {
      status: "configured" | "already-configured";
      providerId: "ww";
      createdApiKey: boolean;
      defaultedKernels: BridgeKernelId[];
      keyState: WwKeyReconciliationState;
    }
  | {
      status: "skipped";
      reason: "provider_disabled" | "recovery_blocked";
    }
  | {
      status: "failed";
      error: string;
      diagnosticFacts?: DiagnosticFacts;
    };

export async function provisionWwProviderAfterLogin(input: {
  state: BridgeState;
  client: WwProviderCredentialsClient;
  baseUrl: string;
  accessToken: string;
  userId: string;
}): Promise<WwProviderProvisioningResult> {
  // WW is the product default for every authenticated installation, not only
  // for accounts the service happened to create during this login request.
  requestWwProviderProductDefaults(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
  });
  return provisionWwProviderWithMode(input, "login");
}

export async function repairWwProviderAfterApiKeyInvalid(input: {
  state: BridgeState;
  client: WwProviderCredentialsClient;
  baseUrl: string;
  accessToken: string;
  userId: string;
}): Promise<WwProviderProvisioningResult> {
  return provisionWwProviderWithMode(input, "recover-invalid-key");
}

export function blockWwProviderAfterRepeatedApiKeyInvalid(input: {
  state: BridgeState;
  baseUrl: string;
  userId: string;
}): void {
  blockWwProviderRecovery(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
  });
  persistUnownedWwProvider(input);
}

async function provisionWwProviderWithMode(
  input: {
    state: BridgeState;
    client: WwProviderCredentialsClient;
    baseUrl: string;
    accessToken: string;
    userId: string;
  },
  mode: WwProvisioningMode,
): Promise<WwProviderProvisioningResult> {
  const issuer = canonicalWwIssuer(input.baseUrl);
  if (!input.userId.trim()) throw new Error("ww_user_id_missing");
  if (isWwProviderRecoveryBlocked(input.state, { issuer, userId: input.userId })) {
    persistUnownedWwProvider(input);
    return { status: "skipped", reason: "recovery_blocked" };
  }
  const operationKey = `${issuer}\n${input.userId.trim()}\n${mode}`;
  const coordinator = provisioningByState.get(input.state) ?? {
    byOperation: new Map(),
    tail: Promise.resolve(),
  };
  provisioningByState.set(input.state, coordinator);
  const existing = coordinator.byOperation.get(operationKey);
  if (existing) return existing;

  const previous = coordinator.tail;
  const execute = async (): Promise<WwProviderProvisioningResult> => {
    await previous;
    try {
      return await provisionWwProvider(input, mode);
    } catch (error) {
      // Existing WW model routes remain selected but deliberately keyless. New
      // users do not receive any default routes until a usable Key exists.
      persistFailedWwProvider(input);
      claimWwProviderAccount(input.state, { issuer: input.baseUrl, userId: input.userId });
      const diagnosticFacts = wwDiagnosticFacts(error);
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(diagnosticFacts ? { diagnosticFacts } : {}),
      };
    }
  };
  const provisioning = execute().finally(() => {
    if (coordinator.byOperation.get(operationKey) === provisioning) {
      coordinator.byOperation.delete(operationKey);
    }
  });
  coordinator.byOperation.set(operationKey, provisioning);
  coordinator.tail = provisioning.then(
    () => undefined,
    () => undefined,
  );
  return provisioning;
}

async function provisionWwProvider(
  input: {
    state: BridgeState;
    client: WwProviderCredentialsClient;
    baseUrl: string;
    accessToken: string;
    userId: string;
  },
  mode: WwProvisioningMode,
): Promise<WwProviderProvisioningResult> {
  const configuredWw = input.state.settings.customProviders.find((profile) => profile.id === WW_PROVIDER_ID);
  const productDefaultsPending = hasPendingWwProviderProductDefaults(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
  });
  const existing = getAllBridgeProviderProfiles(input.state.settings.customProviders).find(
    (profile) => profile.id === WW_PROVIDER_ID,
  );
  if (configuredWw?.enabled === false || configuredWw?.deleted === true || existing?.enabled === false) {
    if (productDefaultsPending) {
      completeWwProviderProductDefaults(input.state, { issuer: input.baseUrl, userId: input.userId });
    }
    return { status: "skipped", reason: "provider_disabled" };
  }

  const existingApiKey = existing ? resolveProviderApiKey(existing) : undefined;
  const existingCredential = credentialForExistingWwProvider(existing, existingApiKey);
  const previousOwner = preclaimWwProvider(input, existing, existingApiKey, existingCredential);
  const pendingCreate = hasPendingWwProvisioningAttempt(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
  });
  const inspection =
    pendingCreate && !existingApiKey ? undefined : await inspectWwApiKey(input, existingApiKey, previousOwner);
  const ownedKey = mode === "login" && inspection?.state === "active" ? inspection.key : undefined;
  const keyState = reconciliationState({ mode, pendingCreate, existingApiKey, inspection });
  if (isWwProviderDisabledByUser(input.state)) {
    return { status: "skipped", reason: "provider_disabled" };
  }
  if (!ownedKey) {
    persistUnownedWwProvider(input);
  }
  const created = ownedKey ? undefined : await createWwApiKey(input);
  if (isWwProviderDisabledByUser(input.state)) {
    return { status: "skipped", reason: "provider_disabled" };
  }
  const apiKey = ownedKey ? existingApiKey : created?.apiKey;
  if (!apiKey?.trim()) {
    throw new Error("ww_api_key_missing");
  }

  const previousSettings = input.state.settings;
  const currentExisting = getAllBridgeProviderProfiles(previousSettings.customProviders).find(
    (candidate) => candidate.id === WW_PROVIDER_ID,
  );
  const credential = created ? { apiKey: created.apiKey } : existingCredential;
  const profile = wwProviderProfile(currentExisting, input.baseUrl, credential, false);
  const initializeProductDefaults = productDefaultsPending;
  const modelBindingUpdate = initializeProductDefaults
    ? addMissingWwModelDefaults(previousSettings.modelProviderBindings, profile, WW_PROVIDER_KERNELS)
    : { bindings: previousSettings.modelProviderBindings.map((binding) => ({ ...binding })), defaultedKernels: [] };
  const defaultedKernels = modelBindingUpdate.defaultedKernels;
  const nextCustomProviders = upsertWwProvider(previousSettings.customProviders, profile);
  const nextSettings = {
    ...previousSettings,
    customProviders: nextCustomProviders,
    modelProviderBindings: modelBindingUpdate.bindings,
  };

  const keyIdentity = created ?? ownedKey;
  if (!keyIdentity?.id || !keyIdentity.keyPrefix) {
    throw new Error("ww_api_key_identity_missing");
  }

  if (settingsEqual(previousSettings, nextSettings)) {
    recordWwProviderOwnership(input.state, {
      issuer: input.baseUrl,
      userId: input.userId,
      apiKeyId: keyIdentity.id,
      apiKeyPrefix: keyIdentity.keyPrefix,
    });
    if (productDefaultsPending) {
      completeWwProviderProductDefaults(input.state, { issuer: input.baseUrl, userId: input.userId });
    }
    return {
      status: "already-configured",
      providerId: WW_PROVIDER_ID,
      createdApiKey: Boolean(created),
      defaultedKernels: [],
      keyState,
    };
  }

  persistProviderSettings(
    input.state,
    previousSettings,
    nextSettings,
    initializeProductDefaults
      ? {
          mode: "apply-product-defaults",
          model: providerDefaultModelForCurrentRoute(input.state, previousSettings, previousSettings.kernel, profile),
        }
      : { mode: "preserve-runtime-selection" },
  );
  recordWwProviderOwnership(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
    apiKeyId: keyIdentity.id,
    apiKeyPrefix: keyIdentity.keyPrefix,
  });
  if (productDefaultsPending) {
    completeWwProviderProductDefaults(input.state, { issuer: input.baseUrl, userId: input.userId });
  }
  return {
    status: "configured",
    providerId: WW_PROVIDER_ID,
    createdApiKey: Boolean(created),
    defaultedKernels,
    keyState,
  };
}

function preclaimWwProvider(
  input: {
    state: BridgeState;
    baseUrl: string;
    userId: string;
  },
  existing: BridgeProviderProfile | undefined,
  existingApiKey: string | undefined,
  existingCredential: WwProviderCredential | undefined,
): WwProviderLocalState {
  const localState = readWwProviderLocalState(input.state);
  const locallyOwned = Boolean(
    existingApiKey &&
      localState.ownerIssuer === canonicalWwIssuer(input.baseUrl) &&
      localState.ownerUserId === input.userId &&
      localState.apiKeyId &&
      localState.apiKeyPrefix &&
      existingApiKey.startsWith(localState.apiKeyPrefix),
  );
  persistWwProvider(input, existing, existingCredential, existing?.provisioningBlocked === true || !locallyOwned);
  claimWwProviderAccount(input.state, { issuer: input.baseUrl, userId: input.userId });
  return localState;
}

function persistFailedWwProvider(input: { state: BridgeState; baseUrl: string }): void {
  const existing = getAllBridgeProviderProfiles(input.state.settings.customProviders).find(
    (profile) => profile.id === WW_PROVIDER_ID,
  );
  const apiKey = existing ? resolveProviderApiKey(existing) : undefined;
  const credential = credentialForExistingWwProvider(existing, apiKey);
  persistWwProvider(input, existing, credential, true);
}

function persistUnownedWwProvider(input: { state: BridgeState; baseUrl: string }): void {
  const existing = getAllBridgeProviderProfiles(input.state.settings.customProviders).find(
    (profile) => profile.id === WW_PROVIDER_ID,
  );
  persistWwProvider(input, existing, undefined, true);
}

function persistWwProvider(
  input: {
    state: BridgeState;
    baseUrl: string;
  },
  existing: BridgeProviderProfile | undefined,
  credential: WwProviderCredential | undefined,
  provisioningBlocked: boolean,
): void {
  if (isWwProviderDisabledByUser(input.state)) return;
  const previousSettings = input.state.settings;
  const profile = wwProviderProfile(existing, input.baseUrl, credential, provisioningBlocked);
  const nextSettings = {
    ...previousSettings,
    customProviders: upsertWwProvider(previousSettings.customProviders, profile),
  };
  if (!settingsEqual(previousSettings, nextSettings)) {
    persistProviderSettings(input.state, previousSettings, nextSettings, {
      mode: "preserve-runtime-selection",
    });
  }
}

async function inspectWwApiKey(
  input: {
    state: BridgeState;
    client: WwProviderCredentialsClient;
    baseUrl: string;
    accessToken: string;
    userId: string;
  },
  apiKey: string | undefined,
  localState: WwProviderLocalState,
): Promise<WwKeyInspection> {
  const keys = await input.client.listApiKeys(input.accessToken);
  if (!apiKey) return { state: "missing" };

  const issuer = canonicalWwIssuer(input.baseUrl);
  if (
    (localState.ownerIssuer && localState.ownerIssuer !== issuer) ||
    (localState.ownerUserId && localState.ownerUserId !== input.userId)
  ) {
    return { state: "owner-mismatch" };
  }

  const matching =
    localState.ownerIssuer === issuer &&
    localState.ownerUserId === input.userId &&
    localState.apiKeyId &&
    localState.apiKeyPrefix
      ? keys.find(
          (key) =>
            key.id === localState.apiKeyId &&
            key.keyPrefix === localState.apiKeyPrefix &&
            apiKey.startsWith(key.keyPrefix),
        )
      : keys.find((key) => apiKey.startsWith(key.keyPrefix));
  if (!matching) return { state: "missing" };
  if (matching.status !== "active" || isExpiredWwApiKey(matching)) {
    return { state: "inactive", key: matching };
  }
  return { state: "active", key: matching };
}

function reconciliationState(input: {
  mode: WwProvisioningMode;
  pendingCreate: boolean;
  existingApiKey: string | undefined;
  inspection: WwKeyInspection | undefined;
}): WwKeyReconciliationState {
  if (input.pendingCreate && !input.existingApiKey) return "pending-create-replay";
  if (!input.existingApiKey) return "no-local-key";
  if (input.mode === "recover-invalid-key" && input.inspection?.state === "active") {
    return "active-but-rejected";
  }
  return input.inspection?.state ?? "missing";
}

function isExpiredWwApiKey(key: WwApiKeySummary): boolean {
  if (!key.expiresAt) return false;
  const expiresAt = Date.parse(key.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

async function createWwApiKey(input: {
  state: BridgeState;
  client: WwProviderCredentialsClient;
  baseUrl: string;
  accessToken: string;
  userId: string;
}): Promise<WwCreatedApiKey> {
  const attempt = ensureWwProvisioningAttempt(input.state, {
    issuer: input.baseUrl,
    userId: input.userId,
  });
  return input.client.createApiKey(input.accessToken, WW_PROVIDER_API_KEY_NAME, {
    idempotencyKey: attempt.idempotencyKey,
  });
}

function wwProviderProfile(
  existing: BridgeProviderProfile | undefined,
  baseUrl: string,
  credential: WwProviderCredential | undefined,
  provisioningBlocked: boolean,
): BridgeProviderProfile {
  return {
    id: WW_PROVIDER_ID,
    name: existing?.name || WW_PROVIDER_NAME,
    custom: true,
    deleted: false,
    enabled: true,
    origin: "user",
    protocol: "anthropic-compatible",
    description: existing?.description || "WW Anthropic-compatible provider.",
    anthropicBaseUrl: baseUrl,
    ...(credential?.apiKey?.trim() ? { apiKey: credential.apiKey } : {}),
    ...(credential?.apiKeyEnv?.trim() ? { apiKeyEnv: credential.apiKeyEnv } : {}),
    ...(provisioningBlocked ? { provisioningBlocked: true } : {}),
    credentialKind: credential?.apiKeyEnv ? "env-key" : "api-key",
    models: existing?.models?.length ? existing.models : wwDefaultProviderModels(),
  };
}

function credentialForExistingWwProvider(
  existing: BridgeProviderProfile | undefined,
  resolvedApiKey: string | undefined,
): WwProviderCredential | undefined {
  if (!existing || !resolvedApiKey) return undefined;
  if (existing.apiKey?.trim()) return { apiKey: existing.apiKey.trim() };
  if (existing.apiKeyEnv?.trim()) return { apiKeyEnv: existing.apiKeyEnv.trim() };
  return undefined;
}

function isWwProviderDisabledByUser(state: BridgeState): boolean {
  const configured = state.settings.customProviders.find((profile) => profile.id === WW_PROVIDER_ID);
  return configured?.enabled === false || configured?.deleted === true;
}

function upsertWwProvider(
  providers: BridgeProviderProfile[] | undefined,
  profile: BridgeProviderProfile | undefined,
): BridgeProviderProfile[] {
  if (!profile) return providers ?? [];
  const output = (providers ?? []).filter((provider) => provider.id !== WW_PROVIDER_ID);
  output.push(profile);
  return output;
}

function persistProviderSettings(
  state: BridgeState,
  previousSettings: BridgeState["settings"],
  nextSettings: BridgeState["settings"],
  runtimeUpdate: { mode: "apply-product-defaults"; model?: string } | { mode: "preserve-runtime-selection" },
): void {
  const previousModel = state.model;
  const preserveRuntimeSelection = runtimeUpdate.mode === "preserve-runtime-selection";
  const previousMemberRuntime = preserveRuntimeSelection
    ? new Map(
        state.app.rooms.listMembers().map((member) => [
          member.id,
          {
            kernel: member.kernel,
            model: member.model,
            providerId: member.providerId,
          },
        ]),
      )
    : undefined;
  state.store.saveFrom(state.app);
  state.settings = nextSettings;
  if (runtimeUpdate.mode === "apply-product-defaults" && runtimeUpdate.model) {
    state.model = runtimeUpdate.model;
  }
  try {
    recreateBridgeApp(state);
    if (preserveRuntimeSelection) {
      state.model = previousModel;
      for (const member of state.app.rooms.listMembers()) {
        const previous = previousMemberRuntime?.get(member.id);
        if (!previous) continue;
        if (
          member.kernel === previous.kernel &&
          member.model === previous.model &&
          member.providerId === previous.providerId
        )
          continue;
        state.app.rooms.upsertMember(
          {
            ...member,
            kernel: previous.kernel,
            model: previous.model,
            providerId: previous.providerId,
          },
          { emitEvent: false },
        );
      }
      state.store.saveFrom(state.app);
    }
    saveBridgeSettings(state);
  } catch (error) {
    state.settings = previousSettings;
    state.model = previousModel;
    try {
      recreateBridgeApp(state);
    } catch (rollbackError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new AggregateError([error, rollbackError], `ww_provider_settings_rollback_failed:${originalMessage}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function providerDefaultModelForCurrentRoute(
  state: BridgeState,
  previousSettings: BridgeState["settings"],
  nextKernel: BridgeState["settings"]["kernel"],
  profile: BridgeProviderProfile | undefined,
): string | undefined {
  if (!profile || nextKernel !== "claude-code") return undefined;
  if (providerServesModelSelection(profile, state.model)) return undefined;
  const existingRoute = previousSettings.modelProviderBindings.find((binding) => binding.modelId === state.model);
  return existingRoute
    ? undefined
    : (profile.models.find((model) => model.id === WW_DEFAULT_MODEL_ID)?.id ?? profile.models[0]?.id);
}

function settingsEqual(left: BridgeState["settings"], right: BridgeState["settings"]): boolean {
  return (
    left.kernel === right.kernel &&
    JSON.stringify(left.customProviders) === JSON.stringify(right.customProviders) &&
    JSON.stringify(left.modelProviderBindings) === JSON.stringify(right.modelProviderBindings)
  );
}

function addMissingWwModelDefaults(
  current: BridgeState["settings"]["modelProviderBindings"],
  profile: BridgeProviderProfile | undefined,
  kernels: readonly BridgeKernelId[],
): { bindings: BridgeState["settings"]["modelProviderBindings"]; defaultedKernels: BridgeKernelId[] } {
  if (!profile) return { bindings: current.map((binding) => ({ ...binding })), defaultedKernels: [] };
  const bindings = current.map((binding) => ({ ...binding }));
  const supportedKernels = kernels.filter((kernelId) => providerCanBindKernel(kernelId, profile));
  if (!supportedKernels.length) return { bindings, defaultedKernels: [] };
  let added = false;
  const modelIds = new Set(profile.models.map((model) => model.id.trim()).filter(Boolean));
  for (const modelId of modelIds) {
    if (bindings.some((binding) => binding.modelId === modelId)) continue;
    bindings.push({ modelId, providerId: profile.id });
    added = true;
  }
  return { bindings, defaultedKernels: added ? supportedKernels : [] };
}
