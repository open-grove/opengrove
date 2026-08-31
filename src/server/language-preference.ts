import type { UserLanguagePreference } from "../core.js";
import {
  normalizeSupportedLocale,
  normalizeUiLanguagePreference,
  resolveSupportedLocale,
  type UiLanguagePreference,
} from "../localization/locale-registry.js";

export type HostLanguagePreference = UiLanguagePreference;
export type HostSystemLanguage = UserLanguagePreference;

export function normalizeHostLanguagePreference(
  value: unknown,
  fallback?: HostLanguagePreference,
): HostLanguagePreference | undefined {
  return normalizeUiLanguagePreference(value, fallback);
}

export function normalizeHostSystemLanguage(
  value: unknown,
  fallback?: HostSystemLanguage,
): HostSystemLanguage | undefined {
  return normalizeSupportedLocale(value, fallback);
}

export function resolveHostLanguageSettings(
  settings: {
    languagePreference?: HostLanguagePreference;
    systemLanguage?: HostSystemLanguage;
  },
  fallbackSystemLanguageCandidates?: readonly string[],
): UserLanguagePreference {
  return resolveHostLanguagePreference(
    settings.languagePreference,
    settings.systemLanguage ? [settings.systemLanguage] : fallbackSystemLanguageCandidates,
  );
}

export function resolveHostLanguagePreference(
  preference: HostLanguagePreference | undefined,
  systemLanguageCandidates: readonly string[] = defaultSystemLanguageCandidates(),
): UserLanguagePreference {
  const explicit = normalizeSupportedLocale(preference);
  return explicit ?? resolveSupportedLocale(systemLanguageCandidates);
}

export function defaultSystemLanguageCandidates(): string[] {
  return [
    Intl.DateTimeFormat().resolvedOptions().locale,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
