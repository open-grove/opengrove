import {
  discoverOpenClawGatewayProviderProfiles,
  resolveOpenClawGatewayConnection,
} from "../runtime/openclaw-gateway-runtime.js";
import { saveBridgeSettings } from "./bridge-settings-store.js";
import type { BridgeProviderProfile, BridgeState } from "./bridge-types.js";
import { migrateLegacyNativeEmployeeProviderRoutes } from "./bridge-state.js";
import { kernelConfigHome, kernelPathEnv } from "./kernel-utils.js";

const refreshes = new WeakMap<BridgeState, Promise<boolean>>();

export function refreshOpenClawGatewayProviders(state: BridgeState): Promise<boolean> {
  const active = refreshes.get(state);
  if (active) return active;
  const refresh = refreshOpenClawGatewayProvidersOnce(state)
    .catch(() => false)
    .finally(() => refreshes.delete(state));
  refreshes.set(state, refresh);
  return refresh;
}

async function refreshOpenClawGatewayProvidersOnce(state: BridgeState): Promise<boolean> {
  const connection = resolveOpenClawGatewayConnection(
    {
      ...process.env,
      ...kernelPathEnv(state.settings, "openclaw"),
    },
    {
      configHome: kernelConfigHome(state.settings, "openclaw"),
    },
  );
  if (!connection) return false;

  let discovered: BridgeProviderProfile[];
  try {
    discovered = await discoverOpenClawGatewayProviderProfiles(connection);
  } catch {
    // A transient Gateway failure must not erase the last known catalog or user bindings.
    return false;
  }
  // An empty response can be a transient upstream/configuration state. Treat it
  // like a failed optional refresh instead of invalidating working bindings.
  if (!discovered.length) return false;

  const nextProviders = mergeOpenClawGatewayProviders(state.settings.customProviders, discovered);
  const providersChanged = JSON.stringify(nextProviders) !== JSON.stringify(state.settings.customProviders);
  if (providersChanged) {
    state.settings = {
      ...state.settings,
      customProviders: nextProviders,
    };
    saveBridgeSettings(state);
  }
  const employeeRoutesChanged = migrateLegacyNativeEmployeeProviderRoutes(state);
  if (employeeRoutesChanged) state.store.saveFrom(state.app);
  return providersChanged || employeeRoutesChanged;
}

export function mergeOpenClawGatewayProviders(
  current: BridgeProviderProfile[],
  discovered: BridgeProviderProfile[],
): BridgeProviderProfile[] {
  const retained = current.filter((provider) => !isOpenClawGatewayProvider(provider) || provider.deleted === true);
  const retainedIds = new Set(retained.map((provider) => provider.id));
  const currentGatewayProviders = new Map(
    current
      .filter((provider) => isOpenClawGatewayProvider(provider) && provider.deleted !== true)
      .map((provider) => [provider.id, provider]),
  );
  const refreshed = discovered
    .filter((provider) => !retainedIds.has(provider.id))
    .map((provider) => {
      const existing = currentGatewayProviders.get(provider.id);
      return existing?.enabled === false ? { ...provider, enabled: false } : provider;
    });
  return [...retained, ...refreshed];
}

function isOpenClawGatewayProvider(provider: BridgeProviderProfile): boolean {
  return (
    provider.origin === "discovered" &&
    provider.sourceKernel === "openclaw" &&
    provider.credentialKind === "gateway-managed"
  );
}
