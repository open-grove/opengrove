import { appEnvName } from "../identity.js";
import { startOpenGroveServer } from "../server/create-server.js";
import type { LocalBridgeServerOptions } from "../server/bridge-types.js";

export function startWebSingleProfile(options: LocalBridgeServerOptions = {}) {
  process.env[appEnvName("WEB_AUTH_MODE")] = "session";
  process.env[appEnvName("ENABLE_BROWSER_UI")] = "1";
  return startOpenGroveServer({
    ...options,
    profile: "local",
    runtimeEnvironment: "web-single",
  });
}
