import {
  DEFAULT_LOCALE,
  canonicalizeLocaleTag,
  intlLocale,
  resolveSupportedLocale,
} from "@opengrove/agent-protocol/locale-registry";
import type { ResolvedLanguage } from "./i18n-types";

export const DEFAULT_LANGUAGE: ResolvedLanguage = DEFAULT_LOCALE;
export const PSEUDO_LOCALE = "en-XA";

type BrowserLanguageSource = {
  language?: string;
  languages?: readonly string[];
};

export function canonicalizeLanguageTag(value: unknown): string | undefined {
  return canonicalizeLocaleTag(value);
}

export function resolveSupportedLanguage(candidates: readonly string[] | string | undefined): ResolvedLanguage {
  return resolveSupportedLocale(candidates);
}

export function browserLanguageCandidates(source: BrowserLanguageSource | undefined): string[] {
  if (!source) return [];
  const candidates = Array.isArray(source.languages) ? [...source.languages] : [];
  if (source.language && !candidates.includes(source.language)) candidates.push(source.language);
  return candidates;
}

export function detectBrowserLanguage(
  source: BrowserLanguageSource | undefined = typeof navigator === "undefined" ? undefined : navigator,
): ResolvedLanguage {
  return resolveSupportedLanguage(browserLanguageCandidates(source));
}

export function localeForLanguage(language: ResolvedLanguage): string {
  return intlLocale(language);
}

export function isPseudoLocaleEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  if (!env?.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("locale") === PSEUDO_LOCALE;
}

export function pseudoLocalizeTemplate(template: string): string {
  const transformed = template
    .split(/(\{[A-Za-z_]\w*\})/g)
    .map((part) => (/^\{[A-Za-z_]\w*\}$/.test(part) ? part : accentAscii(part)))
    .join("");
  const padding = " ~".repeat(Math.max(2, Math.ceil(template.length / 12)));
  return `[!! ${transformed}${padding} !!]`;
}

function accentAscii(value: string): string {
  const accents: Record<string, string> = {
    A: "Å",
    B: "Ɓ",
    C: "Ç",
    D: "Ð",
    E: "Ë",
    F: "Ƒ",
    G: "Ĝ",
    H: "Ħ",
    I: "Ï",
    J: "Ĵ",
    K: "Ķ",
    L: "Ŀ",
    M: "M",
    N: "Ñ",
    O: "Ø",
    P: "Þ",
    Q: "Q",
    R: "Ŕ",
    S: "Š",
    T: "Ŧ",
    U: "Ü",
    V: "V",
    W: "Ŵ",
    X: "X",
    Y: "Ÿ",
    Z: "Ž",
    a: "å",
    b: "ƀ",
    c: "ç",
    d: "ð",
    e: "ë",
    f: "ƒ",
    g: "ĝ",
    h: "ħ",
    i: "ï",
    j: "ĵ",
    k: "ķ",
    l: "ŀ",
    m: "m",
    n: "ñ",
    o: "ø",
    p: "þ",
    q: "q",
    r: "ŕ",
    s: "š",
    t: "ŧ",
    u: "ü",
    v: "v",
    w: "ŵ",
    x: "x",
    y: "ÿ",
    z: "ž",
  };
  return value.replace(/[A-Za-z]/g, (character) => accents[character] ?? character);
}
