export const RAIL_ICON_WIDTH = 58;
export const RAIL_FULL_MIN_WIDTH = 126;
export const RAIL_MAX_WIDTH = 280;
export const RAIL_HIDDEN_THRESHOLD = 20;

export type RailMode = "hidden" | "icons" | "full";
export interface RailLayout {
  width: number;
  lastVisibleWidth: number;
}

export function getRailMode(width: number): RailMode {
  if (width < RAIL_HIDDEN_THRESHOLD) return "hidden";
  return width < RAIL_FULL_MIN_WIDTH ? "icons" : "full";
}

export function previewRailWidth(width: number): number {
  if (width < RAIL_HIDDEN_THRESHOLD) return 0;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_ICON_WIDTH, width));
}

export function settleRailWidth(width: number, startWidth: number): number {
  const preview = previewRailWidth(width);
  if (preview > RAIL_ICON_WIDTH && preview < RAIL_FULL_MIN_WIDTH) {
    return preview > startWidth ? RAIL_FULL_MIN_WIDTH : RAIL_ICON_WIDTH;
  }
  return Math.round(preview);
}

export function commitRailWidth(layout: RailLayout, width: number): RailLayout {
  return { width, lastVisibleWidth: width > 0 ? width : layout.lastVisibleWidth };
}

export function toggleRailLayout(layout: RailLayout): RailLayout {
  return commitRailWidth(layout, layout.width === 0 ? layout.lastVisibleWidth : 0);
}

export function parseRailLayout(raw: string): RailLayout | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("width" in value) || !("lastVisibleWidth" in value)) return null;
    const { width, lastVisibleWidth } = value;
    if (width !== 0 && !isVisibleWidth(width)) return null;
    if (!isVisibleWidth(lastVisibleWidth)) return null;
    return { width, lastVisibleWidth: width > 0 ? width : lastVisibleWidth };
  } catch {
    return null;
  }
}

function isVisibleWidth(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (value === RAIL_ICON_WIDTH || (value >= RAIL_FULL_MIN_WIDTH && value <= RAIL_MAX_WIDTH))
  );
}
