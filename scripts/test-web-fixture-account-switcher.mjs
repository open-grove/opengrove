import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const fixtureModulePath = new URL("../web/src/dev-fixture-accounts.ts", import.meta.url);
const fixtureModuleSource = await readFile(fixtureModulePath, "utf8");

async function loadFixtureModule(compiledIn) {
  const transformed = await transform(fixtureModuleSource, {
    define: { __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: String(compiledIn) },
    format: "esm",
    loader: "ts",
  });
  return import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);
}

const { devFixtureAccountSwitcherAvailable, switchDevFixtureAccount } = await loadFixtureModule(true);

const available = { isOfficialRelease: false, sessionAuthActive: true, teamGateSatisfied: true };
assert.equal(devFixtureAccountSwitcherAvailable(available), true);

// Each gate on its own must be able to hide the switcher.
assert.equal(devFixtureAccountSwitcherAvailable({ ...available, isOfficialRelease: true }), false);
assert.equal(devFixtureAccountSwitcherAvailable({ ...available, sessionAuthActive: false }), false);
// Without the team token ww refuses to list or grant these accounts, so the
// switcher would only ever produce failures.
assert.equal(devFixtureAccountSwitcherAvailable({ ...available, teamGateSatisfied: false }), false);

// A browser reports undefined rather than false, and must still see the switcher:
// it has no notion of a packaged release, so that gate does not apply there.
assert.equal(devFixtureAccountSwitcherAvailable({ ...available, isOfficialRelease: undefined }), true);

// The compile-time constant is the outermost gate, and no runtime state overrides it.
const { devFixtureAccountSwitcherAvailable: unavailable } = await loadFixtureModule(false);
assert.equal(unavailable(available), false);

// Switching is one call carrying only the address. Everything else -- whether the
// account is offered at all, whether it exists, what roles it has -- is ww's answer,
// which is why nothing here resembles the old logout/code/login sequence.
const calls = [];
const result = await switchDevFixtureAccount(
  { email: "cn-reviewer-a@example.test", roles: ["vega_reviewer"], status: "active" },
  {
    async signIn(email) {
      calls.push(email);
      return { userId: "1010" };
    },
  },
);

assert.deepEqual(result, { userId: "1010" });
assert.deepEqual(calls, ["cn-reviewer-a@example.test"]);

console.log("web fixture account switcher tests passed");
