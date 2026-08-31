import { dirname, resolve } from "node:path";
import type { BridgeState } from "./bridge-types.js";
import { defaultOpenGroveDataDir } from "../storage/default-data-dir.js";

export function bridgeDataDirectory(state: BridgeState): string {
  if (state.store.kind === "json" || state.store.kind === "sqlite") {
    return dirname(state.store.path);
  }
  return resolve(defaultOpenGroveDataDir());
}

export function bridgeDataPath(state: BridgeState, ...segments: string[]): string {
  return resolve(bridgeDataDirectory(state), ...segments);
}
