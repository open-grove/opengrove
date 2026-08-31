import type { InvokedSkillRecord, LoadedSkill, WorkingStateRecord } from "../core.js";

export function createInvokedSkillRecord(
  loaded: LoadedSkill,
  origin: InvokedSkillRecord["origin"],
): InvokedSkillRecord {
  return {
    skillId: loaded.manifest.id,
    skillName: loaded.manifest.name,
    title: loaded.manifest.title,
    content: loaded.content,
    contentPreview: summarizeSkillContent(loaded.content),
    sourcePath: loaded.sourcePath,
    source: loaded.manifest.source,
    trust: loaded.manifest.trust,
    context: loaded.manifest.context,
    args: loaded.args,
    allowedTools: [...loaded.manifest.allowedTools],
    model: loaded.manifest.model,
    effort: loaded.manifest.effort,
    packId: loaded.manifest.packId,
    capabilityId: loaded.manifest.capabilityId,
    invokedAt: new Date().toISOString(),
    origin,
  };
}

export function recordInvokedSkill(
  current: WorkingStateRecord,
  invocation: InvokedSkillRecord,
): Partial<WorkingStateRecord> {
  const existing = (current.invokedSkills ?? []).filter((item) => item.skillId !== invocation.skillId);
  return {
    activePackId: invocation.packId ?? current.activePackId,
    activeSkillId: invocation.skillId,
    discoveredSkillIds: uniqueIds([...(current.discoveredSkillIds ?? []), invocation.skillId]),
    discoveredSkillNames: uniqueIds([...(current.discoveredSkillNames ?? []), invocation.skillName]),
    expandedSkillIds: uniqueIds([...(current.expandedSkillIds ?? []), invocation.skillId]),
    invokedSkills: [invocation, ...existing].slice(0, 8),
  };
}

export function clearActiveSkillState(_current: WorkingStateRecord, reason: string): Partial<WorkingStateRecord> {
  if (reason === "clear-conversation") {
    return {
      activeSkillId: undefined,
      activePackId: undefined,
      discoveredSkillIds: [],
      discoveredSkillNames: [],
      expandedSkillIds: [],
      invokedSkills: [],
      loadedNestedMemoryPaths: [],
      toolSchemaCache: {},
    };
  }

  return {
    activeSkillId: undefined,
    activePackId: undefined,
  };
}

export function summarizeSkillContent(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length > 220 ? `${singleLine.slice(0, 217)}...` : singleLine;
}

export function buildSkillSteeringText(invocation: InvokedSkillRecord): string {
  const lines = [
    `Loaded skill: /${invocation.skillName}`,
    `Skill title: ${invocation.title}`,
    invocation.args ? `Arguments: ${invocation.args}` : "",
    invocation.allowedTools.length ? `Skill-declared tool scope: ${invocation.allowedTools.join(", ")}` : "",
    invocation.content,
  ].filter(Boolean);
  return lines.join("\n\n");
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
