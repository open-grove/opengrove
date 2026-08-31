import type {
  InvokedSkillRecord,
  JsonObject,
  SkillExecutionContext,
  SkillSource,
  SkillTrust,
  WorkingStateRecord,
} from "../types.js";

export class WorkingStateStore {
  private snapshot: WorkingStateRecord = createDefaultWorkingState();

  restore(snapshot: Partial<WorkingStateRecord> | undefined): void {
    this.snapshot = normalizeWorkingState(snapshot);
  }

  get(): WorkingStateRecord {
    return {
      ...this.snapshot,
      pinnedArtifactIds: [...this.snapshot.pinnedArtifactIds],
      workingArtifactIds: [...this.snapshot.workingArtifactIds],
      pendingApprovalIds: [...this.snapshot.pendingApprovalIds],
      pendingQuestionIds: [...this.snapshot.pendingQuestionIds],
      activeToolCallIds: [...this.snapshot.activeToolCallIds],
      discoveredSkillIds: [...this.snapshot.discoveredSkillIds],
      discoveredSkillNames: [...this.snapshot.discoveredSkillNames],
      expandedSkillIds: [...this.snapshot.expandedSkillIds],
      invokedSkills: this.snapshot.invokedSkills.map((record) => ({
        ...record,
        allowedTools: [...record.allowedTools],
      })),
      loadedNestedMemoryPaths: [...this.snapshot.loadedNestedMemoryPaths],
      toolSchemaCache: { ...this.snapshot.toolSchemaCache },
    };
  }

  update(patch: Partial<Omit<WorkingStateRecord, "updatedAt">>): WorkingStateRecord {
    this.snapshot = normalizeWorkingState({
      ...this.snapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return this.get();
  }

  clear(): WorkingStateRecord {
    this.snapshot = createDefaultWorkingState();
    return this.get();
  }
}

function createDefaultWorkingState(): WorkingStateRecord {
  return {
    pinnedArtifactIds: [],
    workingArtifactIds: [],
    pendingApprovalIds: [],
    pendingQuestionIds: [],
    activeToolCallIds: [],
    discoveredSkillIds: [],
    discoveredSkillNames: [],
    expandedSkillIds: [],
    invokedSkills: [],
    loadedNestedMemoryPaths: [],
    toolSchemaCache: {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWorkingState(input: Partial<WorkingStateRecord> | undefined): WorkingStateRecord {
  const base = createDefaultWorkingState();
  return {
    ...base,
    ...input,
    pinnedArtifactIds: normalizeStringArray(input?.pinnedArtifactIds),
    workingArtifactIds: normalizeStringArray(input?.workingArtifactIds),
    pendingApprovalIds: normalizeStringArray(input?.pendingApprovalIds),
    pendingQuestionIds: normalizeStringArray(input?.pendingQuestionIds),
    activeToolCallIds: normalizeStringArray(input?.activeToolCallIds),
    discoveredSkillIds: uniqueStrings(input?.discoveredSkillIds),
    discoveredSkillNames: uniqueStrings(input?.discoveredSkillNames),
    expandedSkillIds: uniqueStrings(input?.expandedSkillIds),
    invokedSkills: normalizeInvokedSkills(input?.invokedSkills),
    loadedNestedMemoryPaths: uniqueStrings(input?.loadedNestedMemoryPaths),
    toolSchemaCache: normalizeStringRecord(input?.toolSchemaCache),
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : base.updatedAt,
  };
}

function normalizeInvokedSkills(value: unknown): InvokedSkillRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      skillId: typeof item.skillId === "string" ? item.skillId : "",
      skillName: typeof item.skillName === "string" ? item.skillName : "",
      title: typeof item.title === "string" ? item.title : "",
      content: typeof item.content === "string" ? item.content : "",
      contentPreview: typeof item.contentPreview === "string" ? item.contentPreview : "",
      sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : "",
      source: normalizeSkillSource(item.source),
      trust: normalizeSkillTrust(item.trust),
      context: normalizeSkillContext(item.context),
      args: typeof item.args === "string" ? item.args : undefined,
      allowedTools: normalizeStringArray(item.allowedTools),
      model: typeof item.model === "string" ? item.model : undefined,
      effort: typeof item.effort === "string" ? item.effort : undefined,
      packId: typeof item.packId === "string" ? item.packId : undefined,
      capabilityId: typeof item.capabilityId === "string" ? item.capabilityId : undefined,
      invokedAt: typeof item.invokedAt === "string" ? item.invokedAt : new Date().toISOString(),
      origin: item.origin === "model" ? ("model" as const) : ("user" as const),
    }))
    .filter((record) => record.skillId && record.skillName && record.content);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "string"));
}

function normalizeSkillSource(value: unknown): SkillSource {
  return value === "bundled" || value === "project" || value === "user" || value === "pack" ? value : "project";
}

function normalizeSkillTrust(value: unknown): SkillTrust {
  return value === "untrusted" ? "untrusted" : "trusted";
}

function normalizeSkillContext(value: unknown): SkillExecutionContext {
  return value === "fork" ? "fork" : "inline";
}

function uniqueStrings(value: unknown): string[] {
  return [...new Set(normalizeStringArray(value))];
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
