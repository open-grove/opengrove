import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bridgeDataPath } from "../server/storage-paths.js";
import type { BridgeState } from "../server/bridge-types.js";
import type { BridgeKernelId } from "../server/bridge-types.js";
import type {
  DisabledExtensionConfigRecord,
  ExtensionManagerState,
  ExtensionSourceOrigin,
  ManagedSkillLibraryRecord,
} from "./types.js";
import { EXTENSION_MANAGER_STATE_VERSION } from "./types.js";

export function extensionManagerStatePath(state: BridgeState): string {
  return bridgeDataPath(state, "extension-manager.json");
}

export function loadExtensionManagerState(state: BridgeState): ExtensionManagerState {
  const path = extensionManagerStatePath(state);
  if (!existsSync(path)) {
    return emptyExtensionManagerState();
  }
  try {
    return normalizeExtensionManagerState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyExtensionManagerState();
  }
}

export function saveExtensionManagerState(state: BridgeState, managerState: ExtensionManagerState): void {
  const path = extensionManagerStatePath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeExtensionManagerState(managerState), null, 2)}\n`, "utf8");
}

export function emptyExtensionManagerState(): ExtensionManagerState {
  return {
    version: EXTENSION_MANAGER_STATE_VERSION,
    skillLibrary: {},
    disabledOverlays: {},
    disabledConfigs: {},
  };
}

function normalizeExtensionManagerState(input: unknown): ExtensionManagerState {
  const source = record(input);
  const skillLibrary: Record<string, ManagedSkillLibraryRecord> = {};
  for (const [id, value] of Object.entries(record(source.skillLibrary))) {
    const item = record(value);
    const name = stringValue(item.name) || id;
    const sourceRoot = stringValue(item.sourceRoot);
    if (!sourceRoot) continue;
    const origin = normalizeOrigin(item.origin);
    skillLibrary[id] = {
      id: stringValue(item.id) || id,
      name,
      title: stringValue(item.title) || titleFromName(name),
      description: stringValue(item.description) || "",
      sourceRoot,
      createdAt: stringValue(item.createdAt) || new Date(0).toISOString(),
      updatedAt: stringValue(item.updatedAt) || stringValue(item.createdAt) || new Date(0).toISOString(),
      ...(origin ? { origin } : {}),
    };
  }

  const disabledOverlays: ExtensionManagerState["disabledOverlays"] = {};
  for (const [id, value] of Object.entries(record(source.disabledOverlays))) {
    const item = record(value);
    disabledOverlays[id] = {
      disabledAt: stringValue(item.disabledAt) || new Date(0).toISOString(),
      reason: stringValue(item.reason),
    };
  }

  const disabledConfigs: Record<string, DisabledExtensionConfigRecord> = {};
  for (const [id, value] of Object.entries(record(source.disabledConfigs))) {
    const item = record(value);
    const kind = item.kind === "mcp" || item.kind === "hook" ? item.kind : undefined;
    const name = stringValue(item.name);
    const configPath = stringValue(item.configPath);
    const configFormat = stringValue(item.configFormat);
    if (!kind || !name || !configPath || !configFormat) continue;
    disabledConfigs[id] = {
      id: stringValue(item.id) || id,
      kind,
      kernelId: stringValue(item.kernelId) as DisabledExtensionConfigRecord["kernelId"],
      name,
      configPath,
      configFormat,
      redacted: item.redacted === true,
      entry: record(item.entry) as DisabledExtensionConfigRecord["entry"],
      disabledAt: stringValue(item.disabledAt) || new Date(0).toISOString(),
    };
  }

  return {
    version: EXTENSION_MANAGER_STATE_VERSION,
    skillLibrary,
    disabledOverlays,
    disabledConfigs,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOrigin(value: unknown): ManagedSkillLibraryRecord["origin"] | undefined {
  const item = record(value);
  const origin = stringValue(item.origin);
  if (!origin) return undefined;
  return {
    origin: origin as ExtensionSourceOrigin,
    kernelId: stringValue(item.kernelId) as BridgeKernelId | undefined,
    path: stringValue(item.path),
    url: stringValue(item.url),
    packageId: stringValue(item.packageId),
    readonly: item.readonly === true,
    system: item.system === true,
  };
}

function titleFromName(name: string): string {
  return name
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
