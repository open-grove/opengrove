export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function resolveThemePreference(
  preference: ThemePreference,
  options: {
    hostSystemTheme?: ResolvedTheme;
    browserSystemTheme?: ResolvedTheme;
  } = {},
): ResolvedTheme {
  if (preference !== "system") return preference;
  return options.hostSystemTheme ?? options.browserSystemTheme ?? "light";
}
