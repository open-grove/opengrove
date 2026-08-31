import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { PackRegistry, type PackManifest, type SkillSource, type SkillTrust } from "../core.js";
import { APP_CONFIG_DIR } from "../identity.js";
import { packageRoot } from "../package-root.js";

interface CreatePackCatalogOptions {
  cwd?: string;
}

export function createPackRegistry(options: CreatePackCatalogOptions = {}): PackRegistry {
  const registry = new PackRegistry();
  for (const pack of loadPacks(options.cwd ?? process.cwd())) {
    registry.register(pack);
  }
  return registry;
}

function loadPacks(cwd: string): PackManifest[] {
  const roots = [
    {
      dir: resolve(packageRoot(), "src", "packs", "bundled"),
      source: "pack" as SkillSource,
      trust: "trusted" as SkillTrust,
    },
    {
      dir: join(resolve(homedir()), APP_CONFIG_DIR, "packs"),
      source: "user" as SkillSource,
      trust: "trusted" as SkillTrust,
    },
    { dir: resolve(cwd, APP_CONFIG_DIR, "packs"), source: "project" as SkillSource, trust: "trusted" as SkillTrust },
  ];

  const packs = new Map<string, PackManifest>();
  for (const root of roots) {
    if (!existsSync(root.dir)) {
      continue;
    }
    const entries = readdirSync(root.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const manifestPath = join(root.dir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<PackManifest>;
      const pack = normalizePack(raw, {
        id: `pack.${entry.name}`,
        title: titleFromName(entry.name),
        description: `${titleFromName(entry.name)} pack`,
        source: root.source,
        trust: root.trust,
        rootDir: join(root.dir, entry.name),
      });
      if (!packs.has(pack.id)) {
        packs.set(pack.id, pack);
      }
    }
  }

  return Array.from(packs.values());
}

function normalizePack(
  input: Partial<PackManifest>,
  fallback: Pick<PackManifest, "id" | "title" | "description" | "source" | "trust" | "rootDir">,
): PackManifest {
  return {
    id: typeof input.id === "string" ? input.id : fallback.id,
    title: typeof input.title === "string" ? input.title : fallback.title,
    description: typeof input.description === "string" ? input.description : fallback.description,
    source:
      input.source === "bundled" || input.source === "project" || input.source === "user" || input.source === "pack"
        ? input.source
        : fallback.source,
    trust: input.trust === "trusted" || input.trust === "untrusted" ? input.trust : fallback.trust,
    rootDir: typeof input.rootDir === "string" ? input.rootDir : fallback.rootDir,
    skillIds: normalizeStringArray(input.skillIds),
    toolIds: normalizeStringArray(input.toolIds),
    capabilityIds: normalizeStringArray(input.capabilityIds),
    artifactTypes: normalizeStringArray(input.artifactTypes),
    referenceAssetDirs: normalizeStringArray(input.referenceAssetDirs),
    tags: normalizeStringArray(input.tags),
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function titleFromName(name: string): string {
  return name
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
