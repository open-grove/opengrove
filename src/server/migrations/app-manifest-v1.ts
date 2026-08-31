import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  findAppManifestPath,
  validateAppManifest,
  validateAppManifestText,
  type OpenGroveAppManifest,
} from "../../app-builder/manifest.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 App manifests using legacy UI or employee-skill fields.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export interface MountedAppManifestMigrationResult {
  status: "missing" | "invalid" | "failed" | "current" | "requires-legacy-boundary" | "migrated";
  manifestPath?: string;
  backupPath?: string;
  migrations?: string[];
  sourceKind?: string;
  issues?: string[];
}

export function migrateMountedAppManifestV1(appRoot: string): MountedAppManifestMigrationResult {
  try {
    return migrateMountedAppManifestV1Unsafe(appRoot);
  } catch (error) {
    return {
      status: "failed",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function migrateMountedAppManifestV1Unsafe(appRoot: string): MountedAppManifestMigrationResult {
  const manifestPath = findAppManifestPath(appRoot);
  if (!manifestPath) return { status: "missing" };
  const entry = lstatSync(manifestPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return { status: "invalid", manifestPath, issues: ["manifest must be a regular file"] };
  }
  const source = readFileSync(manifestPath, "utf8");
  const parsed = validateAppManifestText(source);
  if (!parsed.manifest) {
    return { status: "invalid", manifestPath, issues: parsed.issues };
  }

  const ui = migrateAppUiManifestV1(parsed.manifest);
  const employees = migrateAppEmployeeSkillsV1(ui.manifest);
  const migrations = [...(ui.changed ? ["ui-surface-v1"] : []), ...(employees.changed ? ["employee-skills-v1"] : [])];
  if (!migrations.length) {
    return parsed.manifest.ui?.kind
      ? { status: "requires-legacy-boundary", manifestPath, sourceKind: parsed.manifest.ui.kind }
      : { status: "current", manifestPath };
  }

  const validation = validateAppManifest(employees.manifest);
  if (!validation.manifest) {
    return { status: "invalid", manifestPath, issues: validation.issues };
  }
  const backupPath = `${manifestPath}.${ui.changed ? "pre-ui-surface-v1" : "pre-manifest-v1"}.bak`;
  if (!existsSync(backupPath)) writeAtomic(backupPath, source, statSync(manifestPath).mode);
  writeAtomic(manifestPath, `${JSON.stringify(validation.manifest, null, 2)}\n`, statSync(manifestPath).mode);
  return {
    status: "migrated",
    manifestPath,
    backupPath,
    migrations,
    sourceKind: ui.sourceKind,
  };
}

export function migrateAppUiManifestV1(input: OpenGroveAppManifest): {
  manifest: OpenGroveAppManifest;
  changed: boolean;
  sourceKind?: "file-workbench" | "mcp-app";
} {
  const ui = input.ui;
  if (!ui || ui.surface || (ui.kind !== "file-workbench" && ui.kind !== "mcp-app")) {
    return { manifest: input, changed: false };
  }
  const sourceKind = ui.kind;
  const { kind: _kind, ...currentUi } = ui;
  if (sourceKind === "file-workbench") {
    return {
      changed: true,
      sourceKind,
      manifest: {
        ...input,
        ui: { ...currentUi, surface: "file-workbench" },
      },
    };
  }
  const { entry, tools, csp, permissions, ...viewUi } = currentUi;
  return {
    changed: true,
    sourceKind,
    manifest: {
      ...input,
      ui: {
        ...viewUi,
        surface: "view",
        view: {
          protocol: "mcp-app",
          ...(entry !== undefined ? { entry } : {}),
          ...(tools !== undefined ? { tools } : {}),
          ...(csp !== undefined ? { csp } : {}),
          ...(permissions !== undefined ? { permissions } : {}),
        },
      },
    },
  };
}

export function migrateAppEmployeeSkillsV1(input: OpenGroveAppManifest): {
  manifest: OpenGroveAppManifest;
  changed: boolean;
} {
  let changed = false;
  const migrateDeclarations = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((declaration) => {
      const employee = record(declaration);
      const skills = stringArray(employee.skills);
      if (!skills.length) return declaration;
      const { skills: _skills, ...current } = employee;
      changed = true;
      return {
        ...current,
        ...(stringArray(employee.defaultSkillIds).length ? {} : { defaultSkillIds: skills }),
        ...(stringArray(employee.availableSkillIds).length ? {} : { availableSkillIds: skills }),
      };
    });
  };
  const rooms = record(input.rooms);
  const capabilities = record(input.capabilities);
  const agentPack = record(input.agentPack);
  const manifest = {
    ...input,
    ...(Array.isArray(input.employees) ? { employees: migrateDeclarations(input.employees) } : {}),
    ...(Array.isArray(input.agents) ? { agents: migrateDeclarations(input.agents) } : {}),
    ...(input.rooms
      ? {
          rooms: {
            ...rooms,
            ...(Array.isArray(rooms.employees) ? { employees: migrateDeclarations(rooms.employees) } : {}),
            ...(Array.isArray(rooms.agents) ? { agents: migrateDeclarations(rooms.agents) } : {}),
          },
        }
      : {}),
    ...(input.capabilities
      ? {
          capabilities: {
            ...capabilities,
            ...(Array.isArray(capabilities.employees)
              ? { employees: migrateDeclarations(capabilities.employees) }
              : {}),
            ...(Array.isArray(capabilities.agents) ? { agents: migrateDeclarations(capabilities.agents) } : {}),
          },
        }
      : {}),
    ...(input.agentPack
      ? {
          agentPack: {
            ...agentPack,
            ...(Array.isArray(agentPack.employees) ? { employees: migrateDeclarations(agentPack.employees) } : {}),
            ...(Array.isArray(agentPack.agents) ? { agents: migrateDeclarations(agentPack.agents) } : {}),
          },
        }
      : {}),
  } as OpenGroveAppManifest;
  if (input.agent) {
    const migratedAgent = migrateDeclarations([input.agent]);
    manifest.agent = Array.isArray(migratedAgent) ? migratedAgent[0] : input.agent;
  }
  return changed ? { manifest, changed: true } : { manifest: input, changed: false };
}

function writeAtomic(path: string, source: string, mode: number): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, source, "utf8");
    chmodSync(tempPath, mode & 0o777);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean) : [];
}
