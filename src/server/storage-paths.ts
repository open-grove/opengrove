import { dirname, resolve } from "node:path";
import type { BridgeState } from "./bridge-types.js";
import { readAppEnv } from "../identity.js";
import { defaultOpenGroveDataDir, defaultOpenGroveUserDataDir } from "../storage/default-data-dir.js";

export function bridgeDataDirectory(state: BridgeState): string {
  if (state.store.kind === "json" || state.store.kind === "sqlite") {
    return dirname(state.store.path);
  }
  return resolve(defaultOpenGroveDataDir());
}

export function bridgeDataPath(state: BridgeState, ...segments: string[]): string {
  return resolve(bridgeDataDirectory(state), ...segments);
}

export function bridgeUserDataDirectory(state: BridgeState): string {
  const explicitUserDataDir = readAppEnv("USER_DATA_DIR")?.trim();
  if (explicitUserDataDir) return resolve(explicitUserDataDir);
  const dataDir = bridgeDataDirectory(state);
  if (readAppEnv("DATA_DIR")?.trim()) return dataDir;
  return resolve(dataDir) === resolve(defaultOpenGroveDataDir()) ? resolve(defaultOpenGroveUserDataDir()) : dataDir;
}
