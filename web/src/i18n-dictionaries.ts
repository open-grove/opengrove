import type { SupportedLocale } from "@opengrove/agent-protocol/locale-registry";
import { EN } from "./locales/en";
import { ZH_CN } from "./locales/zh-CN";
import type { Dictionary } from "./locales/catalog-types";

export { EN, ZH_CN };
export type { Dictionary, TranslationKey } from "./locales/catalog-types";

export const dictionaries = {
  en: EN,
  "zh-CN": ZH_CN,
} as const satisfies Record<SupportedLocale, Dictionary>;
