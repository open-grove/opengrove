import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [harnessSource, appNavigationSource, settingsDialogSource, roomSidebarSource, contactsViewSource] =
  await Promise.all([
    readFile(new URL("./visual-regression.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/sidebar/app-navigation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/sidebar/settings-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/rooms/room-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/rooms/contacts-view.tsx", import.meta.url), "utf8"),
  ]);

assert.match(
  appNavigationSource,
  /data-rail-section=\{props\.sectionTarget\}/,
  "rail buttons must expose the section they open without relying on translated labels",
);
assert.match(
  settingsDialogSource,
  /data-settings-section=\{item\.id\}/,
  "settings navigation must expose stable section ids",
);
assert.match(
  roomSidebarSource,
  /data-room-view-target="contacts"/,
  "the rooms sidebar must expose the contacts navigation target",
);
assert.match(
  contactsViewSource,
  /data-room-view-target="rooms"/,
  "the contacts view must expose the messages navigation target",
);
assert.match(
  contactsViewSource,
  /data-room-action="add-employee"/,
  "the employee dialog trigger must expose a stable action id",
);

for (const selector of [
  "[data-rail-section",
  "[data-settings-section",
  "[data-room-view-target",
  "[data-room-action",
]) {
  assert.ok(harnessSource.includes(selector), `visual regression harness must navigate with ${selector} selectors`);
}

assert.match(
  harnessSource,
  /page\.locator\(`\$\{selector\}:visible`\)/,
  "required targets must be resolved from the visible UI",
);
assert.equal(
  harnessSource.includes("page.locator(selector).first()"),
  false,
  "required targets must fail on ambiguity instead of silently choosing the first match",
);

for (const obsoleteLabel of [
  '"Kernel"',
  '"Employees"',
  '"Capability Settings"',
  '"添加员工"',
  '"通讯录"',
  '"查看通讯录"',
]) {
  assert.equal(
    harnessSource.includes(obsoleteLabel),
    false,
    `visual regression navigation must not depend on translated label ${obsoleteLabel}`,
  );
}

console.log("visual regression navigation contract passed");
