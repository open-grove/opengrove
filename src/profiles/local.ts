import { startOpenGroveServer } from "../server/create-server.js";
import type { LocalBridgeServerOptions } from "../server/bridge-types.js";

export function startLocalProfile(options: LocalBridgeServerOptions = {}) {
  return startOpenGroveServer({
    ...options,
    profile: "local",
  });
}
