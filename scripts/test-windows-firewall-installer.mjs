import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml");
const electronBuilderPackage = require("electron-builder/package.json");
const appBuilderPackage = require("app-builder-lib/package.json");
assert.equal(
  appBuilderPackage.version,
  electronBuilderPackage.version,
  "app-builder-lib must be pinned to the installed electron-builder version",
);

// electron-builder does not expose its effective bundled-language table as a
// public API. Keep this explicit internal coupling so a package layout change
// fails with an actionable release-check error instead of MODULE_NOT_FOUND.
let builderLanguages;
try {
  builderLanguages = require("app-builder-lib/out/util/langs.js");
} catch (error) {
  throw new Error(
    "Unable to load electron-builder's bundled language table; verify the pinned app-builder-lib version and its out/util/langs.js layout.",
    { cause: error },
  );
}
const { bundledLanguages, lcid } = builderLanguages;
const builderConfigSource = readFileSync(resolve(root, "electron-builder.yml"), "utf8");
const builderConfig = loadYaml(builderConfigSource);
const installer = readFileSync(resolve(root, "build", "installer.nsh"), "utf8");

assert.equal(builderConfig.nsis.include, "build/installer.nsh");
assert.equal(
  builderConfig.nsis.installerLanguages,
  undefined,
  "the installer must retain electron-builder's complete bundled language set",
);
assert.match(installer, /!macro customInstall\b/);
assert.match(installer, /!macro customUnInstall\b/);
assert.match(installer, /!macro customCheckAppRunning\b/);
assert.match(installer, /!macro customHeader\b/);
assert.match(
  installer,
  /!macro customInit\b[\s\S]*?\$\{If\} \$\{isUpdated\}[\s\S]*?SetSilent silent[\s\S]*?!macroend/,
  "legacy --updated launches must enter silent mode after Host confirmation",
);
assert.equal(
  (installer.match(/SetSilent silent/g) ?? []).length,
  1,
  "manual installer launches must remain interactive",
);
assert.match(
  installer,
  /ReadEnvStr \$R8 "USERNAME"[\s\S]*?ReadEnvStr \$R7 "USERDOMAIN"[\s\S]*?StrCpy \$R8 "\$R7\\\$R8"/,
  "interactive elevated cleanup must retain the domain-qualified current user",
);
const processFinder = installer.slice(
  installer.indexOf("!macro opengrove_find_running_process"),
  installer.indexOf("!macro customCheckAppRunning"),
);
assert.doesNotMatch(
  processFinder,
  /USERNAME eq/,
  "same-token process detection must not depend on Windows username formatting",
);
assert.match(installer, /OPENGROVE_DESKTOP_RELEASE_GATE/);
assert.match(installer, /OPENGROVE_DESKTOP_RELEASE_GATE_LOG/);
assert.match(installer, /opengrove-installer-gate\.log/);
const customHeaderStart = installer.indexOf("!macro customHeader");
const customHeaderEnd = installer.indexOf("!macroend", customHeaderStart);
const customHeader = installer.slice(customHeaderStart, customHeaderEnd);
const expectedEnglishFallbackIds = bundledLanguages
  .filter((language) => language !== "zh_CN")
  .map((language) => lcid[language]);
const actualEnglishFallbackIds = [...customHeader.matchAll(/!insertmacro opengrove_english_lang_strings (\d+)/g)].map(
  (match) => Number(match[1]),
);
assert.deepEqual(
  actualEnglishFallbackIds,
  expectedEnglishFallbackIds,
  "every bundled locale except Simplified Chinese must receive the English custom-message fallback",
);
for (const messageId of [
  "opengroveStoppingProcesses",
  "opengroveCloseFailed",
  "opengroveFirewallInstallFailed",
  "opengroveFirewallUninstallFailed",
]) {
  assert.ok(customHeader.includes(`LangString ${messageId} ${lcid.zh_CN}`));
  assert.match(installer, new RegExp(`\\$\\(${messageId}\\)`));
}
for (const line of installer.split(/\r?\n/)) {
  if (/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(line)) {
    assert.match(line, /^\s*LangString\b/, "CJK text and punctuation must only appear in localized strings");
  }
}
assert.match(
  installer,
  /tasklist\.exe[\s\S]*?\/FI\s+"IMAGENAME eq \$\{APP_EXECUTABLE_FILENAME\}"[\s\S]*?\/FO CSV \/NH/,
  "installer process detection must use an exact executable-name filter",
);
assert.match(
  installer,
  /findstr\.exe[\s\S]*?\/B \/I/,
  "installer process detection must anchor the exact CSV executable name",
);
assert.match(
  installer,
  /taskkill\.exe[\s\S]*?\/IM "\$\{APP_EXECUTABLE_FILENAME\}"/,
  "installer must close every exact-name OpenGrove process",
);
assert.match(
  installer,
  /taskkill\.exe[\s\S]*?\/F \/IM "\$\{APP_EXECUTABLE_FILENAME\}"/,
  "installer must force same-privilege OpenGrove processes that ignore graceful shutdown",
);
assert.match(
  installer,
  /ExecShellWait\s+"runas"\s+"\$SYSDIR\\taskkill\.exe"[\s\S]*?\/F \/IM/,
  "installer must elevate exact-image cleanup instead of delegating it to the user",
);
const appCleanup = installer.slice(
  installer.indexOf("!macro customCheckAppRunning"),
  installer.indexOf("!macro customInstall"),
);
assert.doesNotMatch(
  appCleanup,
  /taskkill\.exe[^\r\n`]*\/T/,
  "installer cleanup must not terminate the updater installer through its OpenGrove parent",
);
assert.match(
  installer,
  /ExecShellWait\s+"runas"[\s\S]*?USERNAME eq \$R8/,
  "interactive elevated cleanup must remain scoped to the current domain-qualified user",
);
assert.match(
  installer,
  /opengrove_find_running_process[\s\S]*?opengrove_close_failed/,
  "installer must verify cleanup before continuing",
);
assert.match(
  installer,
  /\$\{If\} \$\{Silent\}[\s\S]*?Goto opengrove_close_failed[\s\S]*?ExecShellWait\s+"runas"\s+"\$SYSDIR\\taskkill\.exe"/,
  "a silent updater must fail closed before the process-cleanup UAC path",
);
assert.match(
  installer,
  /opengrove_close_failed:[\s\S]*?\$\{IfNot\} \$\{Silent\}[\s\S]*?MessageBox/,
  "silent process-cleanup failures must not open a blocking message box",
);
assert.doesNotMatch(
  installer,
  /请手动关闭|click Retry|MB_RETRYCANCEL/,
  "installer must not ask users to find and close a headless Bridge process",
);
assert.match(installer, /ExecShellWait\s+"runas"/);
assert.match(
  installer,
  /IsUserAnAdmin[\s\S]*?nsExec::Exec[\s\S]*?advfirewall firewall add rule/,
  "an already elevated installer must apply the firewall rule without opening another UAC prompt",
);
assert.match(
  installer,
  /\$\{If\} \$\{Silent\}[\s\S]*?Goto opengrove_firewall_install_failed/,
  "an unelevated silent install must fail instead of waiting on a hidden UAC prompt",
);
assert.match(
  installer,
  /opengrove_firewall_install_failed:[\s\S]*?\$\{IfNot\} \$\{Silent\}[\s\S]*?MessageBox/,
  "silent install failures must not open a blocking message box",
);
assert.match(installer, /\$\{isUpdated\}/);
assert.match(installer, /advfirewall firewall add rule/);
assert.match(installer, /protocol=TCP/);
assert.match(installer, /localip=127\.0\.0\.1/);
assert.match(installer, /remoteip=127\.0\.0\.1/);
assert.match(installer, /edge=no/);
assert.match(installer, /program="\$R0"/);
assert.match(installer, /advfirewall firewall delete rule/);
assert.match(installer, /WriteRegStr SHELL_CONTEXT/);
assert.match(
  installer,
  /delete rule name="\$R3" program="\$R2"/,
  "changed install paths must remove the previously registered rule",
);
assert.match(
  installer,
  /delete rule name="\$R1" program="\$R0"/,
  "install must replace its target rule instead of creating duplicates",
);
assert.match(
  installer,
  /show rule name="\$R1"[\s\S]*?\|\| echo ok>/,
  "uninstall must verify the managed rule is absent before reporting success",
);
assert.doesNotMatch(installer, /0\.0\.0\.0|LocalSubnet|remoteip=(?:any|localsubnet)/i);

console.log("windows firewall installer contract: ok");
