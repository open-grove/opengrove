import { useCallback, useSyncExternalStore } from "react";
import { normalizeUiLanguagePreference } from "@opengrove/agent-protocol/locale-registry";
import { APP_STORAGE_KEYS } from "./identity";
import { dictionaries } from "./i18n-dictionaries";
import { pluralTemplateForLanguage, shouldGroupNumericReplacement } from "./i18n-plurals";
import type { LanguagePreference, ResolvedLanguage, TranslationFn, TranslationKey } from "./i18n-types";
import { cachedNumberFormat } from "./intl-formatters";
import {
  detectBrowserLanguage,
  isPseudoLocaleEnabled,
  localeForLanguage,
  PSEUDO_LOCALE,
  pseudoLocalizeTemplate,
} from "./locale";

export type { Dictionary, LanguagePreference, ResolvedLanguage, TranslationFn, TranslationKey } from "./i18n-types";

const listeners = new Set<() => void>();

export function detectSystemLanguage(): ResolvedLanguage {
  return detectBrowserLanguage(typeof window === "undefined" ? undefined : window.navigator);
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return normalizeUiLanguagePreference(value, "system") ?? "system";
}

export function readLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  return normalizeLanguagePreference(window.localStorage.getItem(APP_STORAGE_KEYS.language));
}

export function resolveLanguage(preference: LanguagePreference): ResolvedLanguage {
  return preference === "system" ? detectSystemLanguage() : preference;
}

export function setLanguagePreference(preference: LanguagePreference): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(APP_STORAGE_KEYS.language, preference);
  applyDocumentLanguage();
  for (const listener of listeners) {
    listener();
  }
}

export function applyDocumentLanguage(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = isPseudoLocaleEnabled() ? PSEUDO_LOCALE : resolveLanguage(readLanguagePreference());
}

export function translate(key: TranslationKey, replacements: Record<string, string | number> = {}): string {
  const language = resolveLanguage(readLanguagePreference());
  return translateInLanguage(language, key, replacements);
}

export function translateInLanguage(
  language: ResolvedLanguage,
  key: TranslationKey,
  replacements: Record<string, string | number> = {},
  options: { pseudo?: boolean } = {},
): string {
  const pseudo = options.pseudo ?? isPseudoLocaleEnabled();
  const sourceLanguage = pseudo ? "en" : language;
  const pluralTemplate = pluralTemplateForLanguage(sourceLanguage, key, replacements);
  const template = pluralTemplate ?? dictionaries[sourceLanguage][key] ?? key;
  const displayTemplate = pseudo ? pseudoLocalizeTemplate(template) : template;
  return displayTemplate.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, name)) return match;
    const replacement = replacements[name];
    if (typeof replacement === "number" && Number.isFinite(replacement) && shouldGroupNumericReplacement(key, name)) {
      return cachedNumberFormat(localeForLanguage(sourceLanguage)).format(replacement);
    }
    return String(replacement);
  });
}

/**
 * Keep diagnostic details intact. User-facing system errors should be
 * localized from stable error codes at their owning boundary; unknown raw
 * diagnostics remain useful for troubleshooting and must not be classified by
 * inspecting which writing system they contain.
 */
export function rawDiagnosticText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function useI18n() {
  const preference = useSyncExternalStore(
    subscribeLanguage,
    readLanguagePreference,
    (): LanguagePreference => "system",
  );
  const language = useSyncExternalStore(
    subscribeLanguage,
    () => resolveLanguage(readLanguagePreference()),
    (): ResolvedLanguage => "en",
  );
  const t = useCallback<TranslationFn>(
    (key, replacements) => translateInLanguage(language, key, replacements),
    [language],
  );
  return {
    language,
    preference,
    setLanguagePreference,
    t,
  };
}

function subscribeLanguage(listener: () => void): () => void {
  const shouldStartListening = listeners.size === 0;
  listeners.add(listener);
  if (shouldStartListening && typeof window !== "undefined") {
    window.addEventListener("languagechange", handleSystemLanguageChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("languagechange", handleSystemLanguageChange);
    }
  };
}

function handleSystemLanguageChange(): void {
  applyDocumentLanguage();
  for (const listener of listeners) {
    listener();
  }
}
