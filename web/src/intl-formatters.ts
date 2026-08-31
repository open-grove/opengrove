const numberFormats = new Map<string, Intl.NumberFormat>();
const collators = new Map<string, Intl.Collator>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function cachedNumberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = formatterKey(locale, options);
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
}

export function cachedCollator(locale: string, options: Intl.CollatorOptions = {}): Intl.Collator {
  const key = formatterKey(locale, options);
  let formatter = collators.get(key);
  if (!formatter) {
    formatter = new Intl.Collator(locale, options);
    collators.set(key, formatter);
  }
  return formatter;
}

export function cachedDateTimeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  const key = formatterKey(locale ?? "", options);
  let formatter = dateTimeFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, formatter);
  }
  return formatter;
}

function formatterKey(
  locale: string,
  options: Intl.NumberFormatOptions | Intl.CollatorOptions | Intl.DateTimeFormatOptions,
): string {
  const normalizedOptions = Object.entries(options).sort(([left], [right]) => left.localeCompare(right));
  return `${locale}\u0000${JSON.stringify(normalizedOptions)}`;
}
