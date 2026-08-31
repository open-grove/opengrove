import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-stripe-deep-link-"));
const bundlePath = join(tempDir, "stripe-deep-link.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "src", "desktop-stripe-deep-link.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const {
    desktopStripeDeepLinkScheme,
    findDesktopStripeDeepLink,
    isDesktopStripeDeepLink,
    parseDesktopStripeDeepLink,
  } = await import(pathToFileURL(bundlePath).href);

  assert.equal(desktopStripeDeepLinkScheme("stable"), "opengrove");
  assert.equal(desktopStripeDeepLinkScheme("dev"), "opengrove-dev");
  assert.deepEqual(parseDesktopStripeDeepLink("opengrove://stripe/return", "opengrove"), {
    kind: "stripe-onboarding",
    action: "return",
  });
  assert.deepEqual(parseDesktopStripeDeepLink("opengrove-dev://stripe/refresh", "opengrove-dev"), {
    kind: "stripe-onboarding",
    action: "refresh",
  });
  for (const value of [
    "opengrove-dev://stripe/return?account=acct_private",
    "opengrove-dev://stripe/return#fragment",
    "opengrove-dev://stripe/delete",
    "opengrove-dev://other/return",
    "opengrove://stripe/return",
    " https://stripe/return",
    "not a URL",
  ]) {
    assert.equal(parseDesktopStripeDeepLink(value, "opengrove-dev"), null, `must reject untrusted deep link ${value}`);
  }
  assert.deepEqual(
    findDesktopStripeDeepLink(
      ["/Applications/OpenGrove Dev.app", "--flag", "opengrove-dev://stripe/return"],
      "opengrove-dev",
    ),
    { kind: "stripe-onboarding", action: "return" },
  );
  assert.equal(isDesktopStripeDeepLink({ kind: "stripe-onboarding", action: "refresh" }), true);
  assert.equal(isDesktopStripeDeepLink({ kind: "stripe-onboarding", action: "delete" }), false);

  console.log("desktop-stripe-deep-link-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
