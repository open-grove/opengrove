import { ArrowRight, Check } from "lucide-react";
import type { MountedAppDashboardGrade } from "../../bridge";
import { useI18n, type TranslationFn } from "../../i18n";

export function DashboardTextList(props: { title: string; items?: string[]; tone: "suggestion" | "strength" }) {
  if (!props.items?.length) return null;
  return (
    <div className="mounted-app-dashboard-text-list" data-tone={props.tone}>
      <span className="mounted-app-dashboard-card-label">{props.title}</span>
      <ul>
        {props.items.map((item) => (
          <li key={item}>
            {props.tone === "suggestion" ? (
              <ArrowRight size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GradeBadge(props: { grade: MountedAppDashboardGrade; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className="mounted-app-dashboard-grade"
      data-grade={props.grade}
      data-compact={props.compact ? "true" : "false"}
    >
      <i aria-hidden="true" />
      <span>{props.compact ? dashboardGradeShortLabel(props.grade, t) : dashboardGradeLabel(props.grade, t)}</span>
    </span>
  );
}

export function cleanDashboardAlert(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️\s]+/u, "").trim() || text.trim();
}

function dashboardGradeLabel(grade: MountedAppDashboardGrade, t: TranslationFn): string {
  switch (grade) {
    case "good":
      return t("mountedApp.dashboardGradeGood");
    case "warn":
      return t("mountedApp.dashboardGradeWarn");
    case "weak":
      return t("mountedApp.dashboardGradeWeak");
    case "unknown":
      return t("mountedApp.dashboardGradeUnknown");
  }
}

export function dashboardGradeShortLabel(grade: MountedAppDashboardGrade, t: TranslationFn): string {
  switch (grade) {
    case "good":
      return t("mountedApp.dashboardGradeGoodShort");
    case "warn":
      return t("mountedApp.dashboardGradeWarnShort");
    case "weak":
      return t("mountedApp.dashboardGradeWeakShort");
    case "unknown":
      return t("mountedApp.dashboardGradeUnknownShort");
  }
}
