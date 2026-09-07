import { APP_STORAGE_KEYS } from "../identity";
import { RAIL_FULL_MIN_WIDTH, RAIL_ICON_WIDTH, type RailLayout } from "../runtime/app-rail-layout-model";

// Issue #54: replace the old full/icon boolean once, preserving existing navigation preferences.
// The three-state runtime reads only railLayout after this migration succeeds.
// Remove when supported upgrades no longer include versions that wrote railExpanded.
export function migrateAppRailLayout(storage: Storage): RailLayout {
  const width = storage.getItem(APP_STORAGE_KEYS.railExpanded) === "false" ? RAIL_ICON_WIDTH : RAIL_FULL_MIN_WIDTH;
  const layout = { width, lastVisibleWidth: width };
  storage.setItem(APP_STORAGE_KEYS.railLayout, JSON.stringify(layout));
  storage.removeItem(APP_STORAGE_KEYS.railExpanded);
  return layout;
}
