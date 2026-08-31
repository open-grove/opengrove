import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { UserLanguagePreference } from "../../core.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 App welcome markers with schemaVersion 1 and no locale list.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export function migrateAppWelcomeMarkerV2(
  path: string,
  expectedVersion: string,
  language: UserLanguagePreference,
): boolean {
  if (!existsSync(path)) return false;
  const source = readFileSync(path, "utf8");
  const marker = parseMarker(source);
  const version = stringValue(marker.version);
  if (marker.schemaVersion !== 1 || version !== expectedVersion) return false;

  // The marker is reconstructible from room history, so it does not need its own backup transaction.
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        appId: stringValue(marker.appId),
        version,
        locales: [language],
        sentAt: stringValue(marker.sentAt) || new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return true;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseMarker(source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
