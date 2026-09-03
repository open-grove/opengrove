import type { RoomChannelMember } from "../../rooms/channel-store.js";
import type { BridgeKernelId, BridgeState } from "../bridge-types.js";
import { BRIDGE_KERNEL_IDS } from "../bridge-types.js";
import { bridgeKernelSupportsHostTools } from "../../kernel/host-tools.js";
import { recreateBridgeApp } from "../bridge-state.js";
import { UNCONFIGURED_PROVIDER_BINDING_ID } from "../bridge-types.js";
import { BridgeKernelUnavailableError, resolveKernelRuntimeModel } from "../kernel-selection.js";
import {
  getBridgeKernelDescriptor,
  getKernelContract,
  isKernelLoginRouteAvailable,
  readKernelLocalRouteProfile,
} from "../kernel-registry.js";
import { buildKernelDiscoverySnapshot, kernelConfigHome } from "../kernel-utils.js";
import { mountedAppSessionCompatibilityVersion, resolveMountedAppTarget } from "../mounted-apps.js";
import { resolveProviderRoute, type BridgeResolvedProviderRoute } from "../provider-profiles.js";
import { normalizeWorkspaceRootValue, resolveBridgeWorkspaceRoot } from "../workspace-root.js";
import { ROOM_RUN_SESSION_SCHEMA_VERSION } from "./constants.js";
import { hostMessage } from "../../localization/host-messages.js";
import type { SupportedLocale } from "../../localization/locale-registry.js";
import { evaluateKernelCapabilityRequirements } from "../../kernel/capabilities/requirements.js";
import type { KernelCapabilityId } from "../../kernel/capabilities/types.js";
import type { KernelCapabilityReport, KernelContractEvidenceProvider } from "../../kernel/capabilities/types.js";
import { buildKnownKernelCapabilityReport } from "../../kernel/capabilities/report-for-kernel.js";

export class RoomKernelCapabilityError extends Error {
  readonly details: {
    kernel: string;
    required: KernelCapabilityId[];
    missing: KernelCapabilityId[];
    invalid: string[];
  };

  constructor(details: {
    kernel: string;
    required?: KernelCapabilityId[];
    missing?: KernelCapabilityId[];
    invalid?: string[];
  }) {
    const required = details.required ?? [];
    const missing = details.missing ?? [];
    const invalid = details.invalid ?? [];
    super(
      invalid.length
        ? `room_member_kernel_capabilities_invalid:${details.kernel}:${invalid.join(",")}`
        : `room_member_kernel_capabilities_missing:${details.kernel}:${missing.join(",")}`,
    );
    this.name = "RoomKernelCapabilityError";
    this.details = { kernel: details.kernel, required, missing, invalid };
  }
}

export function assertRoomTargetKernelCapabilities(target: RoomChannelMember, report: KernelCapabilityReport): void {
  const result = evaluateKernelCapabilityRequirements(target.kernel, target.requiredKernelCapabilities, report);
  if (!result.ok) {
    throw new RoomKernelCapabilityError({
      kernel: target.kernel,
      required: result.required,
      missing: result.missing,
      invalid: result.invalid,
    });
  }
}

export function roomKernelCapabilityErrorMessage(error: unknown, language: SupportedLocale): string | undefined {
  if (!(error instanceof RoomKernelCapabilityError)) return undefined;
  if (error.details.invalid.length) {
    return hostMessage(language, "room.kernel_capabilities_invalid", {
      kernel: error.details.kernel,
      capabilities: error.details.invalid.join(", "),
    });
  }
  return hostMessage(language, "room.kernel_capabilities_missing", {
    kernel: error.details.kernel,
    capabilities: error.details.missing.join(", "),
  });
}

export class RoomProviderRouteError extends Error {
  constructor(
    readonly code: "room_member_provider_selection_required" | "room_member_provider_unavailable",
    readonly details: { kernel: string; model: string; providerId?: string; status?: string },
  ) {
    super(
      code === "room_member_provider_selection_required"
        ? `${code}:${details.kernel}:${details.model}`
        : `${code}:${details.providerId || "unknown"}:${details.status || "unknown"}`,
    );
    this.name = "RoomProviderRouteError";
  }
}

export function roomProviderRouteErrorMessage(error: unknown, language: SupportedLocale): string | undefined {
  if (!(error instanceof RoomProviderRouteError)) return undefined;
  if (error.code === "room_member_provider_selection_required") {
    return hostMessage(language, "room.provider_selection_required", { model: error.details.model });
  }
  const statusCodes = {
    disabled: "room.provider_status_disabled",
    "missing-key": "room.provider_status_missing_key",
    "missing-provider": "room.provider_status_missing_provider",
    unknown: "room.provider_status_unknown",
    unsupported: "room.provider_status_unsupported",
  } as const;
  const status =
    error.details.status && error.details.status in statusCodes
      ? hostMessage(language, statusCodes[error.details.status as keyof typeof statusCodes])
      : error.details.status || "unavailable";
  return hostMessage(language, "room.provider_unavailable", {
    provider: error.details.providerId || "Provider",
    status,
  });
}

/**
 * Builds the complete target execution environment. This may reload persisted
 * state and mounted Apps, so call it only when a Room Run is actually starting.
 * Pre-run HTTP routing gates must use roomTargetSupportsHostTools instead.
 */
export function roomExecutionState(
  state: BridgeState,
  target: RoomChannelMember,
  resolvedProviderRoute?: BridgeResolvedProviderRoute,
): BridgeState {
  if (!isBridgeKernelId(target.kernel)) {
    throw new Error(`room_member_kernel_not_runnable:${target.kernel || "unknown"}`);
  }
  const rootState = state.rootState ?? state;
  const rootWorkspaceRoot = resolveBridgeWorkspaceRoot(rootState.settings);
  const targetWorkspaceRoot = resolveRoomTargetWorkspaceRoot(rootState, target) ?? rootWorkspaceRoot;
  const providerRoute = resolvedProviderRoute ?? resolveRoomTargetProviderRoute(rootState, target);
  if (providerRoute.binding.kind === "unresolved") {
    throw new RoomProviderRouteError("room_member_provider_selection_required", {
      kernel: target.kernel,
      model: target.model || rootState.model,
    });
  }
  if (providerRoute.binding.kind === "provider" && providerRoute.binding.status !== "ready") {
    throw new RoomProviderRouteError("room_member_provider_unavailable", {
      kernel: target.kernel,
      model: target.model || rootState.model,
      providerId: providerRoute.providerId,
      status: providerRoute.binding.status,
    });
  }
  if (providerRoute.binding.kind === "login") {
    const descriptor = getBridgeKernelDescriptor(target.kernel);
    if (!descriptor.accountLogin) {
      throw new RoomProviderRouteError("room_member_provider_selection_required", {
        kernel: target.kernel,
        model: target.model || rootState.model,
      });
    }
    const loginProfile = readKernelLocalRouteProfile(target.kernel, {
      cwd: targetWorkspaceRoot,
      configHome: kernelConfigHome(rootState.settings, target.kernel),
    });
    if (!isKernelLoginRouteAvailable(loginProfile)) {
      throw new RoomProviderRouteError("room_member_provider_unavailable", {
        kernel: target.kernel,
        model: target.model || rootState.model,
        providerId: "Login",
        status: "missing-provider",
      });
    }
  }
  if (target.requiredKernelCapabilities?.length) {
    const discovery = buildKernelDiscoverySnapshot(target.kernel, rootState);
    assertRoomTargetKernelCapabilities(
      target,
      buildKnownKernelCapabilityReport(target.kernel, undefined, {
        ...(discovery.version ? { kernelVersion: discovery.version } : {}),
        runtimeMode: getKernelContract(target.kernel).labels.integrationMode,
        provider: capabilityEvidenceProvider(providerRoute, target.model || rootState.model),
      }),
    );
  }
  const concreteTargetModel = target.model || rootState.model;
  const modelScopesWorker = !getBridgeKernelDescriptor(target.kernel).thread.reuseAcrossModelChanges;
  const cacheKey = roomExecutionStateKey(
    target,
    targetWorkspaceRoot,
    providerRoute.providerId,
    modelScopesWorker ? concreteTargetModel : undefined,
  );
  const cachedAdapter = rootState.roomKernelAdapters?.get(cacheKey);
  const scopedState = {
    ...rootState,
    rootState,
    appInitialized: rootState.appInitialized,
    directAskExecutionStates: undefined,
    roomKernelAdapters: undefined,
    kernelAdapter: undefined,
    kernelProviderId: providerRoute.providerId,
    kernelRuntimeModel: undefined,
    kernelUnavailableCode: undefined,
    kernelUnavailableReason: undefined,
    model: target.model || rootState.model,
    runtimeOverride: {
      kernel: target.kernel,
      model: concreteTargetModel,
      providerOverride: { providerId: providerRoute.providerId },
    },
    settings: {
      ...rootState.settings,
      workspaceRoot: targetWorkspaceRoot,
    },
    kernel: target.kernel,
  } satisfies BridgeState;
  recreateBridgeApp(scopedState, { kernelAdapter: cachedAdapter });
  const pool = rootState.roomKernelAdapters ?? new Map<string, NonNullable<BridgeState["kernelAdapter"]>>();
  if (scopedState.kernelAdapter && !scopedState.kernelUnavailableReason) {
    pool.set(cacheKey, scopedState.kernelAdapter);
  }
  rootState.roomKernelAdapters = pool;
  return scopedState;
}

function capabilityEvidenceProvider(route: BridgeResolvedProviderRoute, model: string): KernelContractEvidenceProvider {
  if (route.binding.kind === "login") return { kind: "native", model };
  if (route.binding.kind !== "provider") return { kind: "unknown", model };
  const protocol = route.binding.profile?.protocol;
  return {
    kind:
      protocol === "openai-compatible" || protocol === "anthropic-compatible" || protocol === "gemini-compatible"
        ? protocol
        : "unknown",
    model,
  };
}

export function resolveRoomExecutionTarget(
  state: BridgeState,
  target: RoomChannelMember,
): {
  executionState: BridgeState;
  target: RoomChannelMember;
  providerRoute: BridgeResolvedProviderRoute;
} {
  const providerRoute = resolveRoomTargetProviderRoute(state, target);
  const executionState = roomExecutionState(state, target, providerRoute);
  if (executionState.kernelUnavailableReason) {
    throw new BridgeKernelUnavailableError(
      executionState.kernelUnavailableReason,
      executionState.kernelUnavailableCode,
    );
  }
  return {
    executionState,
    target: {
      ...target,
      model: resolveRoomTargetModel(executionState, target),
    },
    providerRoute,
  };
}

export function resolveRoomTargetProviderRoute(
  state: BridgeState,
  target: RoomChannelMember,
): BridgeResolvedProviderRoute {
  if (!isBridgeKernelId(target.kernel)) {
    return {
      providerId: UNCONFIGURED_PROVIDER_BINDING_ID,
      source: "unresolved",
      binding: { kind: "unresolved", status: "selection-required" },
    };
  }
  const rootState = state.rootState ?? state;
  return resolveProviderRoute(
    target.kernel,
    target.model,
    target.providerId,
    rootState.settings.modelProviderBindings,
    rootState.settings.customProviders,
  );
}

/** Pure capability lookup: no adapter construction, filesystem probes, or state I/O. */
export function roomTargetSupportsHostTools(target: RoomChannelMember): boolean {
  if (!isBridgeKernelId(target.kernel)) return false;
  return bridgeKernelSupportsHostTools(target.kernel);
}

export function resolveRoomTargetModel(state: BridgeState, target: RoomChannelMember): string {
  if (!isBridgeKernelId(target.kernel)) {
    return target.model || state.model;
  }
  return resolveKernelRuntimeModel(state, target.kernel, target.model);
}

export function roomAgentThreadId(
  roomId: string,
  targetId: string,
  targetKernel: string,
  runtimeFingerprint?: string,
): string {
  const fingerprintPart = runtimeFingerprint?.trim() ? `-${runtimeFingerprint.trim()}` : "";
  const safeTarget =
    `${roomId || "room"}-${targetId || "member"}-${targetKernel || "kernel"}-${ROOM_RUN_SESSION_SCHEMA_VERSION}${fingerprintPart}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );
  return `room-agent-${safeTarget}`;
}

export function roomAgentAppVersionKey(state: BridgeState, target: RoomChannelMember): string | undefined {
  const appId = target.appId?.trim();
  if (!appId) return undefined;
  const rootState = state.rootState ?? state;
  const mountedApp = resolveMountedAppTarget(rootState, appId);
  if (!mountedApp) return undefined;
  return `app-version-${mountedAppSessionCompatibilityVersion(mountedApp)}`;
}

function isBridgeKernelId(value: string | undefined): value is BridgeKernelId {
  return Boolean(value && (BRIDGE_KERNEL_IDS as readonly string[]).includes(value));
}

function resolveRoomTargetWorkspaceRoot(state: BridgeState, target: RoomChannelMember): string | undefined {
  const explicit = normalizeWorkspaceRootValue(target.workspaceRoot, undefined);
  if (explicit) {
    return explicit;
  }
  const appId = target.appId?.trim();
  if (appId) {
    return resolveMountedAppTarget(state, appId)?.workspaceRoot;
  }
  return resolveBridgeWorkspaceRoot(state.settings);
}

function roomExecutionStateKey(
  target: RoomChannelMember,
  workspaceRoot: string,
  providerId: string,
  runtimeModel?: string,
): string {
  return JSON.stringify({
    kernel: target.kernel,
    providerId,
    ...(runtimeModel ? { runtimeModel } : {}),
    workspaceRoot,
  });
}
