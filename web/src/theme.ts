import { useSyncExternalStore } from "react";

import { readDesktopApi } from "./desktop-api";
import { APP_STORAGE_KEYS } from "./identity";
import { resolveThemePreference, type ResolvedTheme, type ThemePreference } from "./theme-resolution";

export type { ResolvedTheme, ThemePreference } from "./theme-resolution";

const THEME_CHANGE_EVENT = "opengrove-theme-change";
const HOST_THEME_CHANGE_EVENT = "opengrove-host-theme-change";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";
let stopDocumentThemeSync: (() => void) | undefined;
let hostSystemTheme: ResolvedTheme | undefined;

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    const stored = window.localStorage.getItem(APP_STORAGE_KEYS.theme);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  const browserSystemTheme =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(DARK_MEDIA_QUERY).matches
        ? "dark"
        : "light"
      : undefined;
  return resolveThemePreference(preference, { hostSystemTheme, browserSystemTheme });
}

export function applyDocumentTheme(preference: ThemePreference = readStoredThemePreference()): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(preference);
  root.dataset.theme = preference;
  root.dataset.resolvedTheme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
  void readDesktopApi()
    ?.setWindowChromeTheme?.(resolvedTheme)
    .catch(() => undefined);
}

export function startDocumentThemeSync(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  if (stopDocumentThemeSync) {
    return stopDocumentThemeSync;
  }

  const media = window.matchMedia?.(DARK_MEDIA_QUERY);
  const handleChange = () => {
    applyDocumentTheme();
  };
  window.addEventListener("storage", handleChange);
  window.addEventListener(THEME_CHANGE_EVENT, handleChange);
  if (media?.addEventListener) {
    media.addEventListener("change", handleChange);
  } else {
    media?.addListener?.(handleChange);
  }
  applyDocumentTheme();

  stopDocumentThemeSync = () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener(THEME_CHANGE_EVENT, handleChange);
    if (media?.removeEventListener) {
      media.removeEventListener("change", handleChange);
    } else {
      media?.removeListener?.(handleChange);
    }
    stopDocumentThemeSync = undefined;
  };
  return stopDocumentThemeSync;
}

export function setThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(APP_STORAGE_KEYS.theme, preference);
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  applyDocumentTheme(preference);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function setHostSystemTheme(theme: ResolvedTheme | undefined): void {
  if (theme === hostSystemTheme) return;
  hostSystemTheme = theme;
  if (typeof window !== "undefined" && readStoredThemePreference() === "system") {
    applyDocumentTheme("system");
    window.dispatchEvent(new Event(HOST_THEME_CHANGE_EVENT));
  }
}

function subscribeTheme(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleChange = () => {
    applyDocumentTheme();
    listener();
  };
  const media = window.matchMedia?.(DARK_MEDIA_QUERY);
  window.addEventListener(THEME_CHANGE_EVENT, handleChange);
  window.addEventListener(HOST_THEME_CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleChange);
  if (media?.addEventListener) {
    media.addEventListener("change", handleChange);
  } else {
    media?.addListener?.(handleChange);
  }
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, handleChange);
    window.removeEventListener(HOST_THEME_CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleChange);
    if (media?.removeEventListener) {
      media.removeEventListener("change", handleChange);
    } else {
      media?.removeListener?.(handleChange);
    }
  };
}

export function useThemePreference() {
  const preference = useSyncExternalStore(subscribeTheme, readStoredThemePreference, () => "system");
  return {
    preference,
    setThemePreference,
  };
}
