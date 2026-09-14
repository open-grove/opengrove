import { useLayoutEffect, useSyncExternalStore } from "react";

// Window policy for the app shell. Embedded workbenches measure their own container.
export const COMPACT_LAYOUT_QUERY = "(max-width: 900px)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches;

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

// Safari resizes the visual viewport when the keyboard opens. Keep this policy
// at the shell boundary, so every composer and dialog gets the same usable height.
export function useVisualViewportHeight() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty("--opengrove-visual-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--opengrove-visual-height");
    };
  }, []);
}
