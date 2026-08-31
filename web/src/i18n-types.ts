import type { SupportedLocale, UiLanguagePreference } from "@opengrove/agent-protocol/locale-registry";

export type LanguagePreference = UiLanguagePreference;
export type ResolvedLanguage = SupportedLocale;

export type { Dictionary, TranslationKey } from "./i18n-dictionaries";
import type { TranslationKey } from "./i18n-dictionaries";

export type TranslationFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;
