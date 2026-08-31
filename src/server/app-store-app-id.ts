const APP_STORE_APP_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function isValidAppStoreAppId(value: string): boolean {
  return value.trim() === value && APP_STORE_APP_ID_PATTERN.test(value);
}

/** Keep ordinary App IDs readable while escaping names that Windows cannot create. */
export function appStoreAppDirectoryName(appId: string): string {
  if (!isValidAppStoreAppId(appId)) throw new Error("app_store_app_id_invalid");
  const escaped = appId.replaceAll(":", "%3A").replace(/\.+$/, (suffix) => "%2E".repeat(suffix.length));
  return WINDOWS_RESERVED_NAME_PATTERN.test(appId) ? `%00${escaped}` : escaped;
}

export function isAppStoreAppDirectoryName(value: string): boolean {
  const unprefixed = value.startsWith("%00") ? value.slice(3) : value;
  const decoded = unprefixed.replace(/(?:%2E)+$/i, (suffix) => ".".repeat(suffix.length / 3)).replaceAll(/%3A/gi, ":");
  return isValidAppStoreAppId(decoded) && appStoreAppDirectoryName(decoded) === value;
}
