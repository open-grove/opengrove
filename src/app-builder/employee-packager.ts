import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SkillManifest } from "../core.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { DEFAULT_BRIDGE_MODEL_ID, LEGACY_NATIVE_MODEL_ID, type BridgeState } from "../server/bridge-types.js";
import { publicEmployeeRole } from "../server/bridge-mounted-app-employees.js";
import { normalizeModelForKernelDisplay } from "../server/kernel-registry.js";
import { resolveSystemEmployeeRuntime } from "../server/system-employee-runtime.js";
import { tarCommand } from "../archive/tar-command.js";
import type { EmployeePackManifest } from "./manifest.js";

export interface EmployeePackResult {
  archivePath: string;
  archiveSha256: string;
  manifest: EmployeePackManifest;
  warnings: string[];
}

export interface EmployeePackOptions {
  memberId: string;
  outputPath: string;
  state: BridgeState;
  publisher?: string;
  title?: string;
  summary?: string;
  category?: string;
}

export function packEmployeeFromState(options: EmployeePackOptions): EmployeePackResult {
  const member = options.state.app.rooms.listMembers().find((candidate) => candidate.id === options.memberId);
  if (!member) {
    throw new Error(`employee_member_not_found:${options.memberId}`);
  }
  const publicEmployeeSlug = normalizePackageId(member.name) || "employee";
  const publicEmployeeId = normalizePackageId(`${publicEmployeeSlug}-${shortHash(member.id).slice(0, 8)}`);
  const packageId = normalizePackageId(`employee-${publicEmployeeSlug}-${shortHash(member.id)}`);
  if (!packageId) {
    throw new Error("employee_package_id_required");
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-employee-pack-"));
  const packRoot = join(tempRoot, packageId);
  const warnings: string[] = [];
  const skills = collectEmployeeSkills(options.state, member, warnings);
  try {
    mkdirSync(packRoot, { recursive: true });
    for (const skill of skills) {
      if (skill.source === "bundled") continue;
      if (!existsSync(skill.skillRoot)) {
        warnings.push(`${skill.name}:skill_root_missing`);
        continue;
      }
      const target = join(packRoot, "skills", safeDirectoryName(skill.name || skill.id));
      safeCopyTree(skill.skillRoot, target);
    }

    const toolIds = uniqueStrings(skills.flatMap((skill) => [...skill.toolIds, ...skill.allowedTools]));
    const tools = toolIds.map((toolId) => {
      const spec = options.state.app.tools.get(toolId)?.spec;
      return {
        id: toolId,
        ...(spec?.title ? { title: spec.title } : {}),
        ...(spec?.description ? { description: spec.description } : {}),
        source: "skill",
      };
    });
    const defaultSkillIds = uniqueStrings(member.defaultSkillIds ?? []);
    const availableSkillIds = uniqueStrings([
      ...(member.availableSkillIds ?? member.defaultSkillIds ?? []),
      ...defaultSkillIds,
    ]);
    const role = publicEmployeeRole(member.role);
    const model = publicEmployeeModel(options.state, member);
    const publicSummary = member.publicDescription?.trim();
    const manifest: EmployeePackManifest = {
      publishKind: "employee",
      id: packageId,
      title: options.title?.trim() || `${member.name} Employee Pack`,
      summary: options.summary?.trim() || publicSummary || `${member.name} for OpenGrove Rooms.`,
      version: "0.1.0",
      ...(options.publisher?.trim() ? { publisher: options.publisher.trim() } : {}),
      employee: {
        id: publicEmployeeId,
        name: member.name,
        role,
        kernel: member.kernel,
        model,
        ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
        ...(member.contextTokenBudget ? { contextTokenBudget: member.contextTokenBudget } : {}),
        availableSkillIds,
        defaultSkillIds,
        color: member.color,
        ...(member.visibility ? { visibility: member.visibility } : {}),
        ...(member.publicDescription ? { publicDescription: member.publicDescription } : {}),
        ...(member.publicSkills?.length ? { publicSkills: member.publicSkills } : {}),
        ...(member.inputSpec ? { inputSpec: member.inputSpec } : {}),
        ...(member.outputSpec ? { outputSpec: member.outputSpec } : {}),
        ...(member.avatarMode ? { avatarMode: member.avatarMode } : {}),
        ...(member.avatarSeed ? { avatarSeed: member.avatarSeed } : {}),
        ...(member.avatarDataUrl ? { avatarDataUrl: member.avatarDataUrl } : {}),
      },
      dependencies: {
        kernels: uniqueStrings([member.kernel]),
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          title: skill.title,
          description: skill.description,
          source: skill.source,
          bundled: skill.source === "bundled",
          path: skill.source === "bundled" ? undefined : `skills/${safeDirectoryName(skill.name || skill.id)}`,
          toolIds: [...skill.toolIds],
          allowedTools: [...skill.allowedTools],
        })),
        tools,
      },
      store: {
        category: options.category?.trim() || "员工",
        requirements: ["OpenGrove Rooms", `${member.kernel} kernel`],
        capabilities: [
          ...defaultSkillIds.map((skillId) => `Skill: ${skillId}`),
          ...toolIds.map((toolId) => `Tool: ${toolId}`),
        ],
      },
    };
    writeFileSync(join(packRoot, "employee.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writePackageManifest(packRoot, packageId, manifest.version || "0.1.0");
    mkdirSync(dirname(resolve(options.outputPath)), { recursive: true });
    const archivePath = resolve(options.outputPath);
    rmSync(archivePath, { force: true });
    const result = spawnSync(tarCommand(), ["-czf", archivePath, "-C", tempRoot, packageId], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`employee_pack_tar_failed:${(result.stderr || result.stdout || "").trim()}`);
    }
    return {
      archivePath,
      archiveSha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
      manifest,
      warnings,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// The registry requires a package manifest with per-file hashes alongside the pack contents.
function writePackageManifest(packRoot: string, packageId: string, version: string): void {
  const files: Record<string, string> = {};
  for (const file of walkPackFiles(packRoot, "")) {
    files[file] = `sha256:${createHash("sha256")
      .update(readFileSync(join(packRoot, file)))
      .digest("hex")}`;
  }
  const packageManifest = {
    schemaVersion: 1 as const,
    publishKind: "employee" as const,
    packageId,
    appId: packageId,
    version,
    files,
    excluded: [],
  };
  writeFileSync(
    join(packRoot, ".opengrove-package-manifest.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    "utf8",
  );
}

function walkPackFiles(root: string, prefix: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relativePath));
    if (stat.isDirectory()) {
      output.push(...walkPackFiles(root, relativePath));
    } else if (stat.isFile()) {
      output.push(relativePath);
    }
  }
  return output;
}

function collectEmployeeSkills(state: BridgeState, member: RoomChannelMember, warnings: string[]): SkillManifest[] {
  const output: SkillManifest[] = [];
  for (const skillId of uniqueStrings([
    ...(member.availableSkillIds ?? member.defaultSkillIds ?? []),
    ...(member.defaultSkillIds ?? []),
  ])) {
    const skill = state.app.skills.get(skillId);
    if (!skill) {
      warnings.push(`${skillId}:skill_not_found`);
      continue;
    }
    output.push(skill);
  }
  return output;
}

function safeCopyTree(sourceRoot: string, targetRoot: string): void {
  const stat = lstatSync(sourceRoot);
  if (stat.isSymbolicLink()) {
    throw new Error("employee_pack_symlink_rejected");
  }
  if (stat.isDirectory()) {
    mkdirSync(targetRoot, { recursive: true });
    for (const name of readdirSync(sourceRoot)) {
      if (name === "node_modules" || name === ".git" || name === "__MACOSX") continue;
      safeCopyTree(join(sourceRoot, name), join(targetRoot, name));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error("employee_pack_entry_type_invalid");
  }
  mkdirSync(dirname(targetRoot), { recursive: true });
  copyFileSync(sourceRoot, targetRoot);
}

function normalizePackageId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeDirectoryName(value: string): string {
  return basename(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill",
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function publicEmployeeModel(state: BridgeState, member: RoomChannelMember): string {
  const model = normalizeModelForKernelDisplay(member.kernel, member.model);
  const systemRuntime = resolveSystemEmployeeRuntime(state);
  if (member.kernel === systemRuntime.kernel && (!model || model === LEGACY_NATIVE_MODEL_ID)) {
    return systemRuntime.model;
  }
  return model || systemRuntime.model || DEFAULT_BRIDGE_MODEL_ID;
}
