import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readAppEnv } from "../identity.js";

const PRODUCT_DIR_NAME = "OpenGrove";
export const SQLITE_STATE_FILE_NAME = "local-state.sqlite";
export const LEGACY_JSON_STATE_FILE_NAME = "local-state.json";

export function defaultOpenGroveUserDataDir(): string {
  const explicit = readAppEnv("USER_DATA_DIR");
  if (explicit?.trim()) return resolve(explicit.trim());

  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", PRODUCT_DIR_NAME);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), PRODUCT_DIR_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opengrove");
}

export function defaultOpenGroveDataDir(): string {
  const explicit = readAppEnv("DATA_DIR");
  if (explicit?.trim()) return resolve(explicit.trim());
  return join(defaultOpenGroveUserDataDir(), "data");
}

export function defaultOpenGroveStatePath(): string {
  const explicit = readAppEnv("STATE_PATH");
  if (explicit?.trim()) return resolve(explicit.trim());
  return join(defaultOpenGroveDataDir(), SQLITE_STATE_FILE_NAME);
}

export function defaultOpenGroveSettingsPath(): string {
  return join(defaultOpenGroveDataDir(), "bridge-settings.json");
}

export function defaultOpenGroveAppsDir(): string {
  return join(defaultOpenGroveUserDataDir(), "apps");
}

/**
 * Immutable Store App generations belong in local machine data. On Windows this
 * deliberately avoids roaming AppData: downloaded programs are reproducible and
 * can be large, while user Workspaces are the durable data users care about.
 */
export function defaultOpenGroveProgramsDir(): string {
  const explicit = readAppEnv("PROGRAMS_DIR");
  if (explicit?.trim()) return resolve(explicit.trim());

  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), PRODUCT_DIR_NAME, "programs");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", PRODUCT_DIR_NAME, "programs");
  }
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opengrove", "programs");
}

/** User-owned Store App data lives outside the replaceable program root. */
export function defaultOpenGroveWorkspacesDir(): string {
  const explicit = readAppEnv("WORKSPACES_DIR");
  if (explicit?.trim()) return resolve(explicit.trim());
  return join(homedir(), PRODUCT_DIR_NAME, "workspaces");
}
