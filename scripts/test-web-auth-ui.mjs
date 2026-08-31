import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-auth-ui-"));
const entryPath = join(tempDir, "auth-ui-entry.tsx");
const bundlePath = join(tempDir, "auth-ui-entry.js");
const htmlPath = join(tempDir, "index.html");
const tokensPath = resolve(projectRoot, "web/src/styles/tokens.css");

try {
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
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      '<html data-resolved-theme="light">',
      `<head><meta charset="utf-8"><title>OpenGrove auth UI harness</title><link rel="stylesheet" href="${pathToFileURL(tokensPath).href}"><link rel="stylesheet" href="./auth-ui-entry.css"><style>html,body,#root{height:100%;margin:0}</style></head>`,
      '<body><div id="root"></div><script src="./auth-ui-entry.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );
  await runBrowserHarness(htmlPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 760 }, locale: "zh-CN" });
    await page.goto(pathToFileURL(path).href);
    await page.waitForSelector("[data-harness-ready='true']", { state: "attached" });

    const ownedChineseCountryLabels = await page.evaluate(() =>
      Object.fromEntries(
        window
          .countryOptionsForLocale("zh-CN")
          .filter(({ code }) => ["CN", "HK", "MO", "TW"].includes(code))
          .map(({ code, label }) => [code, label]),
      ),
    );
    assert.deepEqual(ownedChineseCountryLabels, {
      CN: "中国大陆",
      HK: "中国香港",
      MO: "中国澳门",
      TW: "中国台湾",
    });
    const ownedEnglishCountryLabels = await page.evaluate(() =>
      Object.fromEntries(
        window
          .countryOptionsForLocale("en")
          .filter(({ code }) => ["CN", "HK", "MO", "TW"].includes(code))
          .map(({ code, label }) => [code, label]),
      ),
    );
    assert.deepEqual(ownedEnglishCountryLabels, {
      CN: "Mainland China",
      HK: "Hong Kong",
      MO: "Macao",
      TW: "Taiwan",
    });
    const fallbackCountryOptions = await page.evaluate(() => {
      const displayNames = Intl.DisplayNames;
      const collator = Intl.Collator;
      try {
        Intl.DisplayNames = undefined;
        Intl.Collator = undefined;
        return window.countryOptionsForLocale("zh-CN");
      } finally {
        Intl.DisplayNames = displayNames;
        Intl.Collator = collator;
      }
    });
    assert.equal(fallbackCountryOptions.length, 249);
    assert.equal(fallbackCountryOptions.find(({ code }) => code === "JP")?.label, "JP");
    assert.equal(fallbackCountryOptions.find(({ code }) => code === "TW")?.label, "中国台湾");
    const accountOnboardingPersistence = await page.evaluate(() => {
      const values = new Map();
      const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      };
      const before = window.readAccountOnboardingCompleted(storage);
      window.markAccountOnboardingCompleted(storage);
      return {
        before,
        after: window.readAccountOnboardingCompleted(storage),
      };
    });
    assert.deepEqual(accountOnboardingPersistence, { before: false, after: true });

    assert.equal(
      await page.locator(".cloud-auth-tabs").count(),
      0,
      "login must not expose a manual registration switch",
    );
    assert.equal(
      await page.getByText("bbbe693c969f81bff13f4237e5659ee1", { exact: false }).count(),
      0,
      "login must not expose backend references",
    );
    assert.equal(await page.locator(".cloud-auth-legal a").count(), 0, "legal copy must not present fake links");
    assert.equal(
      await page.locator(".cloud-auth-employee-node > i").count(),
      0,
      "decorative employee avatars must not imply online presence",
    );
    assert.equal(
      await page.locator(".cloud-auth-cloud-signal").count(),
      4,
      "cloud agents should use a small set of signal nodes",
    );
    await page.getByText("继续即表示同意《服务条款》和《隐私政策》。", { exact: true }).waitFor();
    const continueWithoutAccount = page.getByRole("button", { name: "暂不登录，使用本机功能" });
    await continueWithoutAccount.waitFor();
    await continueWithoutAccount.click();
    assert.equal(await page.evaluate(() => window.__authCalls.continueWithoutAccount), 1);

    const lightAuthPalette = await readAuthPalette(page, "light");
    const darkAuthPalette = await readAuthPalette(page, "dark");
    assert.deepEqual(
      darkAuthPalette,
      lightAuthPalette,
      "the intentionally light-only auth palette must not drift with the workspace theme",
    );
    await page.evaluate(() => document.documentElement.setAttribute("data-resolved-theme", "light"));

    await page.setViewportSize({ width: 1440, height: 500 });
    const shortViewportOverflow = await page.evaluate(() => {
      const shell = document.querySelector(".cloud-auth-shell");
      return {
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: document.documentElement.clientHeight,
        shellHeight: shell?.scrollHeight,
        shellViewportHeight: shell?.clientHeight,
      };
    });
    assert.equal(
      shortViewportOverflow.documentHeight,
      shortViewportOverflow.viewportHeight,
      "auth decorations must not create document-level vertical overflow",
    );
    assert.equal(
      shortViewportOverflow.shellHeight,
      shortViewportOverflow.shellViewportHeight,
      "auth decorations must not create shell-level vertical overflow",
    );
    await page.setViewportSize({ width: 900, height: 760 });

    await page.getByRole("button", { name: "切换为English" }).click();
    await page.getByText("Return to your", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Switch to 中文" }).click();
    await page.getByText("回到你的", { exact: true }).waitFor();

    const email = page.getByLabel("邮箱");
    await email.fill("existing@example.test");
    await page.getByRole("button", { name: "获取验证码" }).click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.sendCode), [{ email: "existing@example.test" }]);

    await page.evaluate(() => window.updateAuthHarness({ sendCodePending: true }));
    assert.equal(await email.isDisabled(), true, "email should be locked while requesting a code");
    await page.evaluate(() => window.updateAuthHarness({ sendCodePending: false }));

    await page.evaluate(() =>
      window.updateAuthHarness({
        sendCodeSuccessCount: 1,
        sendCodeRequiresInvite: false,
        sendCodeRequiresCountry: false,
      }),
    );
    await page.getByLabel("验证码").waitFor();
    assert.equal(
      await page.locator(".cloud-auth-code-boxes > span").count(),
      6,
      "OTP boxes must use neutral span elements",
    );
    assert.equal(await page.getByLabel("邀请码").count(), 0, "an existing account should only see the code field");

    await page.evaluate(() => window.updateAuthHarness({ loginPending: true }));
    assert.equal(await page.getByLabel("验证码").isDisabled(), true, "code should be locked while logging in");
    await page.evaluate(() => window.updateAuthHarness({ loginPending: false }));

    await page.getByLabel("验证码").fill("123456");
    assert.equal(await page.locator(".cloud-auth-code-boxes > span[data-active='true']").count(), 1);
    assert.equal(await page.locator(".cloud-auth-code-boxes > span[data-active='true']").textContent(), "6");
    await page.locator("button[type='submit']").click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.login.at(-1)), {
      email: "existing@example.test",
      code: "123456",
    });

    await page.evaluate(() => window.updateAuthHarness({ error: "invite_code_required" }));
    await page.getByLabel("邀请码").waitFor();
    await assertVisibleText(page, "填写邀请码后直接继续");
    assert.equal(await page.getByRole("button", { name: "完成注册" }).isDisabled(), true);

    await page.evaluate(() => window.updateAuthHarness({ loginPending: true }));
    assert.equal(await page.getByLabel("邀请码").isDisabled(), true, "invite code should be locked while registering");
    await page.evaluate(() => window.updateAuthHarness({ loginPending: false }));

    await page.getByLabel("邀请码").fill("WRONG-CODE");
    await page.getByRole("button", { name: "完成注册" }).click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.login.at(-1)), {
      email: "existing@example.test",
      code: "123456",
      inviteCode: "WRONG-CODE",
    });

    await page.evaluate(() => window.updateAuthHarness({ error: "invite_code_invalid" }));
    await assertVisibleText(page, "邀请码无效");
    assert.equal(await page.getByLabel("邀请码").inputValue(), "WRONG-CODE");
    assert.equal(await page.getByLabel("邀请码").getAttribute("aria-invalid"), "true");

    await replaceEmailAndWaitForReset(page, email, "another@example.test");
    assert.equal(await page.getByLabel("验证码").count(), 0, "changing email should reset the code step");
    assert.equal(await page.getByLabel("邀请码").count(), 0, "changing email should reset registration state");
    assert.equal(await page.getByLabel("居住国家或地区").count(), 0, "changing email should reset country state");
    assert.equal(
      await page.getByText("邀请码无效", { exact: false }).count(),
      0,
      "changing email should clear stale errors",
    );

    await page.getByRole("button", { name: "获取验证码" }).click();
    await page.evaluate(() =>
      window.updateAuthHarness({
        sendCodeSuccessCount: 2,
        sendCodeRequiresInvite: false,
        sendCodeRequiresCountry: false,
      }),
    );
    await page.getByLabel("验证码").waitFor();
    assert.equal(
      await page.getByLabel("邀请码").count(),
      0,
      "a later existing-account attempt should not inherit invite UI",
    );
    assert.equal(
      await page.getByLabel("居住国家或地区").count(),
      0,
      "an existing account should not see country selection",
    );

    await replaceEmailAndWaitForReset(page, email, "register-first@example.test");
    await page.getByRole("button", { name: "获取验证码" }).click();
    await page.evaluate(() =>
      window.updateAuthHarness({
        sendCodeSuccessCount: 3,
        sendCodeRequiresInvite: true,
        sendCodeRequiresCountry: true,
      }),
    );
    await page.getByLabel("邀请码").waitFor();
    await page.getByLabel("居住国家或地区").waitFor();
    assert.equal(await page.locator(".cloud-auth-shell").getAttribute("data-step"), "registration");
    assert.equal(await page.getByLabel("邀请码").getAttribute("required"), "");
    assert.equal(
      await page.getByLabel("居住国家或地区").locator("option").count(),
      250,
      "country selector must cover all 249 ISO countries and regions",
    );
    assert.equal(
      await page.getByRole("button", { name: /完成注册/ }).isDisabled(),
      true,
      "new accounts must provide both the verification code and invite code",
    );
    await page.getByLabel("验证码").fill("654321");
    await page.getByLabel("邀请码").fill("INVALID-REGISTER-FIRST");
    assert.equal(
      await page.getByRole("button", { name: /完成注册/ }).isDisabled(),
      true,
      "country selection is required",
    );
    await page.getByLabel("居住国家或地区").selectOption("JP");
    await page.getByRole("button", { name: /完成注册/ }).click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.login.at(-1)), {
      email: "register-first@example.test",
      code: "654321",
      inviteCode: "INVALID-REGISTER-FIRST",
      countryCode: "JP",
    });
    await page.evaluate(() => window.updateAuthHarness({ error: "invite_code_invalid" }));
    await assertVisibleText(page, "邀请码无效");
    const resetSendCodeStateBeforeEmailChange = await page.evaluate(() => window.__authCalls.resetSendCodeState);
    await replaceEmailAndWaitForReset(page, email, "register-retry@example.test");
    assert.equal(await page.locator(".cloud-auth-shell").getAttribute("data-step"), "email");
    assert.ok(
      (await page.evaluate(() => window.__authCalls.resetSendCodeState)) > resetSendCodeStateBeforeEmailChange,
      "changing email must reset the send-code invite requirement",
    );
    await page.getByRole("button", { name: "获取验证码" }).click();
    await page.evaluate(() =>
      window.updateAuthHarness({
        sendCodeSuccessCount: 4,
        sendCodeRequiresInvite: false,
        sendCodeRequiresCountry: false,
      }),
    );
    await page.getByLabel("验证码").waitFor();
    assert.equal(
      await page.getByLabel("邀请码").count(),
      0,
      "the latest send-code result must control invite visibility",
    );

    await page.getByLabel("验证码").fill("246810");
    await page.getByRole("button", { name: "进入 OpenGrove" }).click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.login.at(-1)), {
      email: "register-retry@example.test",
      code: "246810",
    });
    await page.evaluate(() => window.updateAuthHarness({ error: "country_code_required" }));
    const fallbackCountrySelect = page.getByLabel("居住国家或地区");
    await fallbackCountrySelect.waitFor();
    await assertVisibleText(page, "请选择国家或地区以完成账号注册");
    assert.equal(await page.getByRole("button", { name: "完成注册" }).isDisabled(), true);
    await fallbackCountrySelect.selectOption("US");
    await page.getByRole("button", { name: "完成注册" }).click();
    assert.deepEqual(await page.evaluate(() => window.__authCalls.login.at(-1)), {
      email: "register-retry@example.test",
      code: "246810",
      countryCode: "US",
    });

    await page.evaluate(() => window.renderStartupLoadingHarness());
    const startupProgress = page.getByRole("status");
    await startupProgress.waitFor();
    assert.equal(await startupProgress.textContent(), "正在准备本地数据...", "startup progress must explain the wait");
    assert.equal(
      await startupProgress.locator("svg rect").count(),
      8,
      "desktop startup progress must keep the official eight-block OpenGrove mark",
    );
    const startupAnimations = await startupProgress
      .locator("svg rect")
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationName));
    assert.deepEqual(
      new Set(startupAnimations),
      new Set(["opengrove-startup-base", "opengrove-startup-trunk", "opengrove-startup-leaf"]),
      "desktop startup progress must use the approved Fluent-style base, trunk, and leaf sequence",
    );
    await page.evaluate(() => window.renderStartupLoadingHarness(true));
    assert.equal(
      await page.getByRole("status").textContent(),
      "正在迁移本地数据，请稍候...",
      "the migration activity must replace generic startup copy without adding a blocking control",
    );

    await page.evaluate(() => window.renderStartupTimeoutHarness(true));
    await page.getByText("启动未完成").waitFor();
    await page.waitForFunction(() => window.__startupCalls.record === 1);
    await page.getByRole("button", { name: "导出错误包" }).click();
    await page.getByText("已导出：OpenGrove-system-forensics-test.zip。仅用于错误排查，请仅提交给可信人员。").waitFor();
    await page.getByText("该错误包不完整", { exact: false }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        record: window.__startupCalls.record,
        export: window.__startupCalls.export,
      })),
      { record: 1, export: 1 },
    );
    const startupRetry = page.getByRole("button", { name: "重试" });
    assert.match(
      (await startupRetry.getAttribute("class")) ?? "",
      /cloud-auth-timeout-action--neutral/,
      "the startup retry action must use the gate's neutral button primitive instead of room-scoped styles",
    );
    await startupRetry.hover();
    assert.notEqual(
      await startupRetry.evaluate((element) => getComputedStyle(element).color),
      "rgb(255, 255, 255)",
      "the neutral startup retry action must not render white text on a pale surface",
    );
    await startupRetry.click();
    assert.equal(await page.evaluate(() => window.__startupCalls.retry), 1);

    await page.evaluate(() => window.renderStartupBlockerHarness());
    await page.getByText("本机服务需要处理").waitFor();
    await assertVisibleText(page, "PID 4242");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      await page.evaluate(() => window.__startupCalls.record),
      0,
      "a permanent blocker must be shown immediately instead of becoming a timeout",
    );
    await page.getByRole("button", { name: "关闭占用服务并重试" }).click();
    assert.deepEqual(await page.evaluate(() => window.__startupCalls.resolve), ["stop_blocking_process"]);
    await page.getByRole("button", { name: "修复访问权限并重试" }).click();
    assert.deepEqual(await page.evaluate(() => window.__startupCalls.resolve), [
      "stop_blocking_process",
      "repair_state_access",
    ]);
    await page.getByRole("button", { name: "打开数据目录" }).click();
    assert.equal(await page.evaluate(() => window.__startupCalls.openDataDir), 1);
    await page.getByRole("button", { name: "重新检测" }).click();
    assert.equal(await page.evaluate(() => window.__startupCalls.retry), 1);

    await page.evaluate(() => window.renderStartupTimeoutHarness(false));
    await page.getByText("启动未完成").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "导出错误包" }).count(),
      0,
      "Web mode must not expose desktop export",
    );

    await page.evaluate(() => window.renderAuthUnavailableHarness());
    await page.getByRole("status").waitFor();
    await page.getByText("账户服务离线").waitFor();
    await assertVisibleText(page, "OG-20260713-AUTH01");
    await page.getByRole("button", { name: /重试/ }).click();
    assert.equal(await page.evaluate(() => window.__authUnavailableRetry), 1);

    await page.evaluate(() => window.renderAuthCheckingHarness());
    await page.getByRole("status").waitFor();
    await page.getByText("正在连接账户服务").waitFor();
    assert.equal(await page.getByRole("button", { name: /重试/ }).count(), 0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.renderAccountProfileHarness());
    const accountButton = page.getByRole("button", { name: "账号" });
    assert.equal(await accountButton.count(), 1, "the account profile harness must expose the account button");
    await accountButton.click();
    await page.getByRole("menuitem").filter({ hasText: "个人账户" }).click();
    const accountRegion = page.getByRole("group", { name: "账号地区" });
    await accountRegion.waitFor();
    await assertVisibleText(page, "中国台湾");
    await assertVisibleText(page, "注册后不可修改");
    assert.equal(
      await accountRegion.locator("input, select, button").count(),
      0,
      "account region must be displayed without an editing control",
    );

    await page.evaluate(() => window.renderSignedOutAccountHarness());
    await page.getByRole("button", { name: "账号" }).click();
    await page.getByRole("menuitem", { name: "登录 OpenGrove" }).click();
    assert.equal(await page.evaluate(() => window.__accountLoginCalls), 1);

    console.log("web-auth-ui-harness ok");
  } finally {
    await browser.close();
  }
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) {
      throw error;
    }
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function assertVisibleText(page, text) {
  const matches = page.getByText(text, { exact: false });
  await matches.first().waitFor();
  const count = await matches.count();
  assert.ok(count > 0, `Expected visible text: ${text}`);
}

async function replaceEmailAndWaitForReset(page, emailField, nextEmail) {
  await page.getByRole("button", { name: "更换邮箱" }).click();
  await emailField.waitFor();
  await emailField.fill(nextEmail);
  await page.getByLabel("验证码").waitFor({ state: "detached" });
  await page.getByLabel("邀请码").waitFor({ state: "detached" });
  await page.getByText("邀请码无效", { exact: false }).waitFor({ state: "detached" });
  const sendCodeButton = page.getByRole("button", { name: "获取验证码" });
  await sendCodeButton.waitFor();
  assert.equal(await sendCodeButton.isEnabled(), true, "changing email should re-enable code requests");
  assert.equal(await emailField.inputValue(), nextEmail, "changing email should keep the new address");
}

async function readAuthPalette(page, theme) {
  return page.evaluate((resolvedTheme) => {
    document.documentElement.setAttribute("data-resolved-theme", resolvedTheme);
    const probe = document.createElement("span");
    probe.style.cssText = [
      "color:var(--auth-brand)",
      "background:var(--auth-error)",
      "border:1px solid var(--auth-local-line-22)",
    ].join(";");
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const palette = {
      brand: style.color,
      error: style.backgroundColor,
      localLine: style.borderColor,
    };
    probe.remove();
    return palette;
  }, theme);
}

function entrySource() {
  const authScreenPath = resolve(projectRoot, "web/src/components/app-shell/app-gates.tsx");
  const appNavigationPath = resolve(projectRoot, "web/src/components/sidebar/app-navigation.tsx");
  const countryCodesPath = resolve(projectRoot, "web/src/country-codes.ts");
  const accountOnboardingPath = resolve(projectRoot, "web/src/account-onboarding.ts");
  return `
    import React, { useState } from "react";
    import { flushSync } from "react-dom";
    import { createRoot } from "react-dom/client";
    import { AccountServiceStatus, CloudAuthLoadingScreen, CloudAuthScreen } from ${JSON.stringify(authScreenPath)};
    import { AppRail } from ${JSON.stringify(appNavigationPath)};
    import { countryOptionsForLocale } from ${JSON.stringify(countryCodesPath)};
    import { markAccountOnboardingCompleted, readAccountOnboardingCompleted } from ${JSON.stringify(accountOnboardingPath)};
    import { loadClientBootstrap } from ${JSON.stringify(resolve(projectRoot, "web/src/runtime/client-bootstrap.ts"))};

    const root = createRoot(document.getElementById("root"));
    window.countryOptionsForLocale = countryOptionsForLocale;
    window.markAccountOnboardingCompleted = markAccountOnboardingCompleted;
    window.readAccountOnboardingCompleted = readAccountOnboardingCompleted;
    window.__authCalls = { sendCode: [], login: [], reset: 0, resetSendCodeState: 0, continueWithoutAccount: 0 };
    let setView;

    function Harness() {
      const [view, setViewState] = useState({
        sendCodePending: false,
        sendCodeRequiresInvite: false,
        sendCodeRequiresCountry: false,
        loginPending: false,
        sendCodeSuccessCount: 0,
        error: "",
        retryAfter: undefined,
      });
      setView = setViewState;
      return React.createElement(React.Fragment, null,
        React.createElement(CloudAuthScreen, {
          sendCodePending: view.sendCodePending,
          sendCodeRequiresInvite: view.sendCodeRequiresInvite,
          sendCodeRequiresCountry: view.sendCodeRequiresCountry,
          sendCodeSuccessCount: view.sendCodeSuccessCount,
          loginPending: view.loginPending,
          error: view.error,
          errorReference: "bbbe693c969f81bff13f4237e5659ee1",
          retryAfter: view.retryAfter,
          onSendCode: (payload) => window.__authCalls.sendCode.push(payload),
          onLogin: (payload) => window.__authCalls.login.push(payload),
          onContinueWithoutAccount: () => {
            window.__authCalls.continueWithoutAccount += 1;
          },
          onResetSendCodeState: () => {
            window.__authCalls.resetSendCodeState += 1;
            setViewState((current) => ({ ...current, sendCodeRequiresInvite: false, sendCodeRequiresCountry: false }));
          },
          onResetError: () => {
            window.__authCalls.reset += 1;
            setViewState((current) => ({ ...current, error: "" }));
          },
        }),
        React.createElement("span", { "data-harness-ready": "true", hidden: true }),
      );
    }

    flushSync(() => root.render(React.createElement(Harness)));
    window.updateAuthHarness = (patch) => flushSync(() => {
      setView((current) => ({ ...current, ...patch }));
    });
    window.renderStartupTimeoutHarness = (desktop) => {
      window.__startupCalls = { retry: 0, record: 0, export: 0 };
      window.openGroveDesktop = desktop ? {
        recordStartupTimeout: async () => {
          window.__startupCalls.record += 1;
          return { code: "desktop_startup_timeout", incidentId: "OG-20260711-ABC123" };
        },
        exportDiagnostics: async () => {
          window.__startupCalls.export += 1;
          return {
            status: "saved",
            path: "/tmp/OpenGrove-system-forensics-test.zip",
            fileName: "OpenGrove-system-forensics-test.zip",
            sizeBytes: 1024,
            sha256: "sha256-test",
            evidenceComplete: false,
          };
        },
      } : undefined;
      flushSync(() => root.render(React.createElement(CloudAuthLoadingScreen, {
        key: desktop ? "desktop" : "web",
        timeoutMs: 10,
        onRetry: () => { window.__startupCalls.retry += 1; },
      })));
    };
    window.renderStartupLoadingHarness = (migratingLocalData = false) => {
      window.openGroveDesktop = {};
      flushSync(() => root.render(React.createElement(CloudAuthLoadingScreen, {
        key: "desktop-loading",
        recoveringLocalService: true,
        migratingLocalData,
        onRetry: () => {},
      })));
    };
    window.renderStartupBlockerHarness = () => {
      window.__startupCalls = { retry: 0, record: 0, export: 0, openDataDir: 0, resolve: [] };
      window.openGroveDesktop = {
        recordStartupTimeout: async () => {
          window.__startupCalls.record += 1;
          return { code: "desktop_startup_timeout", incidentId: "OG-20260711-ABC123" };
        },
        openDataDir: async () => { window.__startupCalls.openDataDir += 1; },
        resolveBridgeStartupBlocker: async (action) => { window.__startupCalls.resolve.push(action); },
      };
      flushSync(() => root.render(React.createElement(CloudAuthLoadingScreen, {
        key: "desktop-blocker",
        timeoutMs: 10,
        blocker: {
          code: "LOCAL_STATE_LOCKED",
          message: "PID 4242 is still using this OpenGrove data. Close the other OpenGrove window and retry.",
          actions: ["stop_blocking_process", "repair_state_access", "open_data_dir", "retry"],
        },
        onRetry: () => { window.__startupCalls.retry += 1; },
      })));
    };
    window.renderAuthUnavailableHarness = () => {
      window.__authUnavailableRetry = 0;
      flushSync(() => root.render(React.createElement(AccountServiceStatus, {
        state: "offline",
        retrying: false,
        errorReference: "OG-20260713-AUTH01",
        onRetry: () => { window.__authUnavailableRetry += 1; },
      })));
    };
    window.renderAuthCheckingHarness = () => {
      flushSync(() => root.render(React.createElement(AccountServiceStatus, {
        state: "checking",
        retrying: true,
        onRetry: () => {},
      })));
    };
    window.renderAccountProfileHarness = async () => {
      const previousFetch = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({
        environment: {
          preset: "test",
          profile: "test",
          tenancy: "single-principal",
          execution: "fake",
          workspace: "memory",
          stateStore: "memory",
          blobStore: "memory",
          auth: "session",
        },
        auth: { mode: "session", tokenRequired: false },
        hostId: "0123456789abcdef",
        mcpApps: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        await loadClientBootstrap();
      } finally {
        window.fetch = previousFetch;
      }
      flushSync(() => root.render(React.createElement(AppRail, {
        activeSection: "chat",
        expanded: true,
        authUser: {
          userId: "profile-user",
          email: "edward@example.test",
          countryCode: "TW",
          displayName: "Edward",
          profileStatus: "available",
          role: "user",
        },
        onOpenSection: () => {},
        onOpenSettings: () => {},
        onCreateApp: () => {},
      })));
    };
    window.renderSignedOutAccountHarness = () => {
      window.__accountLoginCalls = 0;
      flushSync(() => root.render(React.createElement(AppRail, {
        key: "signed-out-account",
        activeSection: "chat",
        expanded: true,
        onLogin: () => { window.__accountLoginCalls += 1; },
        onOpenSection: () => {},
        onOpenSettings: () => {},
        onCreateApp: () => {},
      })));
    };
  `;
}
