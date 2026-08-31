import type { LanguagePreference, ResolvedLanguage } from "./i18n-types";

export interface LanguageSettingsBackfill {
  attemptKey: string;
  patch: {
    languagePreference?: LanguagePreference;
    systemLanguage?: ResolvedLanguage;
  };
}

export function nextLanguageSettingsBackfill(input: {
  hostPreference?: LanguagePreference;
  hostSystemLanguage?: ResolvedLanguage;
  localPreference: LanguagePreference;
  detectedSystemLanguage: ResolvedLanguage;
  settingsAvailable: boolean;
  mutationPending: boolean;
  lastAttemptKey: string;
}): LanguageSettingsBackfill | undefined {
  if (!input.settingsAvailable || input.mutationPending) return undefined;

  const patch: LanguageSettingsBackfill["patch"] = {};
  if (!input.hostPreference) patch.languagePreference = input.localPreference;
  if (input.hostSystemLanguage !== input.detectedSystemLanguage) {
    patch.systemLanguage = input.detectedSystemLanguage;
  }
  if (!patch.languagePreference && !patch.systemLanguage) return undefined;

  const attemptKey = `${patch.languagePreference ?? ""}:${patch.systemLanguage ?? ""}`;
  return attemptKey === input.lastAttemptKey ? undefined : { attemptKey, patch };
}
