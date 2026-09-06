import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const fixtureModulePath = new URL("../web/src/dev-fixture-accounts.ts", import.meta.url);
const fixtureModuleSource = await readFile(fixtureModulePath, "utf8");
const transformedFixtureModule = await transform(fixtureModuleSource, {
  define: { __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: "true" },
  format: "esm",
  loader: "ts",
});
const fixtureModule = await import(
  `data:text/javascript;base64,${Buffer.from(transformedFixtureModule.code).toString("base64")}`
);
const { DEV_FIXTURE_ACCOUNTS, devFixtureAccountSwitcherAvailable, switchDevFixtureAccount } = fixtureModule;

assert.equal(devFixtureAccountSwitcherAvailable({ isOfficialRelease: false, sessionAuthActive: true }), true);
assert.equal(devFixtureAccountSwitcherAvailable({ isOfficialRelease: true, sessionAuthActive: true }), false);
assert.equal(devFixtureAccountSwitcherAvailable({ isOfficialRelease: false, sessionAuthActive: false }), false);

assert.equal(DEV_FIXTURE_ACCOUNTS.length, 24);
assert.equal(new Set(DEV_FIXTURE_ACCOUNTS.map((account) => account.id)).size, 24);
assert.equal(new Set(DEV_FIXTURE_ACCOUNTS.map((account) => account.email)).size, 24);
assert.deepEqual(
  DEV_FIXTURE_ACCOUNTS.filter((account) => !account.enabled).map((account) => account.email),
  ["cn-disabled@example.test"],
);

const reviewer = DEV_FIXTURE_ACCOUNTS.find((account) => account.email === "cn-reviewer-a@example.test");
assert.ok(reviewer);
assert.deepEqual(reviewer.roles, ["vega_reviewer"]);

const calls = [];
const result = await switchDevFixtureAccount(
  reviewer,
  { languagePreference: "system", systemLanguage: "zh-CN" },
  {
    async logout() {
      calls.push(["logout"]);
    },
    async sendEmailCode(payload) {
      calls.push(["send", payload]);
    },
    async login(payload) {
      calls.push(["login", payload]);
      return { userId: reviewer.id };
    },
  },
);

assert.deepEqual(result, { userId: "1010" });
assert.deepEqual(calls, [
  ["logout"],
  ["send", { email: "cn-reviewer-a@example.test" }],
  [
    "login",
    {
      email: "cn-reviewer-a@example.test",
      code: "000000",
      countryCode: "CN",
      deviceName: "OpenGrove fixture switcher",
      platform: "macos",
      languagePreference: "system",
      systemLanguage: "zh-CN",
    },
  ],
]);

const disabled = DEV_FIXTURE_ACCOUNTS.find((account) => !account.enabled);
assert.ok(disabled);
await assert.rejects(
  switchDevFixtureAccount(
    disabled,
    { languagePreference: "system", systemLanguage: "en" },
    {
      async logout() {
        throw new Error("disabled account must fail before logout");
      },
      async sendEmailCode() {
        throw new Error("disabled account must fail before send");
      },
      async login() {
        throw new Error("disabled account must fail before login");
      },
    },
  ),
  /fixture_account_disabled/,
);

console.log("web fixture account switcher tests passed");
