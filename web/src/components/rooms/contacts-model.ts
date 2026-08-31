import type { ExtensionItemCollection, ExtensionItemRecord, KernelOption, SkillRecord } from "../../bridge";
import { compareLocalizedText } from "../../format";
import { translate } from "../../i18n";
import type { TranslationFn } from "../../i18n";
import { kernelBindingLabel, kernelUnavailableDescription } from "../../runtime/kernel-models";
import type { Room, RoomMember, RoomMessage } from "./rooms-model";

export type ContactSkillOption = {
  id: string;
  aliases: string[];
  itemId?: string;
  deploymentId?: string;
  name: string;
  title: string;
  description: string;
  sourceLabel: string;
  sourcePath?: string;
  publishedKernelIds: string[];
  toolIds: string[];
  allowedTools: string[];
};

export type EmployeeDetailPage = "overview" | "activity" | "capabilities" | "collaboration";

export type MemberActivitySnapshot = {
  currentWork: string;
  totalRuns: number;
  failedRuns: number;
  successRate: number;
  averageDuration: string;
  recentRuns: Array<{
    id: string;
    title: string;
    createdAt: string;
    duration: string;
    status: RoomMessage["status"];
    statusLabel: string;
  }>;
};

export function buildContactSkillOptions(
  skills: SkillRecord[],
  extensions: ExtensionItemCollection | undefined,
  t: TranslationFn = translate,
): ContactSkillOption[] {
  const byId = new Map<string, ContactSkillOption>();
  for (const item of extensions?.items ?? []) {
    if (item.kind !== "skill") continue;
    mergeSkillOption(byId, skillOptionFromExtensionItem(item, t));
  }
  for (const skill of skills) {
    const option = skillOptionFromSkillRecord(skill, t);
    if (option) mergeSkillOption(byId, option);
  }
  return [...byId.values()].sort((left, right) => {
    const leftTitle = (left.title || left.name).toLowerCase();
    const rightTitle = (right.title || right.name).toLowerCase();
    return compareLocalizedText(leftTitle, rightTitle);
  });
}

export function contactKernelSubline(kernel: KernelOption, t: TranslationFn = translate): string {
  if (!kernel.available) {
    const status = kernel.installed
      ? t("settings.installedButUnavailable")
      : kernel.executableProbe?.role === "optional-diagnostic"
        ? t("common.unavailable")
        : t("settings.notInstalled");
    const detail = kernelUnavailableDescription(kernel, t);
    return detail ? `${status} · ${detail}` : status;
  }
  return kernelBindingLabel(kernel, t) || kernel.version || t("common.available");
}

export function employeeTagLabel(value: string | undefined, fallback: string): string {
  const firstLine = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return shortText(firstLine || fallback, 36);
}

export function effectiveMemberSkillIds(member: RoomMember, skills: ContactSkillOption[]): string[] {
  const selected = normalizeSkillIds(member.defaultSkillIds);
  return normalizeSkillIds(selected.map((skillId) => findContactSkillOption(skills, skillId)?.id ?? skillId));
}

export function effectiveMemberAvailableSkillIds(member: RoomMember, skills: ContactSkillOption[]): string[] {
  const required = effectiveMemberSkillIds(member, skills);
  if (member.availableSkillIds === undefined) {
    return required;
  }
  const available = member.availableSkillIds.map((skillId) => findContactSkillOption(skills, skillId)?.id ?? skillId);
  return normalizeSkillIds([...available, ...required]);
}

export function normalizeSkillIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** Local employees share one runtime-edit policy, including product defaults. */
export function canEditEmployeeRuntime(member: RoomMember | undefined): boolean {
  return Boolean(member && (!member.source || member.source === "local"));
}

const APP_EMPLOYEE_OVERRIDE_NAME_ITEM = "name";
const APP_EMPLOYEE_OVERRIDE_MODEL_ITEM = "model";

export const APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS = {
  name: APP_EMPLOYEE_OVERRIDE_NAME_ITEM,
  avatarMode: "avatar",
  avatarSeed: "avatar",
  avatarDataUrl: "avatar",
  role: "role",
  kernel: "kernel",
  model: APP_EMPLOYEE_OVERRIDE_MODEL_ITEM,
  color: "avatar",
  availableSkillIds: "availableSkills",
  defaultSkillIds: "requiredSkills",
  reasoningEffort: "reasoningEffort",
  contextTokenBudget: "contextTokenBudget",
  accessMode: "accessMode",
  visibility: "visibility",
  publicDescription: "publicDescription",
  publicSkills: "publicSkills",
  inputSpec: "inputSpec",
  outputSpec: "outputSpec",
} as const;

export type AppEmployeeOverrideField = keyof typeof APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS;
export type AppEmployeeOverrideItem = (typeof APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS)[AppEmployeeOverrideField];

function isAppEmployeeOverrideField(field: string): field is AppEmployeeOverrideField {
  return Object.prototype.hasOwnProperty.call(APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS, field);
}

export function appEmployeeOverrideFields(member: RoomMember | undefined): AppEmployeeOverrideField[] {
  if (!member?.appId || !member.manifestDefaults) return [];
  return member.userOverrides?.filter(isAppEmployeeOverrideField) ?? [];
}

export function appEmployeeOverrideItems(member: RoomMember | undefined): AppEmployeeOverrideItem[] {
  return [...new Set(appEmployeeOverrideFields(member).map((field) => APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS[field]))];
}

/**
 * Global Employee surfaces show one logical definition. App-scoped bindings
 * keep their own member ids, workspace roots and sessions, but stay inside the
 * App that owns them.
 */
export function visibleEmployeeDefinitions(members: RoomMember[]): RoomMember[] {
  const visibleDefinitionIds = new Set(
    members
      .filter((member) => member.employeeDefinitionId && !member.appId)
      .map((member) => member.employeeDefinitionId as string),
  );
  return members.filter(
    (member) => !member.employeeDefinitionId || !member.appId || !visibleDefinitionIds.has(member.employeeDefinitionId),
  );
}

export function emptyMemberActivitySnapshot(): MemberActivitySnapshot {
  return {
    currentWork: "",
    totalRuns: 0,
    failedRuns: 0,
    successRate: 0,
    averageDuration: "",
    recentRuns: [],
  };
}

export function buildMemberActivitySnapshot(
  member: RoomMember,
  rooms: Room[],
  t: TranslationFn = translate,
): MemberActivitySnapshot {
  const relatedMessages = rooms
    .filter((room) => room.directMemberId === member.id || room.memberIds.includes(member.id))
    .flatMap((room) => room.messages.map((message) => ({ ...message, roomTitle: room.title })))
    .filter(
      (message) =>
        message.senderId === member.id || message.targetIds.includes(member.id) || message.senderType === "user",
    )
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const agentRuns = relatedMessages.filter((message) => message.senderId === member.id);
  const completedRuns = agentRuns.filter(
    (message) => message.status === "done" || message.status === "failed" || message.status === "interrupted",
  );
  const failedRuns = completedRuns.filter(
    (message) => message.status === "failed" || message.status === "interrupted",
  ).length;
  const successfulRuns = completedRuns.filter((message) => message.status === "done").length;
  const totalRuns = completedRuns.length;
  const running = agentRuns.find((message) => message.status === "running");
  const durations = completedRuns
    .map((message) => durationSeconds(message.duration))
    .filter((value): value is number => typeof value === "number");
  const average = durations.length
    ? `${(durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1)}s`
    : "";
  return {
    currentWork: running
      ? shortText(running.text || running.roomTitle || t("contacts.activityWorkingFallback"), 80)
      : "",
    totalRuns,
    failedRuns,
    successRate: totalRuns ? Math.round((successfulRuns / totalRuns) * 100) : 0,
    averageDuration: average,
    recentRuns: agentRuns.slice(0, 5).map((message) => ({
      id: message.id,
      title: shortText(message.text || message.roomTitle || t("contacts.activityRunFallback"), 88),
      createdAt: relativeTimeLabel(message.createdAt, t),
      duration: message.duration || "",
      status: message.status,
      statusLabel: roomMessageStatusLabel(message.status, t),
    })),
  };
}

function skillOptionFromExtensionItem(item: ExtensionItemRecord, t: TranslationFn): ContactSkillOption {
  const deployments = item.deployments ?? [];
  const primaryDeployment =
    deployments.find((deployment) => deployment.managedByOpenGrove && !deployment.kernelId) ??
    deployments.find((deployment) => deployment.managedByOpenGrove) ??
    deployments[0];
  const managedSourceRoot =
    typeof primaryDeployment?.metadata?.managedSourceRoot === "string"
      ? primaryDeployment.metadata.managedSourceRoot
      : undefined;
  const publishedKernelIds = normalizeSkillIds(
    deployments
      .filter((deployment) => deployment.kind === "skill" && deployment.enabled && Boolean(deployment.kernelId))
      .map((deployment) => deployment.kernelId ?? ""),
  );
  return {
    id: item.name,
    aliases: normalizeSkillAliases(item.name, item.id),
    itemId: item.id,
    deploymentId: primaryDeployment?.id,
    name: item.name,
    title: item.title || item.name,
    description: item.description || "",
    sourceLabel: sourceLabelForSkill(item.source?.origin ?? primaryDeployment?.scope ?? "skill", t),
    sourcePath: managedSourceRoot ?? primaryDeployment?.sourcePath ?? primaryDeployment?.targetPath,
    publishedKernelIds,
    toolIds: [],
    allowedTools: [],
  };
}

function skillOptionFromSkillRecord(skill: SkillRecord, t: TranslationFn): ContactSkillOption | undefined {
  const name = String(skill.name || skill.id || "")
    .replace(/^skill\./, "")
    .trim();
  if (!name) return undefined;
  return {
    id: name,
    aliases: normalizeSkillIds([
      ...normalizeSkillAliases(name, String(skill.id || "")),
      ...(Array.isArray(skill.aliases)
        ? skill.aliases.filter((alias): alias is string => typeof alias === "string")
        : []),
    ]),
    name,
    title: String(skill.title || skill.displayName || name),
    description: String(skill.description || skill.whenToUse || ""),
    sourceLabel: sourceLabelForSkill(skill.source, t),
    sourcePath:
      typeof skill.skillRoot === "string" ? skill.skillRoot : typeof skill.entry === "string" ? skill.entry : undefined,
    publishedKernelIds: [],
    toolIds: normalizeSkillIds(
      Array.isArray(skill.toolIds) ? skill.toolIds.filter((item): item is string => typeof item === "string") : [],
    ),
    allowedTools: normalizeSkillIds(
      Array.isArray(skill.allowedTools)
        ? skill.allowedTools.filter((item): item is string => typeof item === "string")
        : [],
    ),
  };
}

function mergeSkillOption(options: Map<string, ContactSkillOption>, next: ContactSkillOption) {
  const existing = options.get(next.id);
  if (!existing) {
    options.set(next.id, next);
    return;
  }
  options.set(next.id, {
    ...existing,
    aliases: normalizeSkillIds([...existing.aliases, ...next.aliases]),
    itemId: existing.itemId ?? next.itemId,
    deploymentId: existing.deploymentId ?? next.deploymentId,
    title: existing.title || next.title,
    description: existing.description || next.description,
    sourcePath: existing.sourcePath ?? next.sourcePath,
    publishedKernelIds: normalizeSkillIds([...existing.publishedKernelIds, ...next.publishedKernelIds]),
    toolIds: normalizeSkillIds([...existing.toolIds, ...next.toolIds]),
    allowedTools: normalizeSkillIds([...existing.allowedTools, ...next.allowedTools]),
  });
}

function findContactSkillOption(skills: ContactSkillOption[], skillId: string): ContactSkillOption | undefined {
  const normalized = skillId.trim();
  if (!normalized) return undefined;
  return skills.find((skill) => skill.id === normalized || skill.aliases.includes(normalized));
}

function normalizeSkillAliases(name: string, id: string | undefined): string[] {
  const normalizedName = name.trim();
  const normalizedId = id?.trim() ?? "";
  return normalizeSkillIds([
    normalizedName,
    normalizedId,
    normalizedName ? `skill.${normalizedName}` : "",
    normalizedId.startsWith("skill.") ? normalizedId.replace(/^skill\./, "") : "",
  ]);
}

function sourceLabelForSkill(source: unknown, t: TranslationFn): string {
  const value = String(source || "").toLowerCase();
  if (value === "user") return t("source.scope.user");
  if (value === "project") return t("source.scope.project");
  if (value === "bundled" || value === "system") return t("source.scope.system");
  if (value === "managed") return "OpenGrove";
  if (value === "kernel") return "Kernel";
  if (value === "pack") return "Pack";
  return "Skill";
}

function durationSeconds(input: string | undefined): number | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  const seconds = /^([\d.]+)s$/.exec(value);
  if (seconds) return Number(seconds[1]);
  const milliseconds = /^([\d.]+)ms$/.exec(value);
  if (milliseconds) return Number(milliseconds[1]) / 1000;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function shortText(input: string, maxLength: number): string {
  const value = input.replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function relativeTimeLabel(input: string, t: TranslationFn): string {
  const timestamp = new Date(input).getTime();
  if (!Number.isFinite(timestamp)) return input;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return t("ops.justNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t("ops.minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ops.hoursAgo", { hours });
  return t("contacts.timeDaysAgo", { count: Math.floor(hours / 24) });
}

function roomMessageStatusLabel(status: RoomMessage["status"], t: TranslationFn): string {
  if (status === "done") return t("mountedApp.flowDone");
  if (status === "failed") return t("mountedApp.flowFailed");
  if (status === "interrupted") return t("contacts.runStatusInterrupted");
  if (status === "running") return t("mountedApp.flowRunning");
  return t("contacts.runStatusSent");
}
