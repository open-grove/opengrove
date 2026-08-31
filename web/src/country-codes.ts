import type { SupportedLocale } from "@opengrove/agent-protocol/locale-registry";
import { countryLabelOverrides } from "./locales/country-label-overrides";

export interface CountryOption {
  code: string;
  label: string;
}

// Complete ISO 3166-1 alpha-2 assigned country/region list. Labels are resolved
// at runtime so the same canonical codes are presented in the active language.
export const ISO_COUNTRY_CODES: readonly string[] = Object.freeze(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);

const ISO_COUNTRY_CODE_SET = new Set(ISO_COUNTRY_CODES);

function displayNamesForLocale(locale: SupportedLocale): Intl.DisplayNames | undefined {
  try {
    return typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames([locale], { type: "region" })
      : undefined;
  } catch {
    return undefined;
  }
}

function collatorForLocale(locale: SupportedLocale): Intl.Collator | undefined {
  try {
    return typeof Intl !== "undefined" && typeof Intl.Collator === "function"
      ? new Intl.Collator(locale, { sensitivity: "base" })
      : undefined;
  } catch {
    return undefined;
  }
}

function resolvedCountryLabel(
  code: string,
  overrides: Partial<Record<string, string>>,
  displayNames: Intl.DisplayNames | undefined,
): string {
  const override = overrides[code];
  if (override) return override;
  try {
    return displayNames?.of(code) || code;
  } catch {
    return code;
  }
}

export function countryLabelForLocale(code: string, locale: SupportedLocale): string {
  const normalizedCode = code.trim().toUpperCase();
  if (!ISO_COUNTRY_CODE_SET.has(normalizedCode)) return "";
  return resolvedCountryLabel(normalizedCode, countryLabelOverrides(locale), displayNamesForLocale(locale));
}

export function countryOptionsForLocale(locale: SupportedLocale): CountryOption[] {
  const displayNames = displayNamesForLocale(locale);
  const overrides = countryLabelOverrides(locale);
  const options = ISO_COUNTRY_CODES.map((code) => ({
    code,
    label: resolvedCountryLabel(code, overrides, displayNames),
  }));
  const collator = collatorForLocale(locale);
  return collator
    ? options.sort((left, right) => collator.compare(left.label, right.label) || left.code.localeCompare(right.code))
    : options;
}
