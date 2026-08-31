import type { TranslationKey } from "./i18n-dictionaries";
import type { ResolvedLanguage } from "./i18n-types";

type EnglishPluralForms = {
  selector?: string;
  one: string;
  other: string;
};

const ENGLISH_PLURAL_FORMS: Partial<Record<TranslationKey, EnglishPluralForms>> = {
  "app.unreadCount": {
    one: "{label}, {count} unread item",
    other: "{label}, {count} unread items",
  },
  "conversation.deleteProjectConfirm": {
    one: "Delete project “{title}”? Its {count} chat will also be removed from the local sidebar.",
    other: "Delete project “{title}”? Its {count} chats will also be removed from the local sidebar.",
  },
  "mountedApp.flowRunCount": { one: "Run: {count}", other: "Runs: {count}" },
  "mountedApp.flowMoreRuns": { one: "{count} older run", other: "{count} older runs" },
  "mountedApp.dashboardActiveCount": { one: "{count} active story", other: "{count} active stories" },
  "settings.extensionDeploymentsCount": { one: "{count} deployment", other: "{count} deployments" },
  "settings.modelsCount": { one: "{count} model", other: "{count} models" },
  "system.maxAttachments": {
    one: "You can add up to {count} attachment at once.",
    other: "You can add up to {count} attachments at once.",
  },
  "system.partialAttachments": {
    selector: "selected",
    one: "Added the first {selected} attachment; the limit is {count}.",
    other: "Added the first {selected} attachments; the limit is {count}.",
  },
  "shell.updatesAvailableCount": { one: "{count} update available", other: "{count} updates available" },
  "shell.pendingReplyCount": { one: "{count} item awaiting reply", other: "{count} items awaiting reply" },
  "withdrawal.countTimes": { one: "{count} time", other: "{count} times" },
  "withdrawal.viewRecordsAria": { one: "View {count} withdrawal", other: "View {count} withdrawals" },
  "workspace.messageCount": { one: "{count} message", other: "{count} messages" },
  "workspace.pendingApprovalCount": { one: "{count} pending approval", other: "{count} pending approvals" },
  "workspace.pendingActionCount": {
    one: "{count} action awaiting approval",
    other: "{count} actions awaiting approval",
  },
  "mountedApp.defaultGroupMeta": {
    one: "{count} employee · workflow collaboration",
    other: "{count} employees · workflow collaboration",
  },
  "mountedApp.groupMemberCount": { one: "{count} employee", other: "{count} employees" },
  "contacts.employeeCount": { one: "{count} employee", other: "{count} employees" },
  "contacts.configSourceLocalOverrides": {
    one: "{count} local override. It remains for this version and is replaced by the new default when the App is updated.",
    other:
      "{count} local overrides. They remain for this version and are replaced by the new defaults when the App is updated.",
  },
  "contacts.restoreAppDefaultsConfirmBody": {
    one: "This will replace {count} local change: {changes}. The defaults provided by the App will be restored. The Provider binding is retained, and runtime changes take effect on the next run.",
    other:
      "This will replace {count} local changes: {changes}. The defaults provided by the App will be restored. The Provider binding is retained, and runtime changes take effect on the next run.",
  },
  "appStore.release.tokens": { one: "{count} token", other: "{count} tokens" },
  "appStore.doctorWarningCount": { one: "{count} warning", other: "{count} warnings" },
  "chat.processNotesRecorded": {
    one: "{count} process note recorded",
    other: "{count} process notes recorded",
  },
  "rooms.pendingApprovals": { one: "Pending approval {count}", other: "Pending approvals {count}" },
  "rooms.unreadCount": {
    one: "{title}, {count} unread item",
    other: "{title}, {count} unread items",
  },
  "activity.exploredFiles": { one: "Explored {count} file", other: "Explored {count} files" },
  "activity.searchCount": { one: "{count} search", other: "{count} searches" },
  "activity.usedSkills": { one: "Used {count} skill", other: "Used {count} skills" },
  "activity.browseCount": { one: "Browsed {count} time", other: "Browsed {count} times" },
  "activity.thoughtCount": { one: "Thought {count} time", other: "Thought {count} times" },
  "activity.ranCommands": { one: "Ran {count} command", other: "Ran {count} commands" },
  "activity.monitoredTasks": { one: "Monitored {count} background task", other: "Monitored {count} background tasks" },
  "activity.delegatedAgents": { one: "Delegated {count} agent", other: "Delegated {count} agents" },
  "activity.editedFiles": { one: "Edited {count} file", other: "Edited {count} files" },
  "activity.processedMemories": { one: "Processed {count} memory", other: "Processed {count} memories" },
  "activity.producedArtifacts": { one: "Produced {count} artifact", other: "Produced {count} artifacts" },
  "activity.updatedPlanCount": {
    one: "Updated the plan {count} time",
    other: "Updated the plan {count} times",
  },
  "activity.choiceFormCount": { one: "{count} question set", other: "{count} question sets" },
  "activity.questionCount": { one: "{count} question", other: "{count} questions" },
  "activity.approvalCount": { one: "{count} action", other: "{count} actions" },
  "activity.errorCount": { one: "{count} error", other: "{count} errors" },
  "activity.processedItems": { one: "Processed {count} item", other: "Processed {count} items" },
  "activity.files": { one: "{count} file", other: "{count} files" },
  "activity.stepCount": { one: "{count} step", other: "{count} steps" },
  "activity.workflowSteps": {
    one: "Includes {count} step: {steps}",
    other: "Includes {count} steps: {steps}",
  },
  "activity.moreLocations": { one: "{first} and {count} location", other: "{first} and {count} locations" },
};

const COUNT_KEYS_WITH_INVARIANT_ENGLISH_GRAMMAR = new Set<TranslationKey>([
  "conversation.days",
  "auth.resendCodeInMinutes",
  "auth.resendCodeInSeconds",
  "auth.sendCodeInMinutes",
  "auth.sendCodeInSeconds",
  "workspace.showMoreCount",
  "ops.runningCount",
  "contacts.timeDaysAgo",
  "appStore.release.employeeDefaultsTitle",
  "appStore.release.employeeDraftTitle",
  "appStore.doctorMissingCount",
]);

const ENGLISH_PLURAL_RULES = new Intl.PluralRules("en");

export function englishPluralTemplate(
  key: TranslationKey,
  replacements: Record<string, string | number>,
): string | undefined {
  const forms = ENGLISH_PLURAL_FORMS[key];
  if (!forms) return undefined;
  const selectedValue = replacements[forms.selector ?? "count"];
  const numericCount = typeof selectedValue === "number" ? selectedValue : Number(selectedValue);
  if (!Number.isFinite(numericCount)) return undefined;
  return ENGLISH_PLURAL_RULES.select(numericCount) === "one" ? forms.one : forms.other;
}

const PLURAL_TEMPLATE_RESOLVERS = {
  "zh-CN": () => undefined,
  en: englishPluralTemplate,
} satisfies Record<
  ResolvedLanguage,
  (key: TranslationKey, replacements: Record<string, string | number>) => string | undefined
>;

export function pluralTemplateForLanguage(
  language: ResolvedLanguage,
  key: TranslationKey,
  replacements: Record<string, string | number>,
): string | undefined {
  return PLURAL_TEMPLATE_RESOLVERS[language](key, replacements);
}

export function englishCountKeyHasExplicitPolicy(key: TranslationKey): boolean {
  return Boolean(ENGLISH_PLURAL_FORMS[key]) || COUNT_KEYS_WITH_INVARIANT_ENGLISH_GRAMMAR.has(key);
}

export function shouldGroupNumericReplacement(key: TranslationKey, name: string): boolean {
  const forms = ENGLISH_PLURAL_FORMS[key];
  if (forms) return name === "count" || name === (forms.selector ?? "count");
  return COUNT_KEYS_WITH_INVARIANT_ENGLISH_GRAMMAR.has(key) && name === "count";
}
