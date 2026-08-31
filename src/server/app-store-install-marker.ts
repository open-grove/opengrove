import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function readAppStorePackageInstallMarker(appRoot: string): Record<string, unknown> | undefined {
  const markerPath = join(resolve(appRoot), ".opengrove-store-package.json");
  if (!existsSync(markerPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
}
