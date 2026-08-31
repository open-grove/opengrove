export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type UiLanguagePreference = "system" | SupportedLocale;

export interface LocaleDefinition {
  id: SupportedLocale;
  intlLocale: string;
  languageCodes: readonly string[];
  nativeLabel: string;
  responseLanguageName: string;
}

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LOCALE_REGISTRY = {
  "zh-CN": {
    id: "zh-CN",
    intlLocale: "zh-CN",
    languageCodes: ["zh"],
    nativeLabel: "中文",
    responseLanguageName: "Simplified Chinese",
  },
  en: {
    id: "en",
    intlLocale: "en",
    languageCodes: ["en"],
    nativeLabel: "English",
    responseLanguageName: "English",
  },
} as const satisfies Record<SupportedLocale, LocaleDefinition>;

const supportedLocaleSet = new Set<string>(SUPPORTED_LOCALES);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && supportedLocaleSet.has(value);
}

export function normalizeSupportedLocale(value: unknown, fallback?: SupportedLocale): SupportedLocale | undefined {
  return isSupportedLocale(value) ? value : fallback;
}

export function normalizeUiLanguagePreference(
  value: unknown,
  fallback?: UiLanguagePreference,
): UiLanguagePreference | undefined {
  return value === "system" || isSupportedLocale(value) ? value : fallback;
}

/**
 * Canonicalizes BCP 47 tags and the POSIX-style locale strings commonly
 * exposed by desktop environments (for example zh_CN.UTF-8 and sr_RS@latin).
 */
export function canonicalizeLocaleTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().split("@", 1)[0]?.split(".", 1)[0]?.replaceAll("_", "-");
  if (!normalized) return undefined;
  try {
    return Intl.getCanonicalLocales(normalized)[0];
  } catch {
    return undefined;
  }
}

export function localeLanguage(value: unknown): string | undefined {
  const canonical = canonicalizeLocaleTag(value);
  if (!canonical) return undefined;
  try {
    return new Intl.Locale(canonical).language.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Applies the product's RFC 4647-style language-family lookup policy.
 * Chinese tags currently share the zh-CN catalog until a Traditional
 * Chinese locale is registered explicitly.
 */
export function resolveSupportedLocale(
  candidates: readonly string[] | string | undefined,
  fallback: SupportedLocale = DEFAULT_LOCALE,
): SupportedLocale {
  const values = typeof candidates === "string" ? [candidates] : (candidates ?? []);
  for (const candidate of values) {
    const language = localeLanguage(candidate);
    if (!language) continue;
    const match = SUPPORTED_LOCALES.find((locale) =>
      (LOCALE_REGISTRY[locale].languageCodes as readonly string[]).includes(language),
    );
    if (match) return match;
  }
  return fallback;
}

export function localeDefinition(locale: SupportedLocale): LocaleDefinition {
  return LOCALE_REGISTRY[locale];
}

export function intlLocale(locale: SupportedLocale): string {
  return localeDefinition(locale).intlLocale;
}

export function localizedValue<T>(catalog: Readonly<Record<SupportedLocale, T>>, locale: SupportedLocale): T {
  return catalog[locale];
}
