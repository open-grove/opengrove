import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadPublicReleaseBootstrapInstaller,
  readPublicReleaseBootstrap,
  resolvePublicReleaseBootstrap,
  validatePublicReleaseBootstrap,
} from "./public-release-bootstrap.mjs";

const reviewed = readPublicReleaseBootstrap();
assert.equal(reviewed.firstPublicReleaseTag, "v0.6.6");
assert.equal(reviewed.previousReleaseTag, "v0.6.5");
assert.equal(reviewed.assets["mac-arm64"].size, 226870743);
assert.deepEqual(resolvePublicReleaseBootstrap("v0.6.6"), reviewed);
assert.throws(() => resolvePublicReleaseBootstrap("v0.6.7"), /only valid for v0\.6\.6/);

const bytes = Buffer.from("reviewed bootstrap installer fixture");
const file = "OpenGrove-0.6.5-mac-arm64.dmg";
const fixture = validatePublicReleaseBootstrap({
  schemaVersion: 1,
  firstPublicReleaseTag: "v0.6.6",
  previousReleaseTag: "v0.6.5",
  assets: {
    "mac-arm64": { file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    "mac-x64": {
      file: "OpenGrove-0.6.5-mac-x64.dmg",
      size: 1,
      sha256: "a".repeat(64),
    },
    "windows-x64": {
      file: "OpenGrove-0.6.5-win-x64.exe",
      size: 1,
      sha256: "b".repeat(64),
    },
  },
});

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-public-release-bootstrap-"));
try {
  let requestedUrl;
  const installer = await downloadPublicReleaseBootstrapInstaller({
    expectedTag: "v0.6.6",
    target: "mac-arm64",
    publicRoot: "https://releases.example.test/opengrove/releases",
    outputDir: tempRoot,
    manifest: fixture,
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    },
  });
  assert.equal(requestedUrl, `https://releases.example.test/opengrove/releases/v0.6.5/${file}`);
  assert.deepEqual(readFileSync(installer), bytes);

  await assert.rejects(
    downloadPublicReleaseBootstrapInstaller({
      expectedTag: "v0.6.6",
      target: "mac-arm64",
      publicRoot: "http://releases.example.test/opengrove/releases",
      outputDir: tempRoot,
      manifest: fixture,
      fetchImpl: async () => new Response(bytes),
    }),
    /credential-free HTTPS URL/,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("public release bootstrap ok");
