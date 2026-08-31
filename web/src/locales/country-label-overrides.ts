import type { SupportedLocale } from "@opengrove/agent-protocol/locale-registry";

const COUNTRY_LABEL_OVERRIDES = {
  en: {
    CN: "Mainland China",
    HK: "Hong Kong",
    MO: "Macao",
    TW: "Taiwan",
  },
  "zh-CN": {
    CN: "中国大陆",
    HK: "中国香港",
    MO: "中国澳门",
    TW: "中国台湾",
  },
} as const satisfies Record<SupportedLocale, Partial<Record<string, string>>>;

export function countryLabelOverrides(locale: SupportedLocale): Partial<Record<string, string>> {
  return COUNTRY_LABEL_OVERRIDES[locale];
}
