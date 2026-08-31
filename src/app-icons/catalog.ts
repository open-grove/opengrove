export const APP_SYSTEM_ICON_NAMES = [
  "app-window",
  "article",
  "books",
  "briefcase",
  "camera",
  "chart-bar",
  "code",
  "database",
  "film-slate",
  "flower-lotus",
  "globe",
  "lightbulb",
  "megaphone",
  "palette",
  "rocket",
  "robot",
  "shopping-bag",
  "users",
  "wrench",
] as const;

export type AppSystemIconName = (typeof APP_SYSTEM_ICON_NAMES)[number];

export const APP_CUSTOM_ICON_MAX_BYTES = 1_000_000;
export const APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH = Math.ceil(APP_CUSTOM_ICON_MAX_BYTES / 3) * 4 + 64;

const APP_SYSTEM_ICON_NAME_SET = new Set<string>(APP_SYSTEM_ICON_NAMES);

export function appSystemIconToken(name: AppSystemIconName): string {
  return `phosphor:${name}`;
}

export function parseAppSystemIconToken(value: unknown): AppSystemIconName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("phosphor:")) return undefined;
  const name = normalized.slice("phosphor:".length);
  return APP_SYSTEM_ICON_NAME_SET.has(name) ? (name as AppSystemIconName) : undefined;
}

export function isAppSystemIconToken(value: unknown): boolean {
  return parseAppSystemIconToken(value) !== undefined;
}
