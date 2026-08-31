import { Check, Clock, Plus } from "lucide-react";
import type { StoredMessage } from "../../bridge";
import { compareLocalizedText, summarize } from "../../format";
import { APP_DEFAULT_PROJECT_ID, APP_DEFAULT_PROJECT_TITLE } from "../../identity";
import { readLanguagePreference, resolveLanguage, translate, useI18n, type TranslationFn } from "../../i18n";
import { cachedDateTimeFormat } from "../../intl-formatters";
import { localeForLanguage } from "../../locale";
import type { UiProject, UiThread } from "../../store";
import { MotionMenuItem } from "../ui/motion/menu";

export type ConversationSortKey = "createdAt" | "updatedAt";
export type SidebarProject = UiProject & { active: boolean; threads: UiThread[] };

const SIDEBAR_DAY_MS = 24 * 60 * 60 * 1000;

export function ConversationSortMenu(props: {
  sortKey: ConversationSortKey;
  onSortKeyChange(key: ConversationSortKey): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <MotionMenuItem onClick={() => props.onSortKeyChange("createdAt")}>
        <Plus size={14} />
        <span>{t("conversation.createTime")}</span>
        {props.sortKey === "createdAt" ? <Check size={14} /> : null}
      </MotionMenuItem>
      <MotionMenuItem onClick={() => props.onSortKeyChange("updatedAt")}>
        <Clock size={14} />
        <span>{t("conversation.updateTime")}</span>
        {props.sortKey === "updatedAt" ? <Check size={14} /> : null}
      </MotionMenuItem>
    </>
  );
}

export function buildSidebarProjectTree(
  projects: UiProject[],
  threads: UiThread[],
  activeProjectId: string,
  activeThreadId: string,
  activeMessages: StoredMessage[],
): SidebarProject[] {
  const normalizedProjects: UiProject[] = projects.length
    ? projects
    : [
        {
          id: APP_DEFAULT_PROJECT_ID,
          title: APP_DEFAULT_PROJECT_TITLE,
          updatedAt: new Date().toISOString(),
        },
      ];
  const normalizedThreads = threads.length
    ? threads
    : hasSidebarThreadContent(activeMessages)
      ? [
          {
            id: activeThreadId,
            projectId: activeProjectId || normalizedProjects[0]!.id,
            title: deriveSidebarThreadTitle(activeMessages),
            updatedAt: new Date().toISOString(),
            messages: activeMessages,
          },
        ]
      : [];

  return normalizedProjects.map((project) => {
    const projectThreads = normalizedThreads
      .filter((thread) => thread.projectId === project.id)
      .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
    return {
      ...project,
      active: project.id === activeProjectId || projectThreads.some((thread) => thread.id === activeThreadId),
      threads: projectThreads.length ? projectThreads : [createSidebarEmptyThread(project.id)],
    };
  });
}

export function sortSidebarThreads(threads: UiThread[], sortKey: ConversationSortKey): UiThread[] {
  return [...threads].sort((left, right) => {
    const delta = getSidebarThreadSortTime(left, sortKey) - getSidebarThreadSortTime(right, sortKey);
    if (delta === 0) {
      return compareLocalizedText(String(left.title || ""), String(right.title || ""));
    }
    return -delta;
  });
}

export function getSidebarThreadSortTime(thread: UiThread, sortKey: ConversationSortKey): number {
  if (sortKey === "createdAt") {
    return getSidebarThreadCreatedAt(thread);
  }
  const updatedAt = Date.parse(thread.updatedAt || "");
  return Number.isFinite(updatedAt) ? updatedAt : getSidebarThreadCreatedAt(thread);
}

export function getSidebarThreadCreatedAt(thread: UiThread): number {
  const match = /^standalone:([a-z0-9]+):/.exec(thread.id);
  if (match?.[1]) {
    const timestamp = Number.parseInt(match[1], 36);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  const updatedAt = Date.parse(thread.updatedAt || "");
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

export function createSidebarEmptyThread(projectId: string): UiThread {
  return {
    id: `empty:${projectId}`,
    projectId,
    title: translate("conversation.newThreadFallback"),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

export function deriveSidebarThreadTitle(messages: StoredMessage[]): string {
  const userMessage = messages.find((message) => message.role === "user" && message.text.trim());
  if (!userMessage) {
    return translate("conversation.newThreadFallback");
  }
  return summarize(userMessage.text, 28);
}

function hasSidebarThreadContent(messages: StoredMessage[]): boolean {
  return messages.some((message) => message.role === "user" && Boolean(message.text.trim()));
}

export function projectSidebarContextLabel(project: UiProject, t: TranslationFn = translate): string {
  if (project.title === APP_DEFAULT_PROJECT_TITLE) {
    return t("conversation.codeProject");
  }
  return t("conversation.localProject");
}

export function formatSidebarThreadMeta(thread: UiThread, t: TranslationFn = translate): string {
  const updatedAt = Date.parse(thread.updatedAt || "");
  if (!Number.isFinite(updatedAt)) {
    return t("conversation.local");
  }
  const ageMs = Date.now() - updatedAt;
  if (ageMs < 0 || ageMs < SIDEBAR_DAY_MS) {
    return t("conversation.today");
  }
  const days = Math.max(1, Math.round(ageMs / SIDEBAR_DAY_MS));
  if (days <= 30) {
    return t("conversation.days", { count: days });
  }
  return formatSidebarThreadDate(updatedAt);
}

function formatSidebarThreadDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { month: "numeric", day: "numeric" }
      : { year: "2-digit", month: "numeric", day: "numeric" };
  return cachedDateTimeFormat(localeForLanguage(resolveLanguage(readLanguagePreference())), options).format(date);
}
