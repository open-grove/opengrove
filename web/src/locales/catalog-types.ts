import type { EN } from "./en";

export type TranslationKey = keyof typeof EN;
export type Dictionary = Record<TranslationKey, string>;
