import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import postcss from "postcss";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-room-interaction-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");

try {
  await testGroupHeaderAvatarCssContract();
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await writeFile(htmlPath, fixtureHtml(), "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const desktopPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await desktopPage.goto(pathToFileURL(htmlPath).href);
    await testDesktopStopAction(desktopPage);
    await testPendingInteractionCancelAction(desktopPage);
    await testDisclosureMotionPolicy(desktopPage);
    await testResponsiveLayout(desktopPage);
    await testReactiveLanguage(desktopPage);
    await testHoverMessageActions(desktopPage);
    await testResourceContextMenuLifecycle(desktopPage);

    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(pathToFileURL(htmlPath).href);
      await testTouchStopAction(touchPage);
    } finally {
      await touchContext.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-room-interaction-ui harness ok");

async function testGroupHeaderAvatarCssContract() {
  const mountedAppCss = await readFile(join(projectRoot, "web/src/components/apps/mounted-app-workbench.css"), "utf8");
  const roomsCss = await readFile(join(projectRoot, "web/src/components/rooms/rooms.css"), "utf8");
  const contactsLayoutCss = await readFile(
    join(projectRoot, "web/src/components/rooms/contacts-styles/layout-and-directory.css"),
    "utf8",
  );
  const extensionsViewCss = await readFile(
    join(projectRoot, "web/src/components/extensions/extensions-view.module.css"),
    "utf8",
  );
  const appStoreViewCss = await readFile(join(projectRoot, "web/src/components/network/app-store-view.css"), "utf8");
  const appNavigationCss = await readFile(
    join(projectRoot, "web/src/components/sidebar/app-navigation.module.css"),
    "utf8",
  );
  const appNavigationSource = await readFile(
    join(projectRoot, "web/src/components/sidebar/app-navigation.tsx"),
    "utf8",
  );
  const appShellCss = await readFile(join(projectRoot, "web/src/app-shell.css"), "utf8");
  const appWorkspaceCss = await readFile(join(projectRoot, "web/src/app-workspace.css"), "utf8");
  const appChatFrameCss = await readFile(join(projectRoot, "web/src/app-chat-frame.css"), "utf8");
  const chatLayoutCss = await readFile(join(projectRoot, "web/src/components/chat/chat-layout.css"), "utf8");
  const mountedAppChatSource = await readFile(
    join(projectRoot, "web/src/components/apps/mounted-app-chat-panel.tsx"),
    "utf8",
  );
  const roomSettingsSource = await readFile(
    join(projectRoot, "web/src/components/rooms/room-settings-panel.tsx"),
    "utf8",
  );
  const roomMembersCss = await readFile(join(projectRoot, "web/src/components/rooms/room-members.css"), "utf8");
  const nameAvatarCss = await readFile(join(projectRoot, "web/src/components/ui/name-avatar.module.css"), "utf8");
  const roomWorkspaceCss = await readFile(join(projectRoot, "web/src/components/rooms/room-workspace.css"), "utf8");
  const motionMenuCss = await readFile(join(projectRoot, "web/src/components/ui/motion/menu.module.css"), "utf8");
  const overlaySurfaceCss = await readFile(
    join(projectRoot, "web/src/components/ui/motion/overlay-surface.module.css"),
    "utf8",
  );
  const roomMessageStreamCss = await readFile(
    join(projectRoot, "web/src/components/rooms/room-message-stream.css"),
    "utf8",
  );
  const roomMessageStreamSource = await readFile(
    join(projectRoot, "web/src/components/rooms/room-message-stream.tsx"),
    "utf8",
  );
  const motionDisclosureSource = await readFile(
    join(projectRoot, "web/src/components/ui/motion/disclosure.tsx"),
    "utf8",
  );
  const directoryTreeSource = await readFile(join(projectRoot, "web/src/components/shared/directory-tree.tsx"), "utf8");
  const directoryTreeCss = await readFile(
    join(projectRoot, "web/src/components/shared/directory-tree.module.css"),
    "utf8",
  );
  const tokensCss = await readFile(join(projectRoot, "web/src/styles/tokens.css"), "utf8");
  const conversationSidebarSource = await readFile(
    join(projectRoot, "web/src/components/sidebar/conversation-sidebar.tsx"),
    "utf8",
  );
  const conversationSidebarModelSource = await readFile(
    join(projectRoot, "web/src/components/sidebar/conversation-sidebar-model.tsx"),
    "utf8",
  );

  assert.doesNotMatch(
    mountedAppCss,
    /\.mounted-app-room-target-icon \.rooms-avatar/,
    "the App header must not force nested group members to the direct-avatar size",
  );
  assert.match(
    mountedAppCss,
    /\.mounted-app-room-target-icon > \.rooms-avatar,\s*\n\.mounted-app-room-target-icon > \.rooms-room-avatar \{\s*\n\s*width: 36px;\s*\n\s*height: 36px;/,
    "only direct single-member avatars should use the App header icon size",
  );
  assert.match(
    mountedAppCss,
    /\.mounted-app-room-target-icon \.mounted-app-room-avatar\.has-members \{\s*\n\s*--room-avatar-stack-item-size: var\(--sp-5\);/,
    "the App group header must reuse the external group header member size",
  );
  assert.doesNotMatch(
    roomsCss,
    /\.rooms-list-item \.rooms-avatar/,
    "the room list must not force nested group members into square direct-avatar boxes",
  );
  assert.match(
    roomsCss,
    /\.rooms-room-avatar,\s*\n\.rooms-list-item > \.rooms-avatar \{/,
    "the room-list avatar sizing rule must only target direct avatars",
  );
  assert.match(
    roomsCss,
    /\.rooms-view \{[\s\S]*?background: transparent;[\s\S]*?padding: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the room columns must use the shared page insets without a third background layer",
  );
  assert.match(
    contactsLayoutCss,
    /\.contacts-view \{[\s\S]*?padding: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the contacts page must share the global page insets",
  );
  assert.match(
    extensionsViewCss,
    /\.view \{[\s\S]*?padding: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the extensions page must share the global page insets",
  );
  assert.match(
    appStoreViewCss,
    /\.app-store-view \{[\s\S]*?padding: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the App store page must share the global page insets",
  );
  assert.match(
    appNavigationSource,
    /className=\{clsx\("app-account-menu", styles\.accountMenu\)\}[\s\S]{0,160}?size="content"/,
    "the account menu must use the shared content-sized popup setting",
  );
  assert.doesNotMatch(
    appNavigationCss,
    /\.accountMenu(?:\[data-size="preserve"\])? \{[^}]*\bwidth:/,
    "the account menu must not override content sizing with a fixed width",
  );
  assert.match(
    appNavigationCss,
    /\.accountMenuItem > span \{[\s\S]*?white-space: nowrap;/,
    "account-menu labels must stay on one line",
  );
  assert.match(
    appNavigationCss,
    /\.userButtonAvatar \{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 1;[\s\S]*?line-height: 0;/,
    "the account trigger avatar must be explicitly centered in its grid cell",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.userButtonName \{[\s\S]*?align-self: center;[\s\S]*?line-height: var\(--lh-tight\);/,
    "the expanded account name must be vertically centered with the avatar",
  );
  assert.match(
    mountedAppChatSource,
    /import \{ RoomSettingsPanel,[^}]*RoomMemberPickerMode \} from "\.\.\/rooms\/room-settings-panel";/,
    "mounted App group settings must reuse the shared room settings component",
  );
  assert.match(
    mountedAppChatSource,
    /<RoomSettingsPanel[\s\S]*?presentation="popover"/,
    "the shared room settings component must support the mounted App popover presentation",
  );
  assert.doesNotMatch(
    mountedAppChatSource,
    /className="mounted-app-member-section"/,
    "mounted App group settings must not maintain a second hand-written settings layout",
  );
  assert.match(
    roomSettingsSource,
    /presentation\?: "panel" \| "popover";/,
    "the shared room settings component must expose an embedded popover presentation",
  );
  assert.match(
    nameAvatarCss,
    /\.avvvatars p \{[\s\S]*?display: flex;[\s\S]*?align-items: center;[\s\S]*?justify-content: center;[\s\S]*?line-height: 1;/,
    "fallback avatar text must center its real line box instead of the library's zero-height baseline box",
  );
  assert.match(
    roomWorkspaceCss,
    /\.room-composer \.opengrove-primary\.opengrove-send:not\(:disabled\) \{[\s\S]*?background: var\(--c-accent-solid\);/,
    "enabled room send actions must use the product accent instead of the disabled neutral color",
  );
  assert.match(
    roomWorkspaceCss,
    /\.room-composer \.opengrove-primary\.opengrove-send:not\(:disabled\):hover \{[\s\S]*?background: var\(--button-primary-hover-background-color\);/,
    "room send hover actions must retain the filled-primary contrast contract",
  );
  assert.match(
    roomWorkspaceCss,
    /\.room-composer \.opengrove-primary\.opengrove-send:disabled \{[\s\S]*?opacity: 1;/,
    "disabled room send actions must define their own stable low-contrast appearance",
  );
  assert.match(
    roomSettingsSource,
    /<RoomGroupAvatar[\s\S]*?title=\{props\.activeRoom\.title\}[\s\S]*?className="rooms-group-profile-icon"[\s\S]*?members=\{props\.visibleRoomMembers\.filter\(\(member\) => props\.activeRoom\.memberIds\.includes\(member\.id\)\)\}/,
    "the settings identity row must reuse the active room's member avatar stack",
  );
  assert.match(
    roomMembersCss,
    /\.rooms-side-panel\[data-presentation="popover"\] \.rooms-group-profile-card \{[\s\S]*?grid-template-columns: max-content minmax\(0, 1fr\);[\s\S]*?min-height: var\(--sp-10\);[\s\S]*?padding: 0 var\(--sp-2\);/,
    "the App popover identity row must be a compact 40px row instead of inheriting the tall side-panel card",
  );
  assert.match(
    roomMembersCss,
    /\.rooms-side-panel\[data-presentation="popover"\] \.rooms-group-profile-icon\.room-group-avatar\.has-members \{[\s\S]*?--room-avatar-stack-item-size: var\(--sp-5\);[\s\S]*?--room-avatar-stack-overlap: var\(--sp-2\);[\s\S]*?width: max-content;[\s\S]*?height: var\(--room-avatar-stack-item-size\);/,
    "the App popover must use the same stacked-avatar dimensions as its group header",
  );
  assert.match(
    mountedAppChatSource,
    /<EmployeeSettingsDialog[\s\S]*?member=\{editingEmployee\}/,
    "mounted App member settings actions must open the real shared employee settings dialog",
  );
  assert.match(
    mountedAppChatSource,
    /<RoomChatSurface[\s\S]*?onOpenMemberProfile=\{openAppGroupEmployeeSettings\}[\s\S]*?\/>/,
    "mounted App chat messages must expose the shared employee settings action from their avatars",
  );
  assertCssDeclarations(
    motionMenuCss,
    ".popup",
    {
      border: "0",
      "border-radius": "var(--r-lg)",
      "box-shadow": "var(--shadow-md)",
      padding: "var(--sp-1-5)",
    },
    "all action menus must share the same light edge, floating depth, and comfortable inset",
  );
  assertCssDeclarations(
    overlaySurfaceCss,
    '.surface[data-size="content"]',
    {
      width: "max-content",
      "min-width":
        "min(\n    var(--overlay-surface-content-min-width),\n    var(--overlay-surface-available-width, calc(100vw - var(--sp-6)))\n  )",
      "max-width":
        "min(\n    var(--overlay-surface-content-max-width),\n    var(--overlay-surface-available-width, calc(100vw - var(--sp-6)))\n  )",
    },
    "content overlays must consume the shared width contract while remaining bounded by the viewport",
  );
  assertCssDeclarations(
    motionMenuCss,
    ".item",
    {
      "grid-template-columns": "20px minmax(0, 1fr) auto",
      "min-height": "var(--sp-9)",
      "font-size": "var(--fs-base)",
    },
    "shared action rows must give icons and labels a comfortable, readable rhythm",
  );
  assertCssDeclarations(
    motionMenuCss,
    ".separator",
    {
      background: "var(--c-line-08)",
    },
    "action groups must use a quiet separator that does not compete with menu labels",
  );
  assert.match(
    roomMessageStreamSource,
    /<MotionContextMenu[\s\S]*?<MotionMenuItem[\s\S]*?<MotionMenuItem/,
    "Rooms message context actions must use the shared menu surface and rows",
  );
  assert.doesNotMatch(
    roomMessageStreamCss,
    /\.room-chat-message-context-menu\s*\{/,
    "Rooms must not maintain a second visual contract for context menus",
  );
  assert.doesNotMatch(
    roomMessageStreamSource,
    /onPointerLeave=\{[^}]*\.blur\(/,
    "leaving a message or author must not forcibly remove keyboard focus",
  );
  assert.match(
    motionDisclosureSource,
    /initial=\{initiallyOpen \? false : "collapsed"\}/,
    "initially-open disclosures must render at their natural height without replaying the reveal",
  );
  assert.match(
    motionDisclosureSource,
    /transitionEnd: \{ display: "none" \}/,
    "collapsed disclosures must stop hidden subtree animations after their exit completes",
  );
  assert.match(
    appNavigationSource,
    /<MotionMenu[\s\S]*?side="right"[\s\S]*?align="start"[\s\S]*?className="app-rail-user-app-menu"/,
    "App row actions must use the shared anchored menu instead of guessed fixed coordinates",
  );
  assert.doesNotMatch(
    appNavigationSource,
    /function menuAnchorFromButton\(/,
    "App row action menus must not position themselves with guessed menu dimensions",
  );
  assert.match(
    appShellCss,
    /\.app-shell \{[\s\S]*?--app-titlebar-height: 40px;[\s\S]*?--app-page-top-inset: 4px;[\s\S]*?--app-page-bottom-inset: 16px;/,
    "all product views must share one 40px titlebar and 4px/16px page insets",
  );
  assert.doesNotMatch(
    appShellCss,
    /\.app-shell\[data-view="app"\] \{[^}]*--app-titlebar-height:/,
    "the mounted App must not override the global titlebar height",
  );
  assert.match(
    appShellCss,
    /\.sidebar \{[\s\S]*?margin: var\(--app-page-top-inset\) 0 var\(--app-page-bottom-inset\) 10px;/,
    "the Kernel sidebar must use the global page insets",
  );
  assert.match(
    appWorkspaceCss,
    /\.app-shell\[data-view="chat"\] \.workspace \{[\s\S]*?margin: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the Kernel workspace must use the global page insets",
  );
  assert.match(
    appWorkspaceCss,
    /\.app-shell\[data-view="settings"\] \.workspace \{[\s\S]*?margin: 0;[\s\S]*?border: 0;[\s\S]*?background: transparent;/,
    "the settings workspace must leave page insets and independent surfaces to the embedded two-pane shell",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \{[\s\S]*?padding-top: 0;/,
    "the expanded rail section heading must align with the top of the App workbench",
  );
  assert.match(
    appNavigationCss,
    /\.rail \{[\s\S]*?--app-rail-item-height: 32px;[\s\S]*?--app-rail-icon-column: 38px;[\s\S]*?padding: 0 10px 14px;/,
    "collapsed and expanded navigation must share one compact item height and icon column",
  );
  assert.match(
    appNavigationCss,
    /\.sectionTitle \{[\s\S]*?height: 14px;[\s\S]*?visibility: hidden;[\s\S]*?font-size: var\(--fs-xs\);/,
    "collapsed section headings must reserve only the compact expanded geometry",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.sectionTitle \{[\s\S]*?visibility: visible;/,
    "expanding the rail must reveal section headings without changing layout",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.button \{[\s\S]*?grid-template-columns: var\(--app-rail-icon-column\) minmax\(0, 1fr\);[\s\S]*?height: var\(--app-rail-item-height\);[\s\S]*?color: var\(--app-rail-button-fg\);[\s\S]*?padding: 0;/,
    "expanded navigation buttons must retain collapsed icon position, size, and opacity",
  );
  assert.doesNotMatch(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.button \{[^}]*(?:height: 31px|grid-template-columns: 24px|padding: 0 5px 0 7px)/,
    "expanded navigation must not rebase icons onto a smaller row",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.buttonLabel,[\s\S]*?\.rail\[data-expanded="true"\] \.userTabLabel \{[\s\S]*?max-width: 100%;[\s\S]*?margin-left: -2px;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
    "expanded rail labels must sit closer to their icons and truncate with an ellipsis",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.userTabWrap \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?padding-right: 0;/,
    "App rows must give their label the full row width instead of reserving a permanent action column",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.userTabLabel \{[\s\S]*?box-sizing: border-box;[\s\S]*?width: calc\(100% \+ 2px\);[\s\S]*?min-width: 0;/,
    "App labels must be allowed to shrink so text-overflow can render an ellipsis",
  );
  assert.doesNotMatch(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.userTabLabel \{[^}]*min-width: 48px;/,
    "App labels must not retain the minimum width that caused hard clipping",
  );
  assert.match(
    appNavigationCss,
    /\.rail\[data-expanded="true"\] \.userTabMenuButton \{[\s\S]*?position: absolute;[\s\S]*?top: 50%;[\s\S]*?right: 4px;[\s\S]*?transform: translateY\(-50%\);/,
    "the App action trigger must overlay the row only when revealed",
  );
  assert.match(
    appShellCss,
    /\.app-shell\[data-view="chat"\] \.sidebar \{[\s\S]*?border-color: transparent;[\s\S]*?background: var\(--c-surface\);/,
    "the Kernel list must use the same filled, borderless card language as the employee list",
  );
  assert.match(
    appWorkspaceCss,
    /\.app-shell\[data-view="chat"\] \.workspace \{[\s\S]*?border: 1px solid transparent;[\s\S]*?background: var\(--c-surface\);/,
    "the Kernel workspace must use the same filled, borderless card language as the employee workspace",
  );
  assert.match(
    appChatFrameCss,
    /\.chat-view \{[\s\S]*?background: transparent;/,
    "the Kernel content must not paint a second dark layer over its workspace card",
  );
  assert.match(
    chatLayoutCss,
    /\.conversation \{[\s\S]*?background: transparent;/,
    "the Kernel conversation must inherit the shared workspace card surface",
  );
  assert.match(
    mountedAppCss,
    /\.app-shell\[data-view="app"\] \.mounted-app-view \{[\s\S]*?padding: var\(--app-page-top-inset\) 10px var\(--app-page-bottom-inset\);/,
    "the mounted App page must share the global page insets",
  );
  assert.match(
    directoryTreeSource,
    /<MotionMenu[\s\S]*?side="right"[\s\S]*?align="start"[\s\S]*?className="sidebar-tree-menu"/,
    "directory actions must reuse the shared anchored menu",
  );
  assert.match(
    directoryTreeSource,
    /<ProductIcon name="more" system="lucide" size=\{15\} \/>/,
    "directory actions must reuse the same overflow glyph as the outer App tabs",
  );
  assert.match(
    appNavigationSource,
    /<ProductIcon name="more" system="lucide" size=\{15\} \/>/,
    "outer App tabs must source their overflow glyph from the shared product icon",
  );
  assertCssDeclarations(
    directoryTreeCss,
    ".row",
    { "padding-right": "var(--sp-3)" },
    "directory overflow actions must keep the same optical edge distance as outer App tabs",
  );
  assertCssDeclarations(
    directoryTreeCss,
    ".more",
    { width: "var(--sp-6)", height: "var(--sp-6)" },
    "directory overflow actions must share the outer App tab's trigger box",
  );
  assertCssDeclarations(
    directoryTreeCss,
    ".more:hover",
    { background: "transparent", color: "var(--directory-tree-more-hover-fg)" },
    "directory overflow hover must not paint a second surface over the hovered row",
  );
  assertCssDeclarations(
    tokensCss,
    ":root",
    { "--directory-tree-more-fg": "var(--og-text-muted)" },
    "directory overflow actions must share the outer App tab's revealed color",
  );
  assertCssDeclarations(
    appNavigationCss,
    '.rail[data-expanded="true"] .userTabMenuButton',
    { right: "4px", width: "16px", height: "24px" },
    "outer App tabs must preserve the shared overflow alignment contract",
  );
  assert.doesNotMatch(
    directoryTreeSource,
    /createPortal\(|menuAnchorFromButton\(event\.currentTarget\)/,
    "directory actions must not maintain a second portal positioning system",
  );
  assert.match(
    conversationSidebarSource,
    /<MotionMenu[\s\S]*?side="right"[\s\S]*?align="start"[\s\S]*?className="project-row-menu"/,
    "project actions must reuse the shared anchored menu",
  );
  assert.doesNotMatch(
    conversationSidebarSource,
    /createPortal\(|menuAnchorFromButton\(/,
    "conversation sidebar menus must not guess their popup coordinates",
  );
  assert.match(
    conversationSidebarModelSource,
    /<MotionMenuItem[\s\S]*?conversation\.createTime[\s\S]*?<MotionMenuItem[\s\S]*?conversation\.updateTime/,
    "conversation sorting must reuse the shared menu row component",
  );
}

function assertCssDeclarations(css, selector, expected, message) {
  const declarations = new Map();
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
  });
  assert.ok(declarations.size > 0, `${message}: selector ${selector} must exist`);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(
      declarations.get(property)?.replaceAll("\r\n", "\n"),
      value.replaceAll("\r\n", "\n"),
      `${message}: ${selector} must set ${property}`,
    );
  }
}

async function testDesktopStopAction(page) {
  assert.equal(await leadingOrbOpacity(page, "no-stop"), "1");
  await page.locator("#no-stop > .og-disclosure-row").hover();
  assert.equal(await leadingOrbOpacity(page, "no-stop"), "1", "hover without a stop action must keep the Orb visible");

  await page.locator("#disabled-stop .room-run-leading-control").hover();
  assert.equal(await leadingOrbOpacity(page, "disabled-stop"), "1", "a disabled stop action must keep the Orb visible");
  assert.equal(await leadingStopOpacity(page, "disabled-stop"), "0");

  assert.equal(await leadingOrbOpacity(page, "enabled-stop"), "1");
  assert.equal(await leadingStopOpacity(page, "enabled-stop"), "0");
  await page.locator("#enabled-stop .room-run-leading-control").hover();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("#enabled-stop .room-run-leading-orb")).opacity === "0",
  );
  assert.equal(
    await leadingOrbOpacity(page, "enabled-stop"),
    "0",
    "hovering the leading slot should replace the Orb in place",
  );
  assert.equal(await leadingStopOpacity(page, "enabled-stop"), "1");

  await page.locator("#disabled-stop .room-run-leading-control").focus();
  assert.equal(
    await leadingOrbOpacity(page, "disabled-stop"),
    "1",
    "focus with a disabled stop action must keep the Orb visible",
  );
  await page.locator("#enabled-stop .room-run-leading-control").focus();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("#enabled-stop .room-run-leading-orb")).opacity === "0",
  );
  assert.equal(await leadingOrbOpacity(page, "enabled-stop"), "0");
  assert.equal(await leadingStopOpacity(page, "enabled-stop"), "1");
}

async function testDisclosureMotionPolicy(page) {
  const defaultOpenDisclosure = page.locator("#default-open-disclosure-root .og-disclosure");
  await page.waitForFunction(() => window.__defaultOpenDisclosureHeights?.length >= 8);
  const defaultOpenHeights = await page.evaluate(() => window.__defaultOpenDisclosureHeights);
  assert.equal(
    await defaultOpenDisclosure.getByRole("button", { name: "默认展开" }).getAttribute("aria-expanded"),
    "true",
  );
  assert.ok(
    Math.min(...defaultOpenHeights) >= 120,
    `an initially-open disclosure must not animate up from zero: ${defaultOpenHeights.join(", ")}`,
  );

  const shortDisclosure = page.locator("#short-disclosure-root .og-disclosure");
  const shortToggle = shortDisclosure.getByRole("button", { name: "短内容" });
  assert.equal(await shortDisclosure.locator(".og-disclosure-panel-inner").count(), 0);
  await shortToggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector("#short-disclosure-root .og-disclosure-panel")?.getAttribute("data-motion-mode") ===
      "height",
  );
  assert.equal(
    await shortDisclosure
      .locator(".og-disclosure-motion-fixture")
      .evaluate((element) => getComputedStyle(element).animationName),
    "slide-up",
    "short disclosure content should retain the staggered height reveal",
  );
  await shortToggle.click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("#short-disclosure-root .og-disclosure-panel-motion")).display === "none",
  );
  assert.equal(
    await shortDisclosure.locator(".og-disclosure-panel-inner").count(),
    1,
    "disclosure content should remain mounted after the first expansion",
  );
  assert.equal(await shortDisclosure.locator(".og-disclosure-panel-motion").getAttribute("aria-hidden"), "true");
  assert.equal(
    await shortDisclosure
      .locator(".og-disclosure-panel-motion")
      .evaluate((element) => getComputedStyle(element).display),
    "none",
    "a collapsed disclosure must stop background CSS animations in its mounted subtree",
  );

  const longDisclosure = page.locator("#long-disclosure-root .og-disclosure");
  const longToggle = longDisclosure.getByRole("button", { name: "长内容" });
  await longToggle.click();
  await page.waitForFunction(() => {
    const panel = document.querySelector("#long-disclosure-root .og-disclosure-panel");
    const content = panel?.querySelector(".og-disclosure-panel-inner");
    return (
      panel?.getAttribute("data-motion-mode") === "fade" &&
      content instanceof HTMLElement &&
      content.getBoundingClientRect().height >= 720
    );
  });
  const longDisclosureHeight = await longDisclosure
    .locator(".og-disclosure-panel-inner")
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(
    longDisclosureHeight >= 720,
    `long disclosure content should reveal at its natural height without animating through it: ${longDisclosureHeight}`,
  );
  assert.equal(
    await page.evaluate(() => window.__disclosureFixtureMounts.long),
    1,
    "measuring long content must not remount its expensive subtree",
  );
  assert.equal(
    await longDisclosure
      .locator(".og-disclosure-motion-fixture")
      .evaluate((element) => getComputedStyle(element).animationName),
    "none",
    "long disclosure content must not stagger every child",
  );
  await longToggle.click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("#long-disclosure-root .og-disclosure-panel-motion")).display === "none",
  );
  assert.equal(
    await longDisclosure.locator(".og-disclosure-panel-inner").count(),
    1,
    "long disclosure content should remain mounted after collapsing",
  );
  assert.equal(
    await longDisclosure
      .locator(".og-disclosure-panel-motion")
      .evaluate((element) => getComputedStyle(element).display),
    "none",
    "long content must also become display:none after the lightweight exit",
  );
}

async function testTouchStopAction(page) {
  const media = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
  }));
  assert.ok(media.coarse || media.noHover, "touch fixture must exercise the coarse-pointer rules");
  assert.equal(await leadingOrbOpacity(page, "no-stop"), "1");
  assert.equal(await leadingOrbOpacity(page, "disabled-stop"), "1");
  assert.equal(await leadingStopOpacity(page, "disabled-stop"), "0");
  assert.equal(
    await leadingOrbOpacity(page, "enabled-stop"),
    "1",
    "touch should not replace the Orb with a persistent stop icon",
  );
  assert.equal(await leadingStopOpacity(page, "enabled-stop"), "0");

  const liveStop = page.locator("#touch-runtime .room-run-leading-control");
  await liveStop.tap();
  assert.equal(
    await page.evaluate(() => window.__touchCancelCount),
    0,
    "the first touch must only reveal the stop action",
  );
  await page.waitForFunction(() => {
    const orb = document.querySelector("#touch-runtime .room-run-leading-orb");
    return orb instanceof HTMLElement && getComputedStyle(orb).opacity === "0";
  });
  assert.equal(
    await liveStop.locator(".room-run-leading-orb").evaluate((element) => getComputedStyle(element).opacity),
    "0",
  );
  assert.equal(
    await liveStop.locator(".room-run-leading-stop").evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  await liveStop.tap();
  assert.equal(
    await page.evaluate(() => window.__touchCancelCount),
    1,
    "the second touch may cancel after the stop action is visible",
  );

  const touchMessage = page.locator('#message-actions-root [data-room-message-id="toolbar-user"]');
  await touchMessage.dispatchEvent("pointerover", { pointerType: "touch" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('#message-actions-root [data-room-message-id="toolbar-user"]')
        ?.getAttribute("data-action-surface-active") === "true",
  );
  assert.equal(
    await touchMessage.locator(".room-message-toolbar").getAttribute("data-placement"),
    "top",
    "touch/pen entry must enable measurement before showing a narrow-screen action toolbar",
  );
  await touchMessage.dispatchEvent("pointerout", { pointerType: "touch" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('#message-actions-root [data-room-message-id="toolbar-user"]')
        ?.getAttribute("data-action-surface-active") === "false",
  );
}

async function testResponsiveLayout(page) {
  const compactionColumns = await page
    .locator("#compaction")
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  assert.match(
    compactionColumns,
    /^16px\s+/,
    "compaction status must reserve the same leading icon column as tool rows",
  );

  const approvalLayout = await page.locator("#approval-shell").evaluate((shell) => {
    const input = shell.querySelector(".thread-approval-input");
    const inputRect = input.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      boxSizing: getComputedStyle(input).boxSizing,
      inputWidth: inputRect.width,
      shellWidth: shellRect.width,
    };
  });
  assert.equal(approvalLayout.boxSizing, "border-box");
  assert.ok(
    approvalLayout.inputWidth <= approvalLayout.shellWidth,
    `question input overflowed its card: ${approvalLayout.inputWidth} > ${approvalLayout.shellWidth}`,
  );

  const roomRunBlockRhythm = await page.locator("#room-run-aggregate-spacing").evaluate((root) => {
    const panel = root.querySelector(".og-disclosure-panel-inner");
    const blocks = [...panel.children].map((element) => element.getBoundingClientRect());
    return {
      gaps: blocks.slice(1).map((rect, index) => rect.top - blocks[index].bottom),
      marginTop: getComputedStyle(panel).marginTop,
    };
  });
  assert.deepEqual(
    roomRunBlockRhythm,
    { gaps: [16, 16, 0], marginTop: "16px" },
    "room activity groups must read as standalone status rows without separating continuous commentary",
  );

  const roomAggregateRhythm = await page
    .locator("#room-run-aggregate-spacing .thread-activity-embedded")
    .evaluate((activity) => {
      const summary = activity.querySelector(":scope > .thread-activity-toggle").getBoundingClientRect();
      const list = activity.querySelector(":scope > .thread-activity-list");
      const listRect = list.getBoundingClientRect();
      const entries = [...list.querySelectorAll(":scope > * > .og-disclosure > .og-disclosure-row")].map((element) =>
        element.getBoundingClientRect(),
      );
      return {
        summaryToList: Math.round(listRect.top - summary.bottom),
        entryGaps: entries.slice(1).map((rect, index) => Math.round(rect.top - entries[index].bottom)),
      };
    });
  assert.deepEqual(
    roomAggregateRhythm,
    { summaryToList: 4, entryGaps: [4, 4] },
    "expanded room activity summaries and their child operations must use one even internal rhythm",
  );

  const outerProcessLayout = await page.locator("#outer-process .og-disclosure-panel-inner").evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
    overflowY: getComputedStyle(panel).overflowY,
  }));
  assert.equal(
    outerProcessLayout.clientHeight,
    outerProcessLayout.scrollHeight,
    "the full process panel must expand to its content",
  );
  assert.notEqual(outerProcessLayout.overflowY, "auto", "the full process panel must not become the bounded scroller");

  const toolAggregateLayout = await page.locator("#tool-aggregate .thread-activity-list").evaluate((list) => ({
    clientHeight: list.clientHeight,
    scrollHeight: list.scrollHeight,
    overflowY: getComputedStyle(list).overflowY,
    overscrollBehaviorY: getComputedStyle(list).overscrollBehaviorY,
  }));
  assert.equal(toolAggregateLayout.overflowY, "auto");
  assert.equal(toolAggregateLayout.overscrollBehaviorY, "auto");
  assert.ok(
    toolAggregateLayout.clientHeight < toolAggregateLayout.scrollHeight,
    "the expanded tool aggregate should be the bounded scroller",
  );

  const toolAggregateList = page.locator("#tool-aggregate .thread-activity-list");
  await toolAggregateList.scrollIntoViewIfNeeded();
  await toolAggregateList.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  const pageScrollBeforeChaining = await page.evaluate(() => window.scrollY);
  await toolAggregateList.hover();
  await page.mouse.wheel(0, 320);
  await page.waitForFunction((before) => window.scrollY > before, pageScrollBeforeChaining);
  const pageScrollAfterChaining = await page.evaluate(() => window.scrollY);
  assert.ok(
    pageScrollAfterChaining > pageScrollBeforeChaining,
    "wheel input at the tool-list boundary should continue scrolling the page",
  );

  const singleToolClusterLayout = await page
    .locator("#single-tool-cluster .og-disclosure-panel-inner")
    .evaluate((panel) => ({
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      overflowY: getComputedStyle(panel).overflowY,
    }));
  assert.equal(singleToolClusterLayout.overflowY, "auto");
  assert.ok(
    singleToolClusterLayout.clientHeight < singleToolClusterLayout.scrollHeight,
    "an unwrapped single tool cluster should also be the bounded scroller",
  );
}

async function testPendingInteractionCancelAction(page) {
  const cancel = page.locator("#pending-cancel-root").getByRole("button", { name: "取消本次运行" });
  await cancel.click();
  assert.deepEqual(await page.evaluate(() => window.__pendingCancelAction), {
    approvalId: "approval-cancel-fixture",
    action: "cancel",
  });
}

async function testReactiveLanguage(page) {
  const processIndicator = page.locator("#language-root .og-disclosure--process .agent-state-indicator");
  await processIndicator.waitFor();
  assert.equal(await processIndicator.getAttribute("aria-label"), "正在处理");
  await page.evaluate(() => window.__setLanguagePreference("en"));
  await page.waitForFunction(
    () =>
      document
        .querySelector("#language-root .og-disclosure--process .agent-state-indicator")
        ?.getAttribute("aria-label") === "Processing",
  );
}

async function testResourceContextMenuLifecycle(page) {
  await page.evaluate(() => window.__setLanguagePreference("zh-CN"));
  const resourceLink = page.locator("#resource-menu-root [data-resource-reference='true']");
  const outsideTarget = page.locator("#resource-menu-root [data-resource-menu-outside='true']");
  await resourceLink.click({ button: "right" });
  const menu = page.locator(".thread-resource-menu");
  await menu.waitFor();
  assert.deepEqual(
    await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.textContent?.trim())),
    ["预览", "系统打开", "复制路径", "复制内容", "在 Finder 中显示"],
  );

  await menu.hover();
  assert.equal(await menu.count(), 1, "moving from the message into the portaled menu must not close it");
  await outsideTarget.hover();
  await page.waitForFunction(
    () => document.querySelector("#resource-menu-root article")?.getAttribute("data-pointer-inside") === "false",
  );
  assert.equal(await menu.count(), 1, "moving out of the resource menu must not close it without a click");
  assert.equal(
    await page.locator("#resource-menu-root article").getAttribute("data-pointer-inside"),
    "false",
    "the fixture must reproduce the message pointer-leave render",
  );

  await page.evaluate(() => window.__rerenderResourceMenuFixture());
  await page.waitForFunction(
    () => document.querySelector("#resource-menu-root article")?.getAttribute("data-render-count") === "1",
  );
  assert.equal(await menu.count(), 1, "an unrelated parent render must not close the resource menu");
  await menu.getByRole("menuitem", { name: "复制路径" }).click();
  assert.deepEqual(
    await page.evaluate(() => window.__resourceMenuAction),
    { action: "copy-path", renderCount: 1 },
    "a preserved menu must dispatch through the latest render callback",
  );
  assert.equal(await menu.count(), 0, "choosing an action should close the resource menu");

  await resourceLink.click({ button: "right" });
  await menu.waitFor();
  await outsideTarget.click();
  await menu.waitFor({ state: "detached" });
  assert.equal(await menu.count(), 0, "an outside click should close the resource menu");
  await resourceLink.click({ button: "right" });
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await menu.count(), 0, "Escape should close the resource menu");

  await resourceLink.click({ button: "right" });
  await menu.waitFor();
  await page.evaluate(() => window.__unmountResourceMenuFixture());
  await resourceLink.waitFor({ state: "detached" });
  await menu.waitFor({ state: "detached" });
  assert.equal(await menu.count(), 0, "unmounting the target resource should close its menu");
}

async function testHoverMessageActions(page) {
  await page.evaluate(() => window.__setLanguagePreference("zh-CN"));
  const root = page.locator("#message-actions-root");
  const runningAgentMessage = root.locator('[data-room-message-id="toolbar-running-agent"]');
  const agentMessage = root.locator('[data-room-message-id="toolbar-agent"]');
  const userMessage = root.locator('[data-room-message-id="toolbar-user"]');
  const agentToolbar = agentMessage.locator(".room-message-toolbar");
  const userToolbar = userMessage.locator(".room-message-toolbar");
  const streamOverflow = await root.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));

  assert.ok(
    streamOverflow.scrollWidth > streamOverflow.clientWidth,
    "the fixture must reproduce a hidden message toolbar extending the scrollable width",
  );
  assert.equal(
    streamOverflow.overflowX,
    "hidden",
    `Rooms must remain vertical-only even when hidden actions extend to ${streamOverflow.scrollWidth}px`,
  );
  assert.equal(await agentMessage.getAttribute("data-action-surface-active"), "false");
  assert.equal(await root.locator(".room-chat-date-separator").count(), 2);
  assert.equal(
    await runningAgentMessage.locator(".room-message-toolbar").count(),
    0,
    "a running Agent response must not enter the message action hover state",
  );
  assert.equal(await runningAgentMessage.getAttribute("tabindex"), null);
  assert.equal(await agentToolbar.evaluate((element) => getComputedStyle(element).opacity), "0");
  assert.equal(
    await agentMessage.locator(".room-chat-time").evaluate((element) => getComputedStyle(element).opacity),
    "0",
  );
  assert.equal(
    await userMessage
      .locator('.room-chat-status[data-kind="time"]')
      .evaluate((element) => getComputedStyle(element).opacity),
    "0",
  );

  const authorName = agentMessage.locator(".room-chat-author-name");
  const agentBubbleSpacing = await agentMessage.locator(".room-chat-bubble").evaluate((bubble) => {
    const paragraph = bubble.querySelector(".thread-md-p");
    if (!(paragraph instanceof HTMLElement)) return null;
    const bubbleRect = bubble.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    return {
      top: paragraphRect.top - bubbleRect.top,
      bottom: bubbleRect.bottom - paragraphRect.bottom,
      paddingTop: Number.parseFloat(getComputedStyle(bubble).paddingTop),
      paddingBottom: Number.parseFloat(getComputedStyle(bubble).paddingBottom),
    };
  });
  assert.ok(agentBubbleSpacing, "Agent text bubbles must use the shared Markdown paragraph class");
  assert.ok(
    Math.abs(agentBubbleSpacing.top - agentBubbleSpacing.paddingTop) < 0.5,
    "Agent paragraph text must start at the bubble's intended top padding",
  );
  assert.ok(
    Math.abs(agentBubbleSpacing.bottom - agentBubbleSpacing.paddingBottom) < 0.5,
    "Agent paragraph text must end at the bubble's intended bottom padding",
  );
  assert.equal(await authorName.count(), 1, "Agent author names must expose the shared mention interaction");
  assert.equal(await authorName.getAttribute("aria-label"), "提及 Toolbar Agent");
  const authorRestState = await authorName.evaluate((element) => {
    const name = element.querySelector(".room-chat-author-name-text");
    const mentionMark = element.querySelector(".room-chat-author-mention-mark");
    return {
      color: getComputedStyle(element).color,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      fontWeight: Number.parseInt(getComputedStyle(element).fontWeight, 10),
      nameLeft: name?.getBoundingClientRect().left ?? 0,
      mentionOpacity: mentionMark ? Number.parseFloat(getComputedStyle(mentionMark).opacity) : 0,
    };
  });
  await authorName.hover();
  await page.waitForFunction(() => {
    const mentionMark = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-chat-author-mention-mark',
    );
    return mentionMark instanceof HTMLElement && Number.parseFloat(getComputedStyle(mentionMark).opacity) > 0.99;
  });
  const authorHoverState = await authorName.evaluate((element) => {
    const name = element.querySelector(".room-chat-author-name-text");
    return {
      color: getComputedStyle(element).color,
      fontWeight: Number.parseInt(getComputedStyle(element).fontWeight, 10),
      nameLeft: name?.getBoundingClientRect().left ?? 0,
    };
  });
  assert.notEqual(authorHoverState.color, authorRestState.color);
  assert.ok(authorHoverState.fontWeight > authorRestState.fontWeight);
  const expectedMentionShift = authorRestState.fontSize * 1.125;
  assert.ok(
    Math.abs(authorHoverState.nameLeft - authorRestState.nameLeft - expectedMentionShift) < 0.8,
    `the @ reveal should shift the name by 1.125em (${expectedMentionShift}px)`,
  );
  assert.equal(await agentMessage.getAttribute("data-action-surface-active"), "true");
  await authorName.click();
  assert.deepEqual(
    await page.evaluate(() => ({
      mention: window.__roomMentionCount,
      reply: window.__roomReplyCount,
    })),
    { mention: 1, reply: 0 },
    "clicking an Agent author must only insert a mention, not start a reply",
  );
  await page.mouse.move(0, 0);
  assert.equal(
    await authorName.evaluate((element) => document.activeElement === element),
    true,
    "pointer leave must not blur a mouse-focused author control",
  );
  await page.waitForFunction(() => {
    const toolbar = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-message-toolbar',
    );
    return toolbar instanceof HTMLElement && getComputedStyle(toolbar).opacity === "0";
  });
  await page.keyboard.press("Tab");
  await authorName.focus();
  assert.equal(await authorName.evaluate((element) => element.matches(":focus-visible")), true);
  await page.waitForFunction(() => {
    const mentionMark = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-chat-author-mention-mark',
    );
    return mentionMark instanceof HTMLElement && Number.parseFloat(getComputedStyle(mentionMark).opacity) > 0.99;
  });
  await authorName.evaluate((element) => element.blur());

  await agentMessage.hover();
  await page.waitForFunction(() => {
    const toolbar = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-message-toolbar',
    );
    return toolbar instanceof HTMLElement && getComputedStyle(toolbar).opacity === "1";
  });
  assert.equal(await agentToolbar.evaluate((element) => getComputedStyle(element).opacity), "1");
  assert.equal(await agentToolbar.getAttribute("data-placement"), "right");
  assert.equal(await agentToolbar.locator("button").count(), 3);
  assert.deepEqual(
    await agentToolbar
      .locator("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["回复", "复制", "更多操作"],
  );
  assert.deepEqual(
    await agentToolbar
      .locator("button")
      .first()
      .evaluate((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
    { width: 28, height: 28 },
    "message toolbar buttons should use the shared 28px compact action size",
  );
  const replyIcon = agentToolbar.getByRole("button", { name: "回复" }).locator("svg");
  assert.equal(await replyIcon.getAttribute("viewBox"), "0 0 256 256");
  assert.equal(await replyIcon.locator("path").count(), 1);
  assert.match(
    await replyIcon.locator("path").getAttribute("d"),
    /^M128,24A104,104/,
    "Reply must use the outlined message bubble icon",
  );
  assert.equal(
    await agentMessage.locator(".room-chat-time").evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  assert.match(await agentMessage.locator(".room-chat-time").innerText(), /7月24日/);

  await userMessage.hover();
  await page.waitForFunction(() => {
    const toolbar = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-user"] .room-message-toolbar',
    );
    return toolbar instanceof HTMLElement && getComputedStyle(toolbar).opacity === "1";
  });
  assert.equal(await userToolbar.evaluate((element) => getComputedStyle(element).opacity), "1");
  assert.equal(await userToolbar.getAttribute("data-placement"), "top");
  assert.deepEqual(
    await userToolbar
      .locator("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["复制", "更多操作"],
  );
  assert.equal(
    await userMessage
      .locator('.room-chat-status[data-kind="time"]')
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );

  await userMessage.locator(".room-chat-bubble").click({ button: "right" });
  const userContextMenu = page.locator(".room-chat-message-context-menu");
  assert.deepEqual(
    await userContextMenu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.textContent?.trim())),
    ["复制", "删除"],
  );
  const contextMenuContract = await userContextMenu.evaluate((menu) => {
    const item = menu.querySelector('[role="menuitem"]');
    const menuStyle = getComputedStyle(menu);
    const itemStyle = item ? getComputedStyle(item) : null;
    return {
      borderWidth: menuStyle.borderTopWidth,
      borderRadius: menuStyle.borderRadius,
      padding: menuStyle.padding,
      minWidth: menuStyle.minWidth,
      itemMinHeight: itemStyle?.minHeight,
      itemFontSize: itemStyle?.fontSize,
      itemColumns: itemStyle?.gridTemplateColumns,
    };
  });
  assert.deepEqual(
    {
      borderWidth: contextMenuContract.borderWidth,
      borderRadius: contextMenuContract.borderRadius,
      padding: contextMenuContract.padding,
      minWidth: contextMenuContract.minWidth,
      itemMinHeight: contextMenuContract.itemMinHeight,
      itemFontSize: contextMenuContract.itemFontSize,
    },
    {
      borderWidth: "0px",
      borderRadius: "10px",
      padding: "4px",
      minWidth: "140px",
      itemMinHeight: "32px",
      itemFontSize: "14px",
    },
    "Rooms context actions must select the shared compact menu size",
  );
  assert.match(contextMenuContract.itemColumns ?? "", /^16px\s/);
  await page.keyboard.press("Escape");

  await agentMessage.hover();
  await agentToolbar.getByRole("button", { name: "回复" }).click();
  await agentMessage.hover();
  await agentToolbar.getByRole("button", { name: "更多操作" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="menuitem"]')].filter(
        (item) => item instanceof HTMLElement && item.offsetParent !== null,
      ).length === 2,
  );
  const messageActionItems = page.locator('[role="menuitem"]:visible');
  assert.deepEqual(
    await messageActionItems.evaluateAll((items) => items.map((item) => item.textContent?.trim())),
    ["导出错误包", "删除"],
    "the overflow menu must expose both run diagnostics export and deletion",
  );
  await page.mouse.move(0, 0);
  assert.equal(await agentMessage.getAttribute("data-overflow-menu-open"), "true");
  assert.equal(
    await agentToolbar.evaluate((element) => getComputedStyle(element).opacity),
    "1",
    "the toolbar trigger must remain visible while its portalled overflow menu is open",
  );
  await messageActionItems.filter({ hasText: "导出错误包" }).click();
  const diagnosticConfirm = page.getByRole("dialog");
  await diagnosticConfirm.getByRole("heading", { name: "导出这份错误包？" }).waitFor();
  assert.match(
    await diagnosticConfirm.textContent(),
    /敏感业务内容.*工作区外文件/s,
    "run diagnostics export must warn about sensitive and out-of-workspace evidence before download",
  );
  assert.equal(await page.evaluate(() => window.__diagnosticFetchCount), 0);
  await diagnosticConfirm.getByRole("button", { name: "导出错误包" }).click();
  await page.waitForFunction(() => window.__diagnosticFetchCount === 1);
  await agentMessage.hover();
  await agentToolbar.getByRole("button", { name: "更多操作" }).click();
  await messageActionItems.filter({ hasText: "删除" }).click();
  assert.deepEqual(
    await page.evaluate(() => ({
      mention: window.__roomMentionCount,
      reply: window.__roomReplyCount,
      delete: window.__roomDeleteCount,
    })),
    { mention: 1, reply: 1, delete: 1 },
    "the Reply action must remain separate from the author mention interaction",
  );
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => {
    const toolbar = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-message-toolbar',
    );
    return toolbar instanceof HTMLElement && getComputedStyle(toolbar).opacity === "0";
  });
  assert.equal(await agentMessage.getAttribute("data-action-surface-active"), "false");

  await page.keyboard.press("Tab");
  await agentMessage.focus();
  assert.equal(await agentMessage.evaluate((element) => element.matches(":focus-visible")), true);
  await page.waitForFunction(() => {
    const toolbar = document.querySelector(
      '#message-actions-root [data-room-message-id="toolbar-agent"] .room-message-toolbar',
    );
    return toolbar instanceof HTMLElement && getComputedStyle(toolbar).opacity === "1";
  });
  assert.equal(await agentToolbar.evaluate((element) => getComputedStyle(element).opacity), "1");
  const keyboardReplyAction = agentToolbar.locator('.room-message-toolbar-button[aria-label="回复"]');
  await keyboardReplyAction.evaluate((element) => element.focus());
  assert.equal(await keyboardReplyAction.evaluate((element) => document.activeElement === element), true);
  assert.equal(await agentToolbar.evaluate((element) => getComputedStyle(element).opacity), "1");
}

function leadingOrbOpacity(page, fixtureId) {
  return page
    .locator(`#${fixtureId} .room-run-leading-orb, #${fixtureId} .room-run-agent-orb`)
    .first()
    .evaluate((element) => getComputedStyle(element).opacity);
}

function leadingStopOpacity(page, fixtureId) {
  return page.locator(`#${fixtureId} .room-run-leading-stop`).evaluate((element) => getComputedStyle(element).opacity);
}

function entrySource() {
  const messageListPath = resolve(projectRoot, "web/src/components/chat/message-list.tsx");
  const roomMessageStreamPath = resolve(projectRoot, "web/src/components/rooms/room-message-stream.tsx");
  const messageMarkdownPath = resolve(projectRoot, "web/src/components/chat/message-markdown.tsx");
  const i18nPath = resolve(projectRoot, "web/src/i18n.ts");
  const disclosureCssPath = resolve(projectRoot, "web/src/components/chat/disclosure.css");
  const threadCssPath = resolve(projectRoot, "web/src/components/chat/thread.css");
  const roomCssPath = resolve(projectRoot, "web/src/components/rooms/room-message-stream.css");
  const roomWorkspaceCssPath = resolve(projectRoot, "web/src/components/rooms/room-workspace.css");
  const mountedAppWorkbenchCssPath = resolve(projectRoot, "web/src/components/apps/mounted-app-workbench.css");
  const tokensCssPath = resolve(projectRoot, "web/src/styles/tokens.css");
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageList } from ${JSON.stringify(messageListPath)};
    import { RoomMessageStream } from ${JSON.stringify(roomMessageStreamPath)};
    import { ConfirmProvider } from ${JSON.stringify(resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx"))};
    import { ThreadTextBlock } from ${JSON.stringify(messageMarkdownPath)};
    import { Disclosure } from ${JSON.stringify(resolve(projectRoot, "web/src/components/chat/disclosure.tsx"))};
    import { setLanguagePreference } from ${JSON.stringify(i18nPath)};
    import ${JSON.stringify(tokensCssPath)};
    import ${JSON.stringify(disclosureCssPath)};
    import ${JSON.stringify(threadCssPath)};
    import ${JSON.stringify(roomCssPath)};
    import ${JSON.stringify(roomWorkspaceCssPath)};
    import ${JSON.stringify(mountedAppWorkbenchCssPath)};

    setLanguagePreference("zh-CN");
    window.__setLanguagePreference = setLanguagePreference;
    window.__diagnosticFetchCount = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/diagnostics/run-bundle")) {
        window.__diagnosticFetchCount += 1;
        return new Response(new Blob(["diagnostic zip"]), {
          status: 200,
          headers: {
            "content-disposition": "attachment; filename=OpenGrove-run-test.zip",
            "x-opengrove-size": "14",
          },
        });
      }
      return originalFetch(input, init);
    };
    const RESOURCE_MENU_MARKDOWN = "[导演产物](</tmp/opengrove/apps/short-drama-studio/workspace/outputs/director.md>)";
    const RESOURCE_MENU_CONTEXT = {
      origin: "mounted-app",
      appId: "short-drama-studio",
      workspaceRoot: "/tmp/opengrove/apps/short-drama-studio/workspace",
    };
    function ResourceMenuFixture() {
      const [renderCount, setRenderCount] = React.useState(0);
      const [pointerInside, setPointerInside] = React.useState(false);
      const [resourceMounted, setResourceMounted] = React.useState(true);
      React.useEffect(() => {
        window.__rerenderResourceMenuFixture = () => setRenderCount((current) => current + 1);
        window.__unmountResourceMenuFixture = () => setResourceMounted(false);
      }, []);
      return (
        <>
          <article
            data-render-count={renderCount}
            data-pointer-inside={pointerInside ? "true" : "false"}
            onPointerEnter={() => setPointerInside(true)}
            onPointerLeave={() => setPointerInside(false)}
          >
            {resourceMounted ? (
              <ThreadTextBlock
                text={RESOURCE_MENU_MARKDOWN}
                resourceContext={RESOURCE_MENU_CONTEXT}
                onOpenResource={(_resource, action) => {
                  window.__resourceMenuAction = { action, renderCount };
                }}
              />
            ) : null}
          </article>
          <button className="resource-menu-outside-target" type="button" data-resource-menu-outside="true">outside resource menu</button>
        </>
      );
    }
    createRoot(document.getElementById("resource-menu-root")).render(<ResourceMenuFixture />);
    window.__disclosureFixtureMounts = { short: 0, long: 0 };
    window.__defaultOpenDisclosureHeights = [];
    function DisclosureMotionFixture({ kind, height }) {
      React.useEffect(() => {
        window.__disclosureFixtureMounts[kind] += 1;
      }, [kind]);
      return <div className="og-disclosure-motion-fixture" style={{ height }}>{kind}</div>;
    }
    createRoot(document.getElementById("short-disclosure-root")).render(
      <Disclosure summary="短内容">
        <DisclosureMotionFixture kind="short" height={120} />
      </Disclosure>,
    );
    createRoot(document.getElementById("long-disclosure-root")).render(
      <Disclosure summary="长内容">
        <DisclosureMotionFixture kind="long" height={720} />
      </Disclosure>,
    );
    createRoot(document.getElementById("default-open-disclosure-root")).render(
      <Disclosure summary="默认展开" defaultOpen>
        <div className="og-disclosure-default-open-fixture" style={{ height: 120 }}>default</div>
      </Disclosure>,
    );
    let defaultOpenSampleCount = 0;
    function sampleDefaultOpenDisclosure() {
      const panel = document.querySelector(
        "#default-open-disclosure-root .og-disclosure-panel-motion",
      );
      if (panel instanceof HTMLElement) {
        window.__defaultOpenDisclosureHeights.push(panel.getBoundingClientRect().height);
        defaultOpenSampleCount += 1;
      }
      if (defaultOpenSampleCount < 8) requestAnimationFrame(sampleDefaultOpenDisclosure);
    }
    requestAnimationFrame(sampleDefaultOpenDisclosure);
    createRoot(document.getElementById("language-root")).render(
      <MessageList
        messages={[{
          id: "language-process",
          role: "assistant",
          text: "",
          pending: true,
          createdAt: "2026-07-24T00:00:00.000Z",
          parts: [{
            id: "language-status",
            type: "note",
            tone: "status",
            text: "internal status",
          }],
        }]}
        onResolveApproval={() => {}}
        onResolveQuestion={() => {}}
      />,
    );
    window.__pendingCancelAction = null;
    createRoot(document.getElementById("pending-cancel-root")).render(
      <MessageList
        messages={[{
          id: "pending-cancel-message",
          role: "assistant",
          text: "",
          pending: true,
          createdAt: "2026-09-01T00:00:00.000Z",
          parts: [{
            id: "pending-cancel-approval-part",
            type: "tool",
            phase: "approval",
            approvalId: "approval-cancel-fixture",
            approvalStatus: "pending",
            status: "requires-action",
            title: "Native approval",
            toolId: "native.tool",
            input: { command: "write workspace output" },
          }],
        }]}
        onResolveApproval={(approvalId, action) => {
          window.__pendingCancelAction = { approvalId, action };
        }}
        onResolveQuestion={() => {}}
      />,
    );
    window.__touchCancelCount = 0;
    window.__roomReplyCount = 0;
    window.__roomMentionCount = 0;
    window.__roomDeleteCount = 0;
    createRoot(document.getElementById("touch-runtime")).render(
      <ConfirmProvider><RoomMessageStream
        messages={[{
          id: "touch-running-message",
          senderId: "touch-agent",
          senderName: "Touch Agent",
          senderType: "agent",
          text: "",
          targetIds: [],
          status: "running",
          createdAt: "2026-07-24T00:00:00.000Z",
          runId: "touch-run",
          parts: [],
        }]}
        members={[{
          id: "touch-agent",
          name: "Touch Agent",
          role: "Agent",
          status: "running",
          color: "#7c3aed",
        }]}
        runtimeEventsByRunId={new Map()}
        onResolveApproval={() => {}}
        onResolveQuestion={() => {}}
        onInsertPrompt={() => {}}
        onCancelRun={() => {
          window.__touchCancelCount += 1;
        }}
      /></ConfirmProvider>,
    );
    createRoot(document.getElementById("message-actions-root")).render(
      <ConfirmProvider><RoomMessageStream
        roomId="toolbar-room"
        messages={[
          {
            id: "toolbar-system",
            senderId: "system",
            senderName: "System",
            senderType: "system",
            text: "前一天",
            targetIds: [],
            status: "done",
            createdAt: "2026-07-22T23:59:00.000Z",
          },
          {
            id: "toolbar-running-agent",
            senderId: "toolbar-agent-member",
            senderName: "Toolbar Agent",
            senderType: "agent",
            text: "正在输入",
            targetIds: [],
            status: "running",
            createdAt: "2026-07-24T00:00:00.000Z",
            parts: [{ id: "toolbar-running-agent-text", type: "text", text: "正在输入" }],
          },
          {
            id: "toolbar-agent",
            senderId: "toolbar-agent-member",
            senderName: "Toolbar Agent",
            senderType: "agent",
            text: "短消息",
            targetIds: [],
            status: "done",
            runId: "toolbar-agent-run",
            createdAt: "2026-07-24T00:00:30.000Z",
            parts: [{ id: "toolbar-agent-text", type: "text", text: "短消息" }],
          },
          {
            id: "toolbar-overflow-agent",
            senderId: "toolbar-agent-member",
            senderName: "Toolbar Agent",
            senderType: "agent",
            text: "这是一条足够长的消息，用于复现隐藏操作工具条仍然被浏览器计入消息流横向滚动范围的问题。工具条在没有悬停时不可见，但绝对定位盒仍然会伸出长气泡右侧。",
            targetIds: [],
            status: "done",
            createdAt: "2026-07-24T00:00:45.000Z",
            parts: [{
              id: "toolbar-overflow-agent-text",
              type: "text",
              text: "这是一条足够长的消息，用于复现隐藏操作工具条仍然被浏览器计入消息流横向滚动范围的问题。工具条在没有悬停时不可见，但绝对定位盒仍然会伸出长气泡右侧。",
            }],
          },
          {
            id: "toolbar-user",
            senderId: "toolbar-user-member",
            senderName: "Toolbar User",
            senderType: "user",
            text: "这是一条靠右显示、用于验证工具栏自动翻到消息上方的用户消息。",
            targetIds: ["toolbar-agent-member"],
            status: "done",
            createdAt: "2026-07-24T00:01:00.000Z",
            parts: [{ id: "toolbar-user-text", type: "text", text: "这是一条靠右显示、用于验证工具栏自动翻到消息上方的用户消息。" }],
          },
        ]}
        members={[
          {
            id: "toolbar-agent-member",
            name: "Toolbar Agent",
            role: "Agent",
            status: "idle",
            color: "#7c3aed",
          },
          {
            id: "toolbar-user-member",
            name: "Toolbar User",
            role: "User",
            status: "idle",
            color: "#64748b",
          },
        ]}
        runtimeEventsByRunId={new Map()}
        onResolveApproval={() => {}}
        onResolveQuestion={() => {}}
        onInsertPrompt={() => {}}
        onReplyMessage={() => {
          window.__roomReplyCount += 1;
        }}
        onMentionMessageAuthor={() => {
          window.__roomMentionCount += 1;
        }}
        onDeleteMessage={() => {
          window.__roomDeleteCount += 1;
        }}
      /></ConfirmProvider>,
    );
  `;
}

function fixtureHtml() {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <link rel="stylesheet" href="./entry.css">
        <style>
          body {
            --dur-normal: 180ms;
            --dur-stagger: 28ms;
            --ease-entrance: cubic-bezier(0.22, 1, 0.36, 1);
            margin: 24px;
            font-family: sans-serif;
          }
          .fixtures { display: grid; gap: 18px; width: 420px; }
          .resource-menu-outside-target { position: fixed; top: 8px; right: 32px; }
          #approval-shell { width: 240px; }
          #message-actions-root {
            --room-stream-author-fg: gray;
            --room-stream-author-strong-fg: black;
            --fw-normal: 400;
            --fw-medium: 500;
            width: 420px;
            height: 360px;
          }
          .tall-fixture { height: 720px; }
          .scroll-tail { height: 900px; }
        </style>
      </head>
      <body>
        <div class="fixtures">
          ${runFixture("no-stop", "none")}
          ${runFixture("disabled-stop", "disabled")}
          ${runFixture("enabled-stop", "enabled")}
          <div id="compaction" class="thread-compaction-divider"><span>上下文已自动压缩</span></div>
          <div id="approval-shell"><textarea class="thread-approval-input">A long answer that must stay inside its interaction card.</textarea></div>
          <div id="room-run-aggregate-spacing" class="og-disclosure og-disclosure--room-run" data-open="true">
            <div class="og-disclosure-panel">
              <div class="og-disclosure-panel-motion">
                <div class="og-disclosure-panel-inner">
                  <div class="room-run-group">
                    <div class="room-run-commentary">
                      <div class="thread-text-block"><p class="thread-md-p">过程评注</p></div>
                    </div>
                  </div>
                  <div class="room-run-group room-run-group--activity">
                    <div class="room-chat-tools">
                      <div class="thread-activity thread-activity-embedded" data-open="true">
                        <button class="thread-activity-toggle" type="button">已探索 2 个文件 已运行 2 条命令</button>
                        <div class="thread-activity-list">
                          <div>
                            <div class="og-disclosure og-disclosure--exploration" data-open="false">
                              <div class="og-disclosure-row"><button class="og-disclosure-toggle">读取了 1 个文件</button></div>
                              <div class="og-disclosure-panel"><div class="og-disclosure-panel-motion"><div class="og-disclosure-panel-inner"></div></div></div>
                            </div>
                          </div>
                          <div>
                            <div class="og-disclosure og-disclosure--exploration" data-open="false">
                              <div class="og-disclosure-row"><button class="og-disclosure-toggle">搜索了 1 次</button></div>
                              <div class="og-disclosure-panel"><div class="og-disclosure-panel-motion"><div class="og-disclosure-panel-inner"></div></div></div>
                            </div>
                          </div>
                          <div>
                            <div class="og-disclosure og-disclosure--exploration" data-open="false">
                              <div class="og-disclosure-row"><button class="og-disclosure-toggle">执行了 2 条命令</button></div>
                              <div class="og-disclosure-panel"><div class="og-disclosure-panel-motion"><div class="og-disclosure-panel-inner"></div></div></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="room-run-group">
                    <div class="room-run-commentary">
                      <div class="thread-text-block"><p class="thread-md-p">下一段过程评注</p></div>
                    </div>
                  </div>
                  <div class="room-run-group">
                    <div class="room-run-commentary">
                      <div class="thread-text-block"><p class="thread-md-p">连续过程评注</p></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div id="outer-process" class="og-disclosure og-disclosure--room-run" data-open="true">
            <div class="og-disclosure-row"><button class="og-disclosure-toggle">完整过程</button></div>
            <div class="og-disclosure-panel"><div class="og-disclosure-panel-motion"><div class="og-disclosure-panel-inner"><div class="tall-fixture"></div></div></div></div>
          </div>
          <div id="tool-aggregate" class="og-disclosure--room-run">
            <div class="thread-activity thread-activity-embedded" data-open="true">
              <div class="thread-activity-list"><div class="tall-fixture"></div></div>
            </div>
          </div>
          <div id="single-tool-cluster" class="og-disclosure--room-run">
            <div class="og-disclosure og-disclosure--exploration" data-open="true">
              <div class="og-disclosure-row"><button class="og-disclosure-toggle">执行了 12 条命令</button></div>
              <div class="og-disclosure-panel"><div class="og-disclosure-panel-motion"><div class="og-disclosure-panel-inner"><div class="tall-fixture"></div></div></div></div>
            </div>
          </div>
          <div id="language-root"></div>
          <div id="pending-cancel-root"></div>
          <div id="short-disclosure-root"></div>
          <div id="long-disclosure-root"></div>
          <div id="default-open-disclosure-root"></div>
          <div class="mounted-app-room-chat">
            <div id="message-actions-root" class="room-message-stream"></div>
          </div>
          <div id="touch-runtime"></div>
          <div class="scroll-tail"></div>
          <div id="resource-menu-root"></div>
        </div>
        <script src="./entry.js"></script>
      </body>
    </html>`;
}

function runFixture(id, stopState) {
  const leading =
    stopState === "none"
      ? '<span class="room-run-leading-slot"><span class="room-run-agent-orb">orb</span></span>'
      : `<button class="room-run-leading-slot room-run-leading-control" ${stopState === "disabled" ? "disabled" : ""}>
        <span class="room-run-leading-orb"><span class="room-run-agent-orb">orb</span></span>
        <span class="room-run-leading-stop">stop</span>
      </button>`;
  return `
    <div id="${id}" class="og-disclosure og-disclosure--room-run" data-active="true">
      <div class="og-disclosure-row">
        ${leading}
        <button class="og-disclosure-toggle" type="button">
          <span class="og-disclosure-summary">
            <span>正在处理</span>
          </span>
        </button>
      </div>
    </div>`;
}
