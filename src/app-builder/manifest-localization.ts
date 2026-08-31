import type { UserLanguagePreference } from "../core.js";
import { canonicalizeLocaleTag, localeLanguage } from "../localization/locale-registry.js";

export interface AppManifestPresentation {
  locale: UserLanguagePreference;
  localeMatched: boolean;
  title: string;
  description: string;
  welcomeMessage?: string;
  tabs: Record<string, { label?: string }>;
  employees: Record<
    string,
    {
      name?: string;
      role?: string;
      publicDescription?: string;
      publicSkills?: string[];
      inputSpec?: string;
      outputSpec?: string;
    }
  >;
  cli: Record<string, { title?: string; description?: string }>;
}

export function resolveAppManifestPresentation(
  manifest: Record<string, unknown>,
  locale: UserLanguagePreference,
): AppManifestPresentation {
  const localizedEntry = localizedManifestEntry(manifest, locale);
  const localized = localizedEntry ?? {};
  const localizedUi = record(localized.ui);
  const localizedCapabilities = record(localized.capabilities);
  const title =
    stringValue(localized.title) ||
    stringValue(manifest.title) ||
    stringValue(manifest.displayName) ||
    stringValue(manifest.name) ||
    stringValue(manifest.id);
  const description = stringValue(localized.description) || stringValue(manifest.description);
  const welcomeMessage = firstString(record(localized.welcome).message, record(manifest.welcome).message);
  return {
    locale,
    localeMatched: Boolean(localizedEntry),
    title,
    description,
    ...(welcomeMessage ? { welcomeMessage } : {}),
    tabs: localizedTabPresentation(manifest, localizedUi),
    employees: localizedEmployeeDisplayMap(record(localized.employees)),
    cli: localizedCliPresentation(manifest, localizedCapabilities),
  };
}

function localizedEmployeeDisplayMap(value: Record<string, unknown>): AppManifestPresentation["employees"] {
  const output: AppManifestPresentation["employees"] = {};
  for (const [id, rawEntry] of Object.entries(value)) {
    const entry = record(rawEntry);
    const localized = {
      name: stringValue(entry.name),
      role: stringValue(entry.role),
      publicDescription: stringValue(entry.publicDescription),
      publicSkills: stringArray(entry.publicSkills),
      inputSpec: stringValue(entry.inputSpec),
      outputSpec: stringValue(entry.outputSpec),
    };
    const compact = Object.fromEntries(
      Object.entries(localized).filter(([, field]) => (Array.isArray(field) ? field.length > 0 : Boolean(field))),
    );
    if (Object.keys(compact).length) output[id] = compact;
  }
  return output;
}

function localizedManifestEntry(
  manifest: Record<string, unknown>,
  locale: UserLanguagePreference,
): Record<string, unknown> | undefined {
  const locales = record(manifest.locales);
  const exactLocale = canonicalizeLocaleTag(locale);
  for (const [key, value] of Object.entries(locales)) {
    if (canonicalizeLocaleTag(key) === exactLocale) return record(value);
  }
  const language = localeLanguage(locale);
  for (const [key, value] of Object.entries(locales)) {
    if (localeLanguage(key) === language) return record(value);
  }
  return undefined;
}

function localizedTabPresentation(
  manifest: Record<string, unknown>,
  localizedUi: Record<string, unknown>,
): AppManifestPresentation["tabs"] {
  const canonicalTabs = recordArray(record(manifest.ui).tabs);
  const localizedTabs = record(localizedUi.tabs);
  const ids = new Set([
    ...canonicalTabs.map((tab) => stringValue(tab.id)).filter(Boolean),
    ...Object.keys(localizedTabs),
  ]);
  const output: AppManifestPresentation["tabs"] = {};
  for (const id of ids) {
    const canonical = canonicalTabs.find((tab) => stringValue(tab.id) === id) ?? {};
    const localized = record(localizedTabs[id]);
    const value =
      stringValue(localized.label) ||
      stringValue(canonical.label) ||
      stringValue(canonical.title) ||
      stringValue(canonical.name);
    if (value) output[id] = { label: value };
  }
  return output;
}

function localizedCliPresentation(
  manifest: Record<string, unknown>,
  localizedCapabilities: Record<string, unknown>,
): AppManifestPresentation["cli"] {
  const canonicalCapabilities = record(manifest.capabilities);
  const canonicalCli = [...recordArray(canonicalCapabilities.cli), ...recordArray(manifest.cli)];
  const localizedCli = record(localizedCapabilities.cli);
  const ids = new Set([
    ...canonicalCli.map((entry) => stringValue(entry.id) || stringValue(entry.name)).filter(Boolean),
    ...Object.keys(localizedCli),
  ]);
  const output: AppManifestPresentation["cli"] = {};
  for (const id of ids) {
    const canonical = canonicalCli.find((entry) => (stringValue(entry.id) || stringValue(entry.name)) === id) ?? {};
    const localized = record(localizedCli[id]);
    const title = stringValue(localized.title) || stringValue(canonical.title) || stringValue(canonical.displayName);
    const description = stringValue(localized.description) || stringValue(canonical.description);
    if (title || description) {
      output[id] = {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      };
    }
  }
  return output;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}
