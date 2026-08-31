import type { ComputerStateRecord, WorkingStateRecord } from "./bridge";
import { readLanguagePreference, resolveLanguage } from "./i18n";
import type { ResolvedLanguage } from "./i18n-types";
import { cachedCollator, cachedDateTimeFormat, cachedNumberFormat } from "./intl-formatters";
import { localeForLanguage } from "./locale";

export function summarize(text: string, max: number): string {
  const singleLine = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}...` : singleLine;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatDate(
  value: string,
  language: ResolvedLanguage = resolveLanguage(readLanguagePreference()),
): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : cachedDateTimeFormat(localeForLanguage(language), {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function formatNumber(
  value: number,
  language: ResolvedLanguage = resolveLanguage(readLanguagePreference()),
): string {
  return cachedNumberFormat(localeForLanguage(language)).format(value);
}

export function compareLocalizedText(
  left: string,
  right: string,
  language: ResolvedLanguage = resolveLanguage(readLanguagePreference()),
): number {
  return cachedCollator(localeForLanguage(language), {
    numeric: true,
    sensitivity: "base",
  }).compare(left, right);
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(isNonEmptyString))];
}

export function normalizeWorkingState(value: Partial<WorkingStateRecord> | undefined): WorkingStateRecord {
  return {
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : "",
    taskSummary: typeof value?.taskSummary === "string" ? value.taskSummary : "",
    activeGoal: typeof value?.activeGoal === "string" ? value.activeGoal : "",
    selectedModel: typeof value?.selectedModel === "string" ? value.selectedModel : "",
    activePackId: typeof value?.activePackId === "string" ? value.activePackId : "",
    activeSkillId: typeof value?.activeSkillId === "string" ? value.activeSkillId : "",
    pinnedArtifactIds: Array.isArray(value?.pinnedArtifactIds) ? value.pinnedArtifactIds.filter(isNonEmptyString) : [],
    workingArtifactIds: Array.isArray(value?.workingArtifactIds)
      ? value.workingArtifactIds.filter(isNonEmptyString)
      : [],
    pendingApprovalIds: Array.isArray(value?.pendingApprovalIds)
      ? value.pendingApprovalIds.filter(isNonEmptyString)
      : [],
    pendingQuestionIds: Array.isArray(value?.pendingQuestionIds)
      ? value.pendingQuestionIds.filter(isNonEmptyString)
      : [],
    activeToolCallIds: Array.isArray(value?.activeToolCallIds) ? value.activeToolCallIds.filter(isNonEmptyString) : [],
    discoveredSkillIds: Array.isArray(value?.discoveredSkillIds)
      ? value.discoveredSkillIds.filter(isNonEmptyString)
      : [],
    discoveredSkillNames: Array.isArray(value?.discoveredSkillNames)
      ? value.discoveredSkillNames.filter(isNonEmptyString)
      : [],
    expandedSkillIds: Array.isArray(value?.expandedSkillIds) ? value.expandedSkillIds.filter(isNonEmptyString) : [],
    invokedSkills: Array.isArray(value?.invokedSkills) ? value.invokedSkills : [],
    loadedNestedMemoryPaths: Array.isArray(value?.loadedNestedMemoryPaths)
      ? value.loadedNestedMemoryPaths.filter(isNonEmptyString)
      : [],
    toolSchemaCache:
      value?.toolSchemaCache && typeof value.toolSchemaCache === "object" && !Array.isArray(value.toolSchemaCache)
        ? value.toolSchemaCache
        : {},
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function createEmptyWorkingState(): WorkingStateRecord {
  return normalizeWorkingState({});
}

export function normalizeComputerState(value: Partial<ComputerStateRecord> | undefined): ComputerStateRecord {
  return {
    app: typeof value?.app === "string" ? value.app : "",
    windowTitle: typeof value?.windowTitle === "string" ? value.windowTitle : "",
    url: typeof value?.url === "string" ? value.url : "",
    focusedElement: typeof value?.focusedElement === "string" ? value.focusedElement : "",
    observation: typeof value?.observation === "string" ? value.observation : "",
    accessibilityTree: typeof value?.accessibilityTree === "string" ? value.accessibilityTree : "",
    screenshotArtifactId: typeof value?.screenshotArtifactId === "string" ? value.screenshotArtifactId : "",
    observedAt: typeof value?.observedAt === "string" ? value.observedAt : "",
    elements: Array.isArray(value?.elements)
      ? value.elements
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            role: typeof item.role === "string" ? item.role : "",
            name: typeof item.name === "string" ? item.name : "",
            value: typeof item.value === "string" ? item.value : "",
            description: typeof item.description === "string" ? item.description : "",
          }))
      : [],
  };
}

export function hasRenderableComputerState(computerState: ComputerStateRecord): boolean {
  return Boolean(
    computerState.app ||
      computerState.windowTitle ||
      computerState.url ||
      computerState.focusedElement ||
      computerState.observation ||
      computerState.screenshotArtifactId ||
      computerState.elements.length,
  );
}

export function sortedArtifacts(artifacts: any[]): any[] {
  return [...(Array.isArray(artifacts) ? artifacts : [])].sort((left, right) =>
    String(right?.updatedAt || right?.createdAt || "").localeCompare(String(left?.updatedAt || left?.createdAt || "")),
  );
}

export function sortedSessions(sessions: any[]): any[] {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) =>
    String(right?.updatedAt || right?.createdAt || "").localeCompare(String(left?.updatedAt || left?.createdAt || "")),
  );
}

export function sortedRuns(runs: any[]): any[] {
  return [...(Array.isArray(runs) ? runs : [])].sort((left, right) =>
    String(right?.updatedAt || right?.startedAt || "").localeCompare(String(left?.updatedAt || left?.startedAt || "")),
  );
}

export function sortedExecutions(executions: any[]): any[] {
  return [...(Array.isArray(executions) ? executions : [])].sort((left, right) =>
    String(right?.at || "").localeCompare(String(left?.at || "")),
  );
}

export function summarizeLocation(app: string, windowTitle: string, url: string): string {
  return [app, windowTitle, url].filter(Boolean).join(" · ");
}

export function formatReobserveText(data: any): string {
  if (!data?.needsReobserve) {
    return "";
  }
  const expected = summarizeLocation(data.expectedApp, data.expectedWindowTitle, data.expectedUrl);
  const current = summarizeLocation(data.currentApp, data.currentWindowTitle, data.currentUrl);
  return [
    data.message || "Computer state changed since this action was proposed.",
    expected ? `expected: ${expected}` : "",
    current ? `current: ${current}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatExecutionSummary(item: any): string {
  const data = item?.data || {};
  const lines = [
    item?.toolId ? `tool: ${item.toolId}` : "",
    item?.approvalId ? `approval: ${item.approvalId}` : "",
    item?.artifactId ? `artifact: ${item.artifactId}` : "",
    data.reason ? `reason: ${data.reason}` : "",
  ].filter(Boolean);
  const reobserve = formatReobserveText(data);
  if (reobserve) {
    lines.push(reobserve);
  } else if (data.message) {
    lines.push(data.message);
  }
  return lines.join("\n");
}

export function toolStatusFromResult(result: any): string {
  const value = result?.value || {};
  if (value?.needsReobserve || value?.status === "blocked") {
    return "blocked";
  }
  if (value?.status === "staged") {
    return "complete";
  }
  return result?.ok ? "complete" : "incomplete";
}
