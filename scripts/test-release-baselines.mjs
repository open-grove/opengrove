import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previousReleaseAssets } from "./release-baselines.mjs";
const release = {
  tag_name: "v0.7.0",
  draft: false,
  prerelease: false,
  assets: [
    { name: "OpenGrove-0.7.0-mac-arm64.dmg", size: 10, digest: `sha256:${"a".repeat(64)}` },
    { name: "OpenGrove-0.7.0-mac-x64.dmg", size: 11, digest: `sha256:${"b".repeat(64)}` },
    { name: "OpenGrove-0.7.0-win-x64.exe", size: 12, digest: `sha256:${"c".repeat(64)}` },
  ],
};
assert.equal(previousReleaseAssets(release)["windows-x64"].sha256, "c".repeat(64));
assert.throws(() => previousReleaseAssets({ ...release, assets: release.assets.slice(0, 2) }), /windows-x64/);
assert.throws(() => previousReleaseAssets({ ...release, draft: true }), /stable/);
assert.throws(() => previousReleaseAssets({ ...release, assets: [...release.assets, release.assets[0]] }), /mac-arm64/);
assert.throws(
  () => previousReleaseAssets({ ...release, assets: release.assets.map((asset) => ({ ...asset, digest: null })) }),
  /identity/,
);
console.log("Release baseline inventory ok");

const directory = mkdtempSync(join(tmpdir(), "opengrove-baseline-bytes-"));
try {
  const file = "OpenGrove-0.7.0-mac-arm64.dmg";
  const output = join(directory, "github-output");
  const manifest = {
    schemaVersion: 1,
    tag: "v0.7.0",
    assets: {
      "mac-arm64": { file, size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    },
  };
  writeFileSync(join(directory, file), "abc");
  writeFileSync(join(directory, "previous-release.json"), JSON.stringify(manifest));
  const invoke = (tag = "v0.7.0") =>
    spawnSync(process.execPath, ["scripts/release-baselines.mjs", "verify", directory, "mac-arm64"], {
      encoding: "utf8",
      env: { ...process.env, OPENGROVE_PREVIOUS_RELEASE_TAG: tag, GITHUB_OUTPUT: output },
    });
  assert.equal(invoke().status, 0);
  assert.ok(readFileSync(output, "utf8").includes(`installer=${join(directory, file)}`));
  writeFileSync(join(directory, file), "abd");
  assert.match(invoke().stderr, /SHA-256 mismatch/);
  assert.match(invoke("v0.6.5").stderr, /tag mismatch/);
  writeFileSync(join(directory, file), "abcd");
  assert.match(invoke().stderr, /size mismatch/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
