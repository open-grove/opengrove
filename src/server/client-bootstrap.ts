import { createHash } from "node:crypto";
import type { ClientBootstrap } from "#agent-protocol";
import { stateIdFor } from "../storage/state-identity.js";
import type { BridgeSecurity } from "./bridge-security.js";
import type { BridgeState } from "./bridge-types.js";

export function getClientBootstrap(state: BridgeState, security: BridgeSecurity): ClientBootstrap {
  const hostId =
    state.store.kind === "json" || state.store.kind === "sqlite"
      ? stateIdFor(state.store.path)
      : createHash("sha256").update(`opengrove:${state.profile}`).digest("hex").slice(0, 16);
  return {
    environment: state.runtimeEnvironment,
    auth: {
      mode: security.authMode,
      tokenRequired: security.authMode === "bridge-token" && Boolean(security.bridgeToken),
    },
    hostId,
    mcpApps: {
      ...(security.mcpAppSandboxOrigin ? { sandboxOrigin: security.mcpAppSandboxOrigin } : {}),
    },
  };
}
