import { SUPPORTED_LOCALES } from "@opengrove/agent-protocol/locale-registry";
import type { ClientUpdateResponse } from "./bridge";
import type { ResolvedLanguage } from "./i18n";

type ClientRelease = NonNullable<ClientUpdateResponse["latest"]>;

export function resolveClientReleaseNotes(
  release: ClientRelease | null | undefined,
  language: ResolvedLanguage,
): string | undefined {
  if (!release) return undefined;
  const localized = release.releaseNotesByLocale;
  const preferred = localized?.[language];
  const fallback = SUPPORTED_LOCALES.map((locale) => localized?.[locale]).find((value) => nonempty(value));
  return nonempty(preferred) ?? nonempty(fallback) ?? nonempty(release.releaseNotes);
}

function nonempty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
