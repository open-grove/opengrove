import { useSyncExternalStore } from "react";

import { APP_STORAGE_KEYS } from "./identity";

export type IconStylePreference = "professional" | "pixel";

const ICON_STYLE_CHANGE_EVENT = "opengrove-icon-style-change";

function isIconStylePreference(value: string | null): value is IconStylePreference {
  return value === "professional" || value === "pixel";
}

function readStoredIconStylePreference(): IconStylePreference {
  if (typeof window === "undefined") {
    return "professional";
  }
  try {
    const stored = window.localStorage.getItem(APP_STORAGE_KEYS.iconStyle);
    return isIconStylePreference(stored) ? stored : "professional";
  } catch {
    return "professional";
  }
}

export function applyDocumentIconStyle(preference: IconStylePreference = readStoredIconStylePreference()): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.iconStyle = preference;
}

export function setIconStylePreference(preference: IconStylePreference): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(APP_STORAGE_KEYS.iconStyle, preference);
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  applyDocumentIconStyle(preference);
  window.dispatchEvent(new Event(ICON_STYLE_CHANGE_EVENT));
}

function subscribeIconStyle(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleChange = () => {
    applyDocumentIconStyle();
    listener();
  };
  window.addEventListener(ICON_STYLE_CHANGE_EVENT, listener);
  window.addEventListener("storage", handleChange);
  return () => {
    window.removeEventListener(ICON_STYLE_CHANGE_EVENT, listener);
    window.removeEventListener("storage", handleChange);
  };
}

export function useIconStylePreference(): {
  preference: IconStylePreference;
  setIconStylePreference: typeof setIconStylePreference;
} {
  const preference = useSyncExternalStore<IconStylePreference>(
    subscribeIconStyle,
    readStoredIconStylePreference,
    () => "professional",
  );
  return {
    preference,
    setIconStylePreference,
  };
}
