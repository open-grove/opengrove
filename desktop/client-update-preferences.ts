import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DesktopClientUpdatePreferences {
  autoDownload: boolean;
}

export const DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES: DesktopClientUpdatePreferences = {
  autoDownload: true,
};

export function readDesktopClientUpdatePreferences(path: string): DesktopClientUpdatePreferences {
  try {
    return normalizeDesktopClientUpdatePreferences(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES };
    }
    throw error;
  }
}

export function writeDesktopClientUpdatePreferences(path: string, preferences: DesktopClientUpdatePreferences): void {
  const normalized = normalizeDesktopClientUpdatePreferences(preferences);
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

export function normalizeDesktopClientUpdatePreferences(value: unknown): DesktopClientUpdatePreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES };
  }
  const object = value as Record<string, unknown>;
  return {
    autoDownload:
      typeof object.autoDownload === "boolean"
        ? object.autoDownload
        : DEFAULT_DESKTOP_CLIENT_UPDATE_PREFERENCES.autoDownload,
  };
}
