import assert from "node:assert/strict";
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
