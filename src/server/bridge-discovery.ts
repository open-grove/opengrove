import type { BridgeState } from "./bridge-types.js";
import { internalBridgeBaseUrl } from "./internal-bridge-url.js";
import { writePrivateJsonAtomically } from "../storage/private-file.js";
import { bridgeDataPath } from "./storage-paths.js";
import { BRIDGE_DISCOVERY_FILE_NAME, type BridgeDiscoveryInfo } from "../bridge-discovery.js";

/** Publishes a hint for local clients; readers must probe it before use. */
export function writeBridgeDiscoveryFile(
  state: BridgeState,
  info: { host: string; port: number; startedAt: string },
): void {
  if (state.profile === "test") return;
  if (state.store.kind !== "json" && state.store.kind !== "sqlite") return;
  const url = internalBridgeBaseUrl(info.host, info.port);
  try {
    writePrivateJsonAtomically(bridgeDataPath(state, BRIDGE_DISCOVERY_FILE_NAME), {
      url,
      apiUrl: `${url}/api`,
      host: info.host,
      port: info.port,
      pid: process.pid,
      startedAt: info.startedAt,
    } satisfies BridgeDiscoveryInfo);
  } catch (error) {
    console.warn("bridge_discovery_file_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
