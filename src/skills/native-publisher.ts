import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject, SkillManifest } from "../core.js";
import { APP_CONFIG_DIR, APP_MANAGED_BY, APP_NATIVE_SKILL_MARKER_FILE } from "../identity.js";
import type { KernelAdapter, KernelAdapterContract, KernelCapabilities } from "../kernel/types.js";
import { getKernelPathContract } from "../server/kernel-registry.js";
import { isBridgeKernelId } from "../rooms/channel-store.js";

export type NativeSkillKernelId = "codex" | "claude-code" | "hermes" | string;

export type NativeSkillPublicationStatus =
  | "published"
  | "already_current"
  | "skipped_existing"
  | "pruned"
  | "failed"
  | "unsupported_kernel";

export interface NativeSkillPublicationRecord {
  kernelId: NativeSkillKernelId;
  skillId: string;
  skillName: string;
  sourceRoot: string;
  targetRoot: string;
  targetSkillRoot: string;
  status: NativeSkillPublicationStatus;
  reason: string;
  publishedAt: string;
}

export type NativeSkillPublicationMap = Map<string, NativeSkillPublicationRecord[]>;

export interface NativeSkillPublisherOptions {
  cwd?: string;
  kernelId: string;
  kernelCapabilities?: KernelCapabilities;
  contract?: KernelAdapterContract;
  skills: SkillManifest[];
}

interface NativeSkillTarget {
  kernelId: string;
  root: string;
  reason: string;
}

export function publishNativeSkills(options: NativeSkillPublisherOptions): NativeSkillPublicationMap {
  const records = new Map<string, NativeSkillPublicationRecord[]>();
  const target = resolveNativeSkillTarget(options.kernelId, options.cwd ?? process.cwd(), options.contract);
  if (!target || !options.kernelCapabilities?.knowledge?.nativeSkills) {
    for (const skill of options.skills) {
      addPublication(records, skill.id, {
        kernelId: options.kernelId,
        skillId: skill.id,
        skillName: skill.name,
        sourceRoot: skill.skillRoot,
        targetRoot: target?.root ?? "",
        targetSkillRoot: target ? join(target.root, skill.name) : "",
        status: "unsupported_kernel",
        reason: target ? "kernel_does_not_declare_native_skills" : "native_skill_target_not_configured",
        publishedAt: new Date().toISOString(),
      });
    }
    return records;
  }

  mkdirSync(target.root, { recursive: true });
  for (const skill of options.skills) {
    addPublication(records, skill.id, publishNativeSkill(skill, target));
  }
  for (const pruned of pruneOrphanedNativeSkills(target, new Set(options.skills.map((skill) => skill.name)))) {
    addPublication(records, pruned.skillId, pruned);
  }
  return records;
}

/**
 * The published mirror must equal the current catalog: a bundled skill that was
 * renamed or removed leaves an orphaned copy behind otherwise (and after a
 * rename, both old and new names would stay active in the kernel). Only copies
 * this auto-publisher created are reclaimed — markers from the extension
 * manager's manual publish channel (republishedAt) or with non-bundled sources
 * are left for their own unpublish flow.
 */
function pruneOrphanedNativeSkills(
  target: NativeSkillTarget,
  publishedNames: Set<string>,
): NativeSkillPublicationRecord[] {
  const pruned: NativeSkillPublicationRecord[] = [];
  let entries;
  try {
    entries = readdirSync(target.root, { withFileTypes: true });
  } catch {
    return pruned;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || publishedNames.has(entry.name)) continue;
    const skillRoot = join(target.root, entry.name);
    const marker = readNativeSkillMarker(skillRoot);
    if (!marker || marker.managedBy !== APP_MANAGED_BY) continue;
    if (typeof marker.republishedAt === "string") continue;
    const sourceRoot = typeof marker.sourceRoot === "string" ? marker.sourceRoot : "";
    if (!isPortableAppSkill(sourceRoot)) continue;
    const skillName = typeof marker.skillName === "string" && marker.skillName ? marker.skillName : entry.name;
    const skillId = typeof marker.skillId === "string" && marker.skillId ? marker.skillId : `skill.${skillName}`;
    const record: NativeSkillPublicationRecord = {
      kernelId: target.kernelId,
      skillId,
      skillName,
      sourceRoot,
      targetRoot: target.root,
      targetSkillRoot: skillRoot,
      status: "pruned",
      reason: "source_skill_no_longer_in_catalog",
      publishedAt: new Date().toISOString(),
    };
    try {
      rmSync(skillRoot, { recursive: true, force: true });
    } catch (error) {
      record.status = "failed";
      record.reason = error instanceof Error ? error.message : String(error);
    }
    pruned.push(record);
  }
  return pruned;
}

function readNativeSkillMarker(skillRoot: string): Record<string, unknown> | undefined {
  const markerPath = join(skillRoot, APP_NATIVE_SKILL_MARKER_FILE);
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    return marker && typeof marker === "object" && !Array.isArray(marker)
      ? (marker as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function nativeSkillPublicationsToMetadata(records: NativeSkillPublicationRecord[] | undefined): JsonObject {
  const usableRecords = (records ?? []).filter(
    (record) => record.status === "published" || record.status === "already_current",
  );
  return {
    nativeSkillTargets: usableRecords.map((record) => ({
      kernelId: record.kernelId,
      targetRoot: record.targetRoot,
      targetSkillRoot: record.targetSkillRoot,
      status: record.status,
      reason: record.reason,
      publishedAt: record.publishedAt,
    })),
  };
}

export function shouldExposeSkillTool(kernel?: KernelAdapter): boolean {
  const knowledge = kernel?.capabilities.knowledge;
  if (!knowledge?.nativeSkills) {
    return true;
  }
  return knowledge.toolMediatedSkills === true;
}

function publishNativeSkill(skill: SkillManifest, target: NativeSkillTarget): NativeSkillPublicationRecord {
  const publishedAt = new Date().toISOString();
  const sourceRoot = resolve(skill.skillRoot);
  const targetSkillRoot = join(target.root, skill.name);
  const alreadyInTarget = sameOrInside(sourceRoot, targetSkillRoot);
  const alreadyNativeForKernel = isNativeSkillForKernel(sourceRoot, target.kernelId);

  if (alreadyInTarget || alreadyNativeForKernel) {
    return {
      kernelId: target.kernelId,
      skillId: skill.id,
      skillName: skill.name,
      sourceRoot,
      targetRoot: alreadyInTarget ? target.root : dirname(sourceRoot),
      targetSkillRoot: alreadyInTarget ? targetSkillRoot : sourceRoot,
      status: "already_current",
      reason: "skill_already_lives_in_kernel_native_directory",
      publishedAt,
    };
  }

  if (!isPortableAppSkill(sourceRoot)) {
    return {
      kernelId: target.kernelId,
      skillId: skill.id,
      skillName: skill.name,
      sourceRoot,
      targetRoot: target.root,
      targetSkillRoot,
      status: "skipped_existing",
      reason: `source_skill_is_not_${APP_MANAGED_BY}_portable_skill`,
      publishedAt,
    };
  }

  if (existsSync(targetSkillRoot) && !isAppManagedNativeSkill(targetSkillRoot)) {
    return {
      kernelId: target.kernelId,
      skillId: skill.id,
      skillName: skill.name,
      sourceRoot,
      targetRoot: target.root,
      targetSkillRoot,
      status: "skipped_existing",
      reason: `target_skill_exists_without_${APP_MANAGED_BY}_marker`,
      publishedAt,
    };
  }

  try {
    rmSync(targetSkillRoot, { recursive: true, force: true });
    mkdirSync(dirname(targetSkillRoot), { recursive: true });
    cpSync(sourceRoot, targetSkillRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
      filter(source) {
        return !source.endsWith(APP_NATIVE_SKILL_MARKER_FILE);
      },
    });
    writeFileSync(
      join(targetSkillRoot, APP_NATIVE_SKILL_MARKER_FILE),
      `${JSON.stringify(
        {
          managedBy: APP_MANAGED_BY,
          kernelId: target.kernelId,
          sourceRoot,
          sourceEntry: skill.entry,
          skillId: skill.id,
          skillName: skill.name,
          targetReason: target.reason,
          publishedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      kernelId: target.kernelId,
      skillId: skill.id,
      skillName: skill.name,
      sourceRoot,
      targetRoot: target.root,
      targetSkillRoot,
      status: "published",
      reason: target.reason,
      publishedAt,
    };
  } catch (error) {
    return {
      kernelId: target.kernelId,
      skillId: skill.id,
      skillName: skill.name,
      sourceRoot,
      targetRoot: target.root,
      targetSkillRoot,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      publishedAt,
    };
  }
}

function resolveNativeSkillTarget(
  kernelId: string,
  cwd: string,
  contract?: KernelAdapterContract,
): NativeSkillTarget | undefined {
  const projectRoot = resolve(cwd);
  const pathContract = contract?.paths ?? (isBridgeKernelId(kernelId) ? getKernelPathContract(kernelId) : undefined);
  const projectSkillDir = pathContract?.projectSkillDir;
  if (projectSkillDir) {
    return {
      kernelId,
      root: join(projectRoot, projectSkillDir),
      reason: `${kernelId}_project_skill_directory`,
    };
  }
  return undefined;
}

function isAppManagedNativeSkill(skillRoot: string): boolean {
  return readNativeSkillMarker(skillRoot)?.managedBy === APP_MANAGED_BY;
}

function isPortableAppSkill(sourceRoot: string): boolean {
  const normalized = sourceRoot.split("\\").join("/");
  return (
    normalized.includes(`/${APP_CONFIG_DIR}/skills/`) ||
    normalized.endsWith(`/${APP_CONFIG_DIR}/skills`) ||
    normalized.includes("/src/skills/bundled/") ||
    normalized.includes("/src/packs/bundled/")
  );
}

function isNativeSkillForKernel(sourceRoot: string, kernelId: string, contract?: KernelAdapterContract): boolean {
  const normalized = sourceRoot.split("\\").join("/");
  const pathContract = contract?.paths ?? (isBridgeKernelId(kernelId) ? getKernelPathContract(kernelId) : undefined);
  const marker = pathContract?.nativeSkillMarker;
  return marker ? normalized.includes(marker) : false;
}

function addPublication(
  records: NativeSkillPublicationMap,
  skillId: string,
  record: NativeSkillPublicationRecord,
): void {
  const key = skillId.replace(/^skill\./, "");
  const idKey = skillId;
  records.set(idKey, [...(records.get(idKey) ?? []), record]);
  records.set(`skill.${key}`, [...(records.get(`skill.${key}`) ?? []), record]);
}

function sameOrInside(left: string, right: string): boolean {
  const resolvedLeft = safeRealpath(left);
  const resolvedRight = safeRealpath(right);
  if (resolvedLeft === resolvedRight) {
    return true;
  }
  const relation = relative(resolvedRight, resolvedLeft);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function defaultHermesExternalSkillDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), APP_CONFIG_DIR, "native-skills", "hermes");
}

export function defaultHermesUserSkillDir(): string {
  return join(homedir(), ".hermes", "skills");
}
