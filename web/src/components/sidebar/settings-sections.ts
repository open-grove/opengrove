import type { IconStylePreference } from "../../appearance";
import { readLanguagePreference, resolveLanguage, type LanguagePreference, type TranslationFn } from "../../i18n";
import { cachedDateTimeFormat } from "../../intl-formatters";
import { localeForLanguage } from "../../locale";
import type { ThemePreference } from "../../theme";
import type { ProductIconName } from "../ui/product-icon";

export type SettingsSectionId =
  | "mode"
  | "kernels"
  | "ops"
  | "providers"
  | "apps"
  | "voice"
  | "network"
  | "desktop"
  | "updates"
  | "appearance";

type SettingsSectionLabelKey =
  | "settings.mode"
  | "settings.kernels"
  | "settings.opsCenter"
  | "settings.providers"
  | "settings.mountedApps"
  | "settings.voice"
  | "settings.network"
  | "settings.desktop"
  | "settings.updates"
  | "settings.appearance";

export const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  labelKey: SettingsSectionLabelKey;
  icon: ProductIconName;
}> = [
  { id: "mode", labelKey: "settings.mode", icon: "mode" },
  { id: "kernels", labelKey: "settings.kernels", icon: "kernel" },
  { id: "appearance", labelKey: "settings.appearance", icon: "appearance" },
  { id: "desktop", labelKey: "settings.desktop", icon: "desktop" },
  { id: "updates", labelKey: "settings.updates", icon: "refresh" },
  { id: "ops", labelKey: "settings.opsCenter", icon: "ops" },
  { id: "providers", labelKey: "settings.providers", icon: "provider" },
  { id: "apps", labelKey: "settings.mountedApps", icon: "store" },
  { id: "voice", labelKey: "settings.voice", icon: "voice" },
  { id: "network", labelKey: "settings.network", icon: "network" },
];

export function normalizeSettingsSection(value: SettingsSectionId | undefined): SettingsSectionId {
  return value && SETTINGS_SECTIONS.some((section) => section.id === value) ? value : "mode";
}

export const LANGUAGE_OPTIONS: Array<{
  id: LanguagePreference;
  labelKey: "settings.languageSystem" | "settings.languageChinese" | "settings.languageEnglish";
}> = [
  { id: "system", labelKey: "settings.languageSystem" },
  { id: "zh-CN", labelKey: "settings.languageChinese" },
  { id: "en", labelKey: "settings.languageEnglish" },
];

export const THEME_OPTIONS: Array<{
  id: ThemePreference;
  labelKey: "settings.themeSystem" | "settings.themeLight" | "settings.themeDark";
}> = [
  { id: "system", labelKey: "settings.themeSystem" },
  { id: "light", labelKey: "settings.themeLight" },
  { id: "dark", labelKey: "settings.themeDark" },
];

export const ICON_STYLE_OPTIONS: Array<{
  id: IconStylePreference;
  labelKey: "settings.iconStyleProfessional" | "settings.iconStylePixel";
}> = [
  { id: "professional", labelKey: "settings.iconStyleProfessional" },
  { id: "pixel", labelKey: "settings.iconStylePixel" },
];

export function sectionTitle(value: SettingsSectionId, t: TranslationFn): string {
  const section = SETTINGS_SECTIONS.find((item) => item.id === value);
  return section ? t(section.labelKey) : t("app.settings");
}

export function sectionDescription(value: SettingsSectionId, t: TranslationFn): string {
  if (value === "mode") return t("settings.modeDescription");
  if (value === "kernels") return t("settings.kernelsDescription");
  if (value === "ops") return t("settings.opsCenterDescription");
  if (value === "providers") return t("settings.providersDescription");
  if (value === "apps") return t("settings.mountedAppsDescription");
  if (value === "voice") return t("settings.voiceDescription");
  if (value === "network") return t("settings.networkDescription");
  if (value === "desktop") return t("settings.desktopDescription");
  if (value === "updates") return t("settings.updatesDescription");
  if (value === "appearance") return t("settings.appearanceDescription");
  return t("app.settings");
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return cachedDateTimeFormat(localeForLanguage(resolveLanguage(readLanguagePreference())), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
