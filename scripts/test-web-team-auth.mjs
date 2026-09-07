import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-team-auth-ui-"));
let browser;
try {
  const bundlePath = join(tempDir, "harness.js");
  await build({
    stdin: { contents: entrySource(), loader: "tsx", resolveDir: projectRoot },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    define: { __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: "true" },
    plugins: [
      {
        name: "team-auth-bridge-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /^\.\/bridge$/ }, (args) =>
            args.importer.endsWith("app-auth-gate.ts") ? { path: "team-auth-bridge", namespace: "fixture" } : undefined,
          );
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: bridgeFixtureSource(),
            loader: "js",
          }));
        },
      },
    ],
  });
  const htmlPath = join(tempDir, "index.html");
  await writeFile(htmlPath, '<!doctype html><div id="root"></div><script src="./harness.js"></script>');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(() => window.teamAuthState?.teamGateSatisfied === true);
  assert.equal(await page.locator("[data-account]").textContent(), "real@example.org");

  await page.getByRole("button", { name: "Switch account" }).click();
  await page.waitForFunction(() => window.teamAuthState?.switchFailed);
  assert.equal(await page.locator("[data-account]").textContent(), "real@example.org");
  assert.equal(await page.evaluate(() => window.sessionChanges), 0);

  // An expired browser admission must be rediscovered after sign-in fails.
  await page.evaluate(() => {
    window.fixtureGate = { required: true, satisfied: false };
  });
  await page.getByRole("button", { name: "Request code" }).click();
  await page.waitForFunction(() => window.teamAuthState?.teamGateBlocksSignIn === true);

  // Production has no team gate and must not request or offer fixture accounts.
  await page.evaluate(() => window.setGate({ required: false, satisfied: true }));
  await page.waitForFunction(
    () => window.teamAuthState?.teamGateSatisfied === false && window.teamAuthState?.teamGateBlocksSignIn === false,
  );
  assert.deepEqual(errors, []);
  console.log("web-team-auth-harness ok");
} finally {
  await browser?.close();
  await rm(tempDir, { recursive: true, force: true });
}

function bridgeFixtureSource() {
  return `
    export async function fetchBridgeTeamGateStatus() { return window.fixtureGate; }
    export async function fetchBridgeTeamAccounts() { return { accounts: [] }; }
    export async function unlockBridgeTeamToken() { return window.fixtureGate; }
    export async function logoutBridgeAuth() { return { ok: true }; }
    export async function signInBridgeTeamAccount() { throw new Error("fixture_missing"); }
    export async function restoreBridgePreviousSession() { throw new Error("temporary_failure"); }
    export async function loginBridgeAuth() { throw new Error("team_token_required"); }
    export async function sendBridgeEmailCode() { throw new Error("team_token_required"); }
  `;
}

function entrySource() {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
    import { useBridgeAuthGate } from ${JSON.stringify(join(projectRoot, "web/src/app-auth-gate.ts"))};
    window.fixtureGate = { required: true, satisfied: true };
    window.sessionChanges = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["auth-session"], { status: "authenticated", authenticated: true, user: { email: "real@example.org" } });
    window.setGate = async value => {
      window.fixtureGate = value;
      await queryClient.invalidateQueries({ queryKey: ["auth-team-gate"] });
    };
    function Harness() {
      const sessionQuery = useQuery({ queryKey: ["auth-session"], enabled: false });
      const gate = useBridgeAuthGate({
        queryClient, sessionQuery,
        healthQuery: { data: { auth: { mode: "session" } }, isPending: false },
        desktopSavedSession: false, desktopBridgeReady: false,
        desktopAccountOnboardingCompleted: false, languagePreference: "en",
        onAuthSessionChanged: () => { window.sessionChanges += 1; },
      });
      window.teamAuthState = {
        teamGateSatisfied: gate.teamGateSatisfied,
        teamGateBlocksSignIn: gate.teamGateBlocksSignIn,
        switchFailed: gate.authFixtureSwitchMutation.isError,
      };
      return <>
        <span data-account>{sessionQuery.data?.user?.email ?? "signed-out"}</span>
        <button onClick={() => gate.authFixtureSwitchMutation.mutate({ email: "missing@example.test" })}>Switch account</button>
        <button onClick={() => gate.authSendCodeMutation.mutate("real@example.org")}>Request code</button>
      </>;
    }
    createRoot(document.getElementById("root")).render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  `;
}
