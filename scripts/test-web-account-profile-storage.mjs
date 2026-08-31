import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-account-profile-"));
const entryPath = join(tempDir, "entry.ts");
const bundlePath = join(tempDir, "bundle.js");

try {
  await writeFile(
    entryPath,
    `
    import {
      LOCAL_ACCOUNT_PROFILE_USER_ID,
      readAccountProfile,
      resolveAccountProfileUserId,
      writeAccountProfile,
    } from ${JSON.stringify(join(projectRoot, "web/src/runtime/account-profile-store.ts"))};
    import { accountProfileLoadAction } from ${JSON.stringify(join(projectRoot, "web/src/account-profile-policy.ts"))};
    globalThis.profileStore = {
      accountProfileLoadAction,
      LOCAL_ACCOUNT_PROFILE_USER_ID,
      readAccountProfile,
      resolveAccountProfileUserId,
      writeAccountProfile,
    };
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
  });
  const bundle = await readFile(bundlePath);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": request.url === "/bundle.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/bundle.js" ? bundle : "<script src=/bundle.js></script>");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const result = await page.evaluate(async () => {
        localStorage.setItem(
          "opengroveAccountProfiles",
          JSON.stringify({
            userA: {
              userId: "userB",
              username: "旧资料",
              avatarDataUrl: "data:image/jpeg;base64,bGVnYWN5",
            },
            anonymous: { username: "本地用户" },
          }),
        );
        const localUserId = globalThis.profileStore.resolveAccountProfileUserId(undefined, "local-single");
        const webAnonymousUserId = globalThis.profileStore.resolveAccountProfileUserId(undefined, "web-single");
        const migratedLocal = await globalThis.profileStore.readAccountProfile(localUserId);
        const migrated = await globalThis.profileStore.readAccountProfile("userA");
        const notOverridden = await globalThis.profileStore.readAccountProfile("userB");
        const saved = await globalThis.profileStore.writeAccountProfile("userB", {
          username: "用户 B",
          avatarUrl: "https://assets.example.test/user-b.jpg",
        });
        const isolated = await globalThis.profileStore.readAccountProfile("userA");
        let anonymousRejected = false;
        try {
          await globalThis.profileStore.writeAccountProfile("anonymous", { username: "匿名" });
        } catch {
          anonymousRejected = true;
        }
        return {
          migrated: migrated?.username,
          migratedAvatar: migrated?.avatarUrl,
          migratedLocal: migratedLocal?.username,
          localUserId,
          webAnonymousRejected: webAnonymousUserId === undefined,
          notOverridden: notOverridden === undefined,
          saved: saved.username,
          savedAvatar: saved.avatarUrl,
          isolated: isolated?.username,
          legacyRemoved: localStorage.getItem("opengroveAccountProfiles") === null,
          backupPreserved: localStorage.getItem("opengroveAccountProfiles:pre-indexeddb-v1") !== null,
          anonymousRejected,
          availableUsesRemote:
            globalThis.profileStore.accountProfileLoadAction({ profileStatus: "available" }, true) === "use-remote",
          unavailableUsesCache:
            globalThis.profileStore.accountProfileLoadAction({ profileStatus: "unavailable" }, true) === "use-cache",
          missingMigratesCache:
            globalThis.profileStore.accountProfileLoadAction({ profileStatus: "missing" }, true) === "migrate-cache",
        };
      });
      assert.deepEqual(result, {
        migrated: "旧资料",
        migratedAvatar: "data:image/jpeg;base64,bGVnYWN5",
        migratedLocal: "本地用户",
        localUserId: "local-user",
        webAnonymousRejected: true,
        notOverridden: true,
        saved: "用户 B",
        savedAvatar: "https://assets.example.test/user-b.jpg",
        isolated: "旧资料",
        legacyRemoved: true,
        backupPreserved: true,
        anonymousRejected: true,
        availableUsesRemote: true,
        unavailableUsesCache: true,
        missingMigratesCache: true,
      });

      const invalidPage = await browser.newPage();
      await invalidPage.goto(`http://127.0.0.1:${address.port}`);
      const invalidMigration = await invalidPage.evaluate(async () => {
        localStorage.setItem("opengroveAccountProfiles", "{not-json");
        const missing = await globalThis.profileStore.readAccountProfile("userA");
        await globalThis.profileStore.writeAccountProfile("userA", { username: "新资料" });
        const saved = await globalThis.profileStore.readAccountProfile("userA");
        return {
          missing: missing === undefined,
          saved: saved?.username,
          sourceRemoved: localStorage.getItem("opengroveAccountProfiles") === null,
          backupPreserved: localStorage.getItem("opengroveAccountProfiles:pre-indexeddb-v1") === "{not-json",
        };
      });
      assert.deepEqual(invalidMigration, {
        missing: true,
        saved: "新资料",
        sourceRemoved: true,
        backupPreserved: true,
      });
      await invalidPage.close();

      const quotaPage = await browser.newPage();
      await quotaPage.goto(`http://127.0.0.1:${address.port}`);
      const quotaFailure = await quotaPage.evaluate(async () => {
        const sourceKey = "opengroveAccountProfiles";
        const backupKey = `${sourceKey}:pre-indexeddb-v1`;
        const raw = JSON.stringify({ quotaUser: { username: "必须保留" } });
        localStorage.removeItem(backupKey);
        localStorage.setItem(sourceKey, raw);
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function setItem(key, value) {
          if (key === backupKey) throw new DOMException("quota exceeded", "QuotaExceededError");
          return originalSetItem.call(this, key, value);
        };
        try {
          await globalThis.profileStore.readAccountProfile("quotaUser");
        } finally {
          Storage.prototype.setItem = originalSetItem;
        }
        return {
          sourcePreserved: localStorage.getItem(sourceKey) === raw,
          backupMissing: localStorage.getItem(backupKey) === null,
        };
      });
      assert.deepEqual(quotaFailure, {
        sourcePreserved: true,
        backupMissing: true,
      });
      await quotaPage.close();
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Web account profile storage harness passed.");

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}
