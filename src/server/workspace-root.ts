import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { BridgeSettings } from "./bridge-types.js";

export function normalizeWorkspaceRootValue(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const raw = value.trim();
  if (!raw) {
    return undefined;
  }
  const path = resolve(raw);
  try {
    return statSync(path).isDirectory() ? path : fallback;
  } catch {
    return fallback;
  }
}

export function resolveBridgeWorkspaceRoot(settings?: Pick<BridgeSettings, "workspaceRoot">): string {
  return normalizeWorkspaceRootValue(settings?.workspaceRoot, undefined) ?? process.cwd();
}

export function resolveConfiguredBridgeWorkspaceRoot(
  settings?: Pick<BridgeSettings, "workspaceRoot">,
): string | undefined {
  return normalizeWorkspaceRootValue(settings?.workspaceRoot, undefined);
}
