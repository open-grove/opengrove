import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadPublicReleaseBootstrapInstaller, resolvePublicReleaseBootstrap } from "./public-release-bootstrap.mjs";

const suffixes = { "mac-arm64": "mac-arm64.dmg", "mac-x64": "mac-x64.dmg", "windows-x64": "win-x64.exe" };
export function previousReleaseAssets(release) {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease)
    throw new Error("Previous release must be stable");
  return Object.fromEntries(
    Object.entries(suffixes).map(([target, suffix]) => {
      const name = `OpenGrove-${release.tag_name.slice(1)}-${suffix}`;
      const matches = release.assets.filter((asset) => asset.name === name);
      if (matches.length !== 1) throw new Error(`Previous release must contain exactly one ${target} installer`);
      const asset = matches[0];
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""))
        throw new Error(`Previous ${target} installer has no verified size/SHA-256 identity`);
      return [target, { file: name, size: asset.size, sha256: asset.digest.slice(7) }];
    }),
  );
}
async function verifyFile(path, asset) {
  if (statSync(path).size !== asset.size) throw new Error(`Previous installer size mismatch: ${asset.file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== asset.sha256) throw new Error(`Previous installer SHA-256 mismatch: ${asset.file}`);
}
function readRelease(repository, tag) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is required");
  if (tag !== "latest" && !/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Previous tag is invalid");
  return JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/releases/${tag === "latest" ? "latest" : `tags/${tag}`}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}
async function main() {
  const [command, directory, target] = process.argv.slice(2);
  if (!directory || !["prepare", "verify", "health"].includes(command))
    throw new Error("Usage: release-baselines.mjs prepare|verify|health DIRECTORY [TARGET]");
  const outputDir = resolve(directory);
  const receiptPath = join(outputDir, "previous-release.json");
  if (command === "verify") {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.tag !== process.env.OPENGROVE_PREVIOUS_RELEASE_TAG)
      throw new Error("Previous release receipt tag mismatch");
    const asset = receipt.assets?.[target];
    if (!asset || asset.file !== `OpenGrove-${receipt.tag.slice(1)}-${suffixes[target]}`)
      throw new Error("Previous installer receipt target mismatch");
    const installer = join(outputDir, asset.file);
    await verifyFile(installer, asset);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `installer=${installer}\n`);
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  const repository = process.env.GITHUB_REPOSITORY;
  const bootstrap = command === "prepare" && process.env.OPENGROVE_PREVIOUS_RELEASE_SOURCE === "bootstrap";
  const release = bootstrap
    ? null
    : readRelease(repository, command === "health" ? "latest" : process.env.OPENGROVE_PREVIOUS_RELEASE_TAG);
  const manifest = bootstrap ? resolvePublicReleaseBootstrap(process.env.OPENGROVE_EXPECTED_RELEASE_TAG) : null;
  const tag = bootstrap ? manifest.previousReleaseTag : release.tag_name;
  const assets = bootstrap ? manifest.assets : previousReleaseAssets(release);
  const githubRoot = `https://github.com/${repository}/releases/download`;
  if (command === "health") {
    const golden = JSON.parse(
      readFileSync(new URL("./fixtures/desktop-release-golden-v0.6.0.json", import.meta.url), "utf8"),
    );
    const publicRoot = new URL(process.env.OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT);
    if (
      publicRoot.protocol !== "https:" ||
      publicRoot.username ||
      publicRoot.password ||
      publicRoot.search ||
      publicRoot.hash
    )
      throw new Error("Golden baseline needs a credential-free HTTPS public root");
    const probes = [
      ...Object.values(golden.targets).map((asset) => ({
        url: `${publicRoot.href.replace(/\/$/, "")}/${golden.tag}/${asset.asset}`,
        size: asset.size,
      })),
      ...Object.values(assets).map((asset) => ({ url: `${githubRoot}/${tag}/${asset.file}`, size: asset.size })),
    ];
    const failures = [];
    for (const probe of probes) {
      const response = await fetch(probe.url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status !== 200 || Number(response.headers.get("content-length")) !== probe.size)
        failures.push(`${probe.url}: HTTP ${response.status}, size ${response.headers.get("content-length")}`);
    }
    if (failures.length) throw new Error(`Release baseline availability failed:\n${failures.join("\n")}`);
    console.log(
      `Golden ${golden.tag} and previous ${tag}: all six installers available with expected sizes; candidate gates verify complete bytes.`,
    );
    return;
  }
  for (const [assetTarget, asset] of Object.entries(assets)) {
    if (bootstrap) {
      await downloadPublicReleaseBootstrapInstaller({
        expectedTag: process.env.OPENGROVE_EXPECTED_RELEASE_TAG,
        target: assetTarget,
        publicRoot: process.env.OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT,
        outputDir,
      });
    } else {
      execFileSync(
        "gh",
        ["release", "download", tag, "--repo", repository, "--pattern", asset.file, "--dir", outputDir],
        { stdio: "inherit", timeout: 15 * 60_000 },
      );
    }
    await verifyFile(join(outputDir, asset.file), asset);
    console.log(`Verified previous ${tag} / ${assetTarget}`);
  }
  writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, tag, assets }, null, 2)}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
