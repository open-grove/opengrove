import type {
  ApprovalRequest,
  ExecutionRecord,
  JsonObject,
  QuestionRequest,
  RunRecord,
  SessionRecord,
  SkillManifest,
  ToolSpec,
  WorkingStateRecord,
} from "../core.js";
import { compactBrowserJsonValue } from "./event-presentation.js";

const MAX_STATE_IDS = 200;

export function presentWorkingState(state: WorkingStateRecord): WorkingStateRecord {
  const slashCommands = state.toolSchemaCache["claude.slashCommands"];
  return {
    sessionId: compactText(state.sessionId, 512),
    taskSummary: compactText(state.taskSummary, 4_000),
    activeGoal: compactText(state.activeGoal, 4_000),
    selectedModel: compactText(state.selectedModel, 256),
    activePackId: compactText(state.activePackId, 512),
    activeSkillId: compactText(state.activeSkillId, 512),
    pinnedArtifactIds: compactIds(state.pinnedArtifactIds),
    workingArtifactIds: compactIds(state.workingArtifactIds),
    pendingApprovalIds: compactIds(state.pendingApprovalIds),
    pendingQuestionIds: compactIds(state.pendingQuestionIds),
    activeToolCallIds: compactIds(state.activeToolCallIds),
    discoveredSkillIds: compactIds(state.discoveredSkillIds),
    discoveredSkillNames: compactIds(state.discoveredSkillNames),
    expandedSkillIds: compactIds(state.expandedSkillIds),
    invokedSkills: state.invokedSkills.slice(-50).map((skill) => ({
      ...skill,
      skillId: compactText(skill.skillId, 512) ?? "",
      skillName: compactText(skill.skillName, 512) ?? "",
      title: compactText(skill.title, 512) ?? "",
      content: "",
      contentPreview: compactText(skill.contentPreview || skill.content, 2_000) ?? "",
      sourcePath: compactText(skill.sourcePath, 2_048) ?? "",
      args: compactText(skill.args, 2_000),
      allowedTools: compactIds(skill.allowedTools, 100),
    })),
    loadedNestedMemoryPaths: compactIds(state.loadedNestedMemoryPaths),
    toolSchemaCache: slashCommands ? { "claude.slashCommands": compactText(slashCommands, 32_000) ?? "" } : {},
    updatedAt: state.updatedAt,
  };
}

export function presentSessionSummaries(records: SessionRecord[]): SessionRecord[] {
  return records.map((record) => ({
    ...record,
    title: compactText(record.title, 512),
    runIds: compactIds(record.runIds, 500),
    lastUserInput: compactText(record.lastUserInput, 4_000),
    metadata: record.metadata ? (compactBrowserJsonValue(record.metadata, 4_000) as JsonObject) : undefined,
  }));
}

export function presentRunSummaries(records: RunRecord[]): RunRecord[] {
  return records.map((record) => ({
    ...record,
    input: compactText(record.input, 4_000) ?? "",
    summary: compactText(record.summary, 4_000),
    error: compactText(record.error, 4_000),
    pauseReason: compactText(record.pauseReason, 2_000),
    approvalIds: compactIds(record.approvalIds),
    questionIds: compactIds(record.questionIds),
    toolIds: compactIds(record.toolIds),
  }));
}

export function presentExecutionSummaries(records: ExecutionRecord[]): ExecutionRecord[] {
  return records.map((record) => ({
    ...record,
    title: compactText(record.title, 512) ?? "",
    status: compactText(record.status, 256),
    data: record.data ? (compactBrowserJsonValue(record.data, 8_000) as JsonObject) : undefined,
  }));
}

export function presentToolSummaries(records: ToolSpec[]): JsonObject[] {
  return records.map((record) => ({
    id: record.id,
    title: compactText(record.title, 512) ?? "",
    description: compactText(record.description, 2_000) ?? "",
    activity: record.activity,
    risk: record.risk,
    permission: {
      mode: record.permission.mode,
      reason: compactText(record.permission.reason, 2_000) ?? "",
    },
  }));
}

export function presentSkillSummaries(records: SkillManifest[]): JsonObject[] {
  return records.map((record) => {
    const summary: JsonObject = {
      id: record.id,
      name: record.name,
      title: compactText(record.title, 512) ?? "",
      description: compactText(record.description, 2_000) ?? "",
      entry: compactText(record.entry, 2_048) ?? "",
      skillRoot: compactText(record.skillRoot, 2_048) ?? "",
      activities: record.activities.slice(0, 20),
      toolIds: compactIds(record.toolIds, 100),
      allowedTools: compactIds(record.allowedTools, 100),
      userInvocable: record.userInvocable,
      disableModelInvocation: record.disableModelInvocation,
      source: record.source,
      trust: record.trust,
    };
    const optionalFields = {
      aliases: record.aliases?.slice(0, 50),
      whenToUse: compactText(record.whenToUse, 2_000),
      argumentHint: compactText(record.argumentHint, 1_000),
      arguments: record.arguments?.slice(0, 50).map((value) => compactText(value, 1_000) ?? ""),
      model: compactText(record.model, 256),
      effort: compactText(record.effort, 64),
      context: record.context,
      packId: compactText(record.packId, 512),
      capabilityId: compactText(record.capabilityId, 512),
      contentLength: record.contentLength,
      tags: record.tags?.slice(0, 50).map((value) => compactText(value, 128) ?? ""),
    };
    for (const [key, value] of Object.entries(optionalFields)) {
      if (value !== undefined) summary[key] = value;
    }
    return summary;
  });
}

export function presentApprovalSummaries(records: ApprovalRequest[]): ApprovalRequest[] {
  return records.map((record) => ({
    ...record,
    title: compactText(record.title, 512) ?? "",
    reason: compactText(record.reason, 4_000) ?? "",
    input: record.input === undefined ? undefined : compactBrowserJsonValue(record.input, 16_000),
    response: record.response === undefined ? undefined : compactBrowserJsonValue(record.response, 16_000),
    resume: undefined,
  }));
}

export function presentQuestionSummaries(records: QuestionRequest[]): QuestionRequest[] {
  return records.map((record) => ({
    ...record,
    title: compactText(record.title, 512) ?? "",
    prompt: compactText(record.prompt, 8_000) ?? "",
    input: record.input === undefined ? undefined : compactBrowserJsonValue(record.input, 16_000),
    response: record.response === undefined ? undefined : compactBrowserJsonValue(record.response, 16_000),
    resume: undefined,
  }));
}

function compactIds(values: string[], limit = MAX_STATE_IDS): string[] {
  return values.slice(-limit).map((value) => compactText(value, 512) ?? "");
}

function compactText(value: string | undefined, limit: number): string | undefined {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
