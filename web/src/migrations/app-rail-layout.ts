import { APP_STORAGE_KEYS } from "../identity";
import { RAIL_FULL_MIN_WIDTH, RAIL_ICON_WIDTH, type RailLayout } from "../runtime/app-rail-layout-model";

// Supports: OpenGrove 0.6.6 full/icon preferences written before issue #54.
// The three-state runtime reads only railLayout after this migration succeeds.
// Remove when: 0.7.0 or later no longer supports direct upgrades from 0.6.6.
export function migrateAppRailLayout(storage: Storage): RailLayout {
  const width = storage.getItem(APP_STORAGE_KEYS.railExpanded) === "false" ? RAIL_ICON_WIDTH : RAIL_FULL_MIN_WIDTH;
  const layout = { width, lastVisibleWidth: width };
  storage.setItem(APP_STORAGE_KEYS.railLayout, JSON.stringify(layout));
  storage.removeItem(APP_STORAGE_KEYS.railExpanded);
  return layout;
}
