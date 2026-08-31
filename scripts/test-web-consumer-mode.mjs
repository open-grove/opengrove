import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-consumer-mode-"));
const entryPath = join(tempDir, "consumer-mode-entry.tsx");
const bundlePath = join(tempDir, "consumer-mode-entry.cjs");
const policyPath = join(projectRoot, "web/src/components/sidebar/settings-mode-policy.ts");
const desktopPanelPath = join(projectRoot, "web/src/components/sidebar/settings-desktop-panel.tsx");
const updatePanelPath = join(projectRoot, "web/src/components/sidebar/settings-update-panel.tsx");
const confirmDialogPath = join(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
const appNavigationPath = join(projectRoot, "web/src/components/sidebar/app-navigation.tsx");
const navigationModePolicyPath = join(projectRoot, "web/src/components/sidebar/navigation-mode-policy.ts");
const settingsSectionsPath = join(projectRoot, "web/src/components/sidebar/settings-sections.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { isSettingsSectionVisible, visibleKernelOptions } from ${JSON.stringify(policyPath)};
    import { SettingsDesktopPanel } from ${JSON.stringify(desktopPanelPath)};
    import { SettingsUpdatePanel } from ${JSON.stringify(updatePanelPath)};
    import { ConfirmProvider } from ${JSON.stringify(confirmDialogPath)};
    import { MobileNav } from ${JSON.stringify(appNavigationPath)};
    import { developerOnlyRailSection, developerOnlyView, nativeRailSectionVisible } from ${JSON.stringify(navigationModePolicyPath)};
    import { SETTINGS_SECTIONS } from ${JSON.stringify(settingsSectionsPath)};

    const kernels = [
      { id: "codex", label: "Codex", available: true },
      { id: "claude-code", label: "Claude Agent", available: true },
      { id: "hermes", label: "Hermes", available: true },
    ];

    assert.deepEqual(
      visibleKernelOptions(kernels, false).map((kernel) => kernel.id),
      ["codex", "claude-code", "hermes"],
      "consumer mode must keep the complete kernel inventory visible",
    );
    assert.deepEqual(
      visibleKernelOptions(kernels, true).map((kernel) => kernel.id),
      ["codex", "claude-code", "hermes"],
      "developer mode must keep the complete kernel inventory",
    );
    assert.equal(isSettingsSectionVisible("desktop", false), true, "Desktop must remain visible in consumer mode");
    assert.equal(isSettingsSectionVisible("updates", false), true, "Software Update must remain visible in consumer mode");
    assert.equal(isSettingsSectionVisible("kernels", false), true, "Kernel settings must remain visible in consumer mode");
    assert.equal(isSettingsSectionVisible("providers", false), false, "Advanced provider settings stay developer-only");
    assert.deepEqual(
      SETTINGS_SECTIONS.slice(0, 5).map((section) => section.id),
      ["mode", "kernels", "appearance", "desktop", "updates"],
      "Software Update must remain in the standard settings group",
    );

    // SettingsDesktopPanel calls useConfirm(), so mirror the provider from
    // main.tsx (ToastProvider > ConfirmProvider > App); the panel does not use
    // toast, so ConfirmProvider alone is sufficient here.
    // The assertions below expect the zh-CN copy, but under Node the i18n
    // "system" fallback reads navigator.language ("en-US"); pin it to zh-CN
    // before rendering (translate() resolves the language per call).
    Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });
    globalThis.__OPENGROVE_PACKAGE_VERSION__ = "0.6.1";
    const desktopDownloadMarkup = renderToStaticMarkup(
      <ConfirmProvider>
        <SettingsDesktopPanel />
      </ConfirmProvider>,
    );
    assert.match(
      desktopDownloadMarkup,
      /Export complete system evidence from the local service for trusted troubleshooting/,
      "Web settings must describe the diagnostics action they expose",
    );
    assert.match(
      desktopDownloadMarkup,
      /<button(?=[^>]*type="button")(?![^>]*disabled)[^>]*>Export diagnostics bundle/,
      "Web settings must expose an actionable diagnostics export",
    );
    assert.doesNotMatch(desktopDownloadMarkup, /Download latest for this machine|Latest release: 10008/, "Web settings must not advertise a removed installer action");
    assert.match(desktopDownloadMarkup, />Storage</, "Web settings must expose the storage detail entry");

    const updateMarkup = renderToStaticMarkup(
      <ConfirmProvider>
        <SettingsUpdatePanel
          clientUpdate={{
            ok: true,
            current: 10007,
            latest: {
              version: 10008,
              downloadUrl: "https://downloads.example.test/opengrove-current-machine",
              releaseNotes: "WW release notes",
            },
          }}
        />
      </ConfirmProvider>,
    );
    assert.match(updateMarkup, /WW release notes/, "Software Update must render release notes supplied by WW");
    assert.match(updateMarkup, /Release 10008/, "Software Update must identify the available release");
    assert.match(updateMarkup, />0\.6\.1</, "Software Update must show the installed semantic product version");
    assert.doesNotMatch(updateMarkup, /Release 10007/, "Software Update must not present the internal release number as the installed version");

    assert.equal(nativeRailSectionVisible("rooms", false), true, "consumer mode must keep the employee tab visible");
    assert.equal(developerOnlyRailSection("rooms"), false, "consumer mode must allow opening the employee tab");
    assert.equal(developerOnlyView("rooms"), false, "consumer mode must keep the employee room view open");
    assert.equal(developerOnlyView("contacts"), false, "consumer mode must keep the employee directory view open");
    assert.equal(nativeRailSectionVisible("chat", false), false, "consumer mode must keep the kernel console hidden");
    assert.equal(nativeRailSectionVisible("chat", false, true), true, "the direct kernel chat toggle must reveal the kernel conversation independently");
    assert.equal(nativeRailSectionVisible("extensions", false), false, "consumer mode must keep extension management hidden");

    const mobileNavMarkup = renderToStaticMarkup(
      <MobileNav
        activeView="app"
        activeMountedAppId="review-desk"
        mountedApps={[{
          id: "app-review-desk",
          name: "review-desk",
          title: "评审台",
          kind: "app",
          source: {},
          deployments: [],
          metadata: { icon: "library" },
        }]}
        onSelect={() => {}}
        onSelectMountedApp={() => {}}
      />,
    );
    assert.match(mobileNavMarkup, /评审台/, "mobile navigation must expose installed Apps");
    assert.match(
      mobileNavMarkup,
      /class="mobile-nav-item active"/,
      "the selected installed App must be active in mobile navigation",
    );

    export function run() {}
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  require(bundlePath).run();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-consumer-mode ok");
