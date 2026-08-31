import type { JsonObject } from "../core.js";
import type { BridgeKernelId } from "../server/bridge-types.js";

export const EXTENSION_MANAGER_STATE_VERSION = 1;

export type ExtensionKind = "app" | "skill" | "mcp" | "plugin" | "hook" | "tool" | "cli";

export type ExtensionScope = "user" | "project" | "workspace" | "system" | "managed" | "external";

export type ExtensionSourceOrigin =
  | "opengrove"
  | "kernel"
  | "plugin"
  | "registry"
  | "git"
  | "local"
  | "system"
  | "unknown";

export type ExtensionDeploymentStatus = "enabled" | "disabled" | "unpublished" | "missing" | "unsupported";

export interface ExtensionSourceRef {
  origin: ExtensionSourceOrigin;
  kernelId?: BridgeKernelId;
  path?: string;
  url?: string;
  packageId?: string;
  readonly?: boolean;
  system?: boolean;
}

export interface ExtensionPermission {
  type: "filesystem" | "network" | "shell" | "env" | "model" | "unknown";
  values: string[];
}

export interface ExtensionCommandUsage {
  command: string;
  args: string[];
  envKeys: string[];
  parentKind: ExtensionKind;
  parentId: string;
  kernelId?: BridgeKernelId;
  configPath?: string;
  resolvedPath?: string;
  risk: "low" | "medium" | "high";
}

export interface ExtensionDeployment {
  id: string;
  itemId: string;
  kind: ExtensionKind;
  kernelId?: BridgeKernelId;
  scope: ExtensionScope;
  status: ExtensionDeploymentStatus;
  enabled: boolean;
  managedByOpenGrove: boolean;
  readonly: boolean;
  system: boolean;
  sourcePath?: string;
  targetPath?: string;
  configPath?: string;
  configFormat?: string;
  markerPath?: string;
  reason?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  metadata?: JsonObject;
}

export interface ManagedExtensionRecord {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  managedByOpenGrove: boolean;
  readonly: boolean;
  system: boolean;
  source: ExtensionSourceRef;
  deployments: ExtensionDeployment[];
  permissions: ExtensionPermission[];
  commandUsages: ExtensionCommandUsage[];
  parentId?: string;
  childIds: string[];
  tags: string[];
  metadata: JsonObject;
}

export interface ExtensionInventorySummary {
  itemCount: number;
  deploymentCount: number;
  byKind: Record<string, number>;
  byKernel: Record<string, number>;
  managedCount: number;
  systemCount: number;
}

export interface ExtensionInventory {
  scannedAt: string;
  workspaceRoot: string;
  items: ManagedExtensionRecord[];
  deployments: ExtensionDeployment[];
  commandUsages: ExtensionCommandUsage[];
  summary: ExtensionInventorySummary;
}

export interface ManagedSkillLibraryRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  sourceRoot: string;
  createdAt: string;
  updatedAt: string;
  origin?: ExtensionSourceRef;
}

export interface DisabledExtensionConfigRecord {
  id: string;
  kind: "mcp" | "hook";
  kernelId?: BridgeKernelId;
  name: string;
  configPath: string;
  configFormat: string;
  redacted: boolean;
  entry: JsonObject;
  disabledAt: string;
}

export interface ExtensionManagerState {
  version: number;
  skillLibrary: Record<string, ManagedSkillLibraryRecord>;
  disabledOverlays: Record<
    string,
    {
      disabledAt: string;
      reason?: string;
    }
  >;
  disabledConfigs: Record<string, DisabledExtensionConfigRecord>;
}

export interface ExtensionActionResult {
  ok: boolean;
  action: string;
  records: ExtensionDeployment[];
  warnings: string[];
}
