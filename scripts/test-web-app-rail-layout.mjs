import assert from "node:assert/strict";
import {
  getRailMode,
  previewRailWidth,
  settleRailWidth,
  toggleRailLayout,
  commitRailWidth,
  parseRailLayout,
} from "../web/src/runtime/app-rail-layout-model.ts";

assert.equal(getRailMode(0), "hidden");
assert.equal(getRailMode(58), "icons");
assert.equal(getRailMode(126), "full");
assert.equal(previewRailWidth(12), 0);
assert.equal(previewRailWidth(30), 58);
assert.equal(previewRailWidth(93), 93);
assert.equal(previewRailWidth(500), 280);
assert.equal(settleRailWidth(90, 200), 58, "Dragging inward snaps to icons");
assert.equal(settleRailWidth(90, 58), 126, "Dragging outward snaps to full");
assert.equal(settleRailWidth(10, 200), 0);
assert.equal(settleRailWidth(247, 126), 247);

const full = { width: 247, lastVisibleWidth: 247 };
const hidden = toggleRailLayout(full);
assert.deepEqual(hidden, { width: 0, lastVisibleWidth: 247 });
assert.deepEqual(toggleRailLayout(hidden), full, "The titlebar restores the exact previous width");
const icons = commitRailWidth(full, 58);
assert.deepEqual(toggleRailLayout(toggleRailLayout(icons)), { width: 58, lastVisibleWidth: 58 });
assert.deepEqual(commitRailWidth(full, 0), hidden, "Dragging to hidden preserves the previous visible width");
assert.deepEqual(parseRailLayout(JSON.stringify(hidden)), hidden, "Hidden mode survives a reload");
assert.equal(
  parseRailLayout('{"width":93,"lastVisibleWidth":93}'),
  null,
  "Intermediate preview widths are never persisted",
);
assert.equal(parseRailLayout('{"width":0,"lastVisibleWidth":0}'), null);
assert.equal(parseRailLayout('{"width":"58","lastVisibleWidth":58}'), null);
assert.equal(parseRailLayout("bad json"), null);
console.log("web-app-rail-layout model passed");
