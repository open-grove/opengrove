import type { JsonObject, LoadedSkill, SkillCatalog, SkillManifest } from "../core.js";
import type { KnowledgeDocumentInput } from "./types.js";
import type { KnowledgeStore } from "./store.js";

export class KnowledgeSkillCatalogView implements SkillCatalog {
  constructor(
    private readonly base: SkillCatalog,
    private readonly knowledge: KnowledgeStore,
    private readonly options: KnowledgeSkillCatalogViewOptions = {},
  ) {
    this.syncAll();
  }

  list(): SkillManifest[] {
    const skills = this.base.list();
    for (const skill of skills) {
      this.syncSkill(skill);
    }
    return skills;
  }

  get(idOrName: string): SkillManifest | undefined {
    const skill = this.base.get(idOrName);
    if (skill) {
      this.syncSkill(skill);
    }
    return skill;
  }

  resolve(name: string, options?: { includeDisabled?: boolean }): SkillManifest | undefined {
    const skill = this.base.resolve(name, options);
    if (skill) {
      this.syncSkill(skill);
    }
    return skill;
  }

  load(name: string, args: string | undefined, sessionId: string): LoadedSkill {
    const loaded = this.base.load(name, args, sessionId);
    this.syncLoadedSkill(loaded);
    return loaded;
  }

  private syncAll(): void {
    for (const skill of this.base.list()) {
      this.syncSkill(skill);
    }
  }

  private syncSkill(skill: SkillManifest): void {
    this.knowledge.upsert(skillManifestToKnowledgeDocument(skill, undefined, this.options.extraMetadata?.(skill)));
    for (const document of this.options.extraDocuments?.(skill) ?? []) {
      this.knowledge.upsert(document);
    }
  }

  private syncLoadedSkill(loaded: LoadedSkill): void {
    this.knowledge.upsert(
      skillManifestToKnowledgeDocument(loaded.manifest, loaded, this.options.extraMetadata?.(loaded.manifest)),
    );
    for (const document of this.options.extraDocuments?.(loaded.manifest) ?? []) {
      this.knowledge.upsert(document);
    }
  }
}

export interface KnowledgeSkillCatalogViewOptions {
  extraMetadata?: (skill: SkillManifest) => JsonObject | undefined;
  extraDocuments?: (skill: SkillManifest) => Array<KnowledgeDocumentInput & { id: string }> | undefined;
}

export function createKnowledgeSkillCatalogView(
  base: SkillCatalog,
  knowledge: KnowledgeStore,
  options: KnowledgeSkillCatalogViewOptions = {},
): KnowledgeSkillCatalogView {
  return new KnowledgeSkillCatalogView(base, knowledge, options);
}

export function skillKnowledgeId(skillId: string): string {
  return `skill.${skillId.replace(/^skill\./, "")}`;
}

export function skillManifestToKnowledgeDocument(
  skill: SkillManifest,
  loaded?: LoadedSkill,
  extraMetadata: JsonObject = {},
): KnowledgeDocumentInput & { id: string } {
  return {
    id: skillKnowledgeId(skill.id),
    slug: `skill-${skill.name}`,
    type: "skill",
    title: skill.title || skill.name,
    body: loaded?.content ?? summarizeSkillManifest(skill),
    format: "markdown",
    tags: ["skill", skill.source, skill.trust, ...(skill.tags ?? []), ...skill.activities],
    sourceRefs: [
      {
        title: skill.title || skill.name,
        locator: loaded?.sourcePath ?? skill.entry,
      },
    ],
    scope: skill.source === "user" ? "user" : skill.source === "project" ? "project" : "global",
    lifecycle: skill.disableModelInvocation && !skill.userInvocable ? "draft" : "active",
    metadata: {
      skillId: skill.id,
      skillName: skill.name,
      entry: skill.entry,
      skillRoot: skill.skillRoot,
      source: skill.source,
      trust: skill.trust,
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      activities: skill.activities.join(","),
      toolIds: skill.toolIds.join(","),
      allowedTools: skill.allowedTools.join(","),
      packId: skill.packId ?? "",
      capabilityId: skill.capabilityId ?? "",
      contentLength: loaded?.content.length ?? skill.contentLength ?? 0,
      ...extraMetadata,
    },
  };
}

function summarizeSkillManifest(skill: SkillManifest): string {
  return [
    `Name: /${skill.name}`,
    `Description: ${skill.description}`,
    skill.whenToUse ? `When to use: ${skill.whenToUse}` : "",
    skill.argumentHint ? `Arguments: ${skill.argumentHint}` : "",
    skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
    skill.toolIds.length ? `Declared tools: ${skill.toolIds.join(", ")}` : "",
    skill.activities.length ? `Activities: ${skill.activities.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
