import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyDesktopGateBaseline({ manifestPath, targetId, installerPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  const target = manifest.targets[targetId];
  if (!target) throw new Error(`pinned desktop baseline has no target named ${targetId}`);
  if (!existsSync(installerPath)) throw new Error(`pinned desktop baseline asset is missing: ${installerPath}`);
  if (basename(installerPath) !== target.asset) {
    throw new Error(`pinned desktop baseline asset name is ${basename(installerPath)}; expected ${target.asset}`);
  }
  const size = statSync(installerPath).size;
  if (size !== target.size) {
    throw new Error(`pinned desktop baseline asset size is ${size}; expected ${target.size}`);
  }
  const sha256 = await sha256File(installerPath);
  if (sha256 !== target.sha256) {
    throw new Error(`pinned desktop baseline asset SHA-256 is ${sha256}; expected ${target.sha256}`);
  }
  return {
    tag: manifest.tag,
    gitCommit: manifest.gitCommit,
    version: manifest.version,
    target: targetId,
    asset: target.asset,
    size,
    sha256,
    distFileCount: manifest.distInventory.fileCount,
    distInventorySha256: manifest.distInventory.sha256,
  };
}

function validateManifest(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "OpenGrove" ||
    !/^v\d+\.\d+\.\d+$/.test(manifest.tag ?? "") ||
    manifest.tag !== `v${manifest.version}` ||
    !/^[a-f0-9]{40}$/.test(manifest.gitCommit ?? "") ||
    !Number.isInteger(manifest.distInventory?.fileCount) ||
    manifest.distInventory.fileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.distInventory?.sha256 ?? "") ||
    !manifest.targets ||
    typeof manifest.targets !== "object"
  ) {
    throw new Error("invalid pinned desktop gate baseline manifest");
  }
  for (const [targetId, target] of Object.entries(manifest.targets)) {
    if (
      !/^(mac-(arm64|x64)|windows-x64)$/.test(targetId) ||
      typeof target.asset !== "string" ||
      basename(target.asset) !== target.asset ||
      !Number.isInteger(target.size) ||
      target.size < 1 ||
      !/^[a-f0-9]{64}$/.test(target.sha256 ?? "")
    ) {
      throw new Error(`invalid pinned desktop gate target: ${targetId}`);
    }
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyDesktopGateBaseline({
    manifestPath: resolve(args.manifest),
    targetId: args.target,
    installerPath: resolve(args.installer),
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `tag=${result.tag}`,
        `version=${result.version}`,
        `dist_file_count=${result.distFileCount}`,
        `dist_inventory_sha256=${result.distInventorySha256}`,
        `asset=${result.asset}`,
        "",
      ].join("\n"),
    );
  }
  console.log(`desktop gate baseline verified: ${result.target} ${result.asset} (${result.sha256})`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--manifest") result.manifest = readRequired(values, ++index, value);
    else if (value.startsWith("--manifest=")) result.manifest = value.slice("--manifest=".length);
    else if (value === "--target") result.target = readRequired(values, ++index, value);
    else if (value.startsWith("--target=")) result.target = value.slice("--target=".length);
    else if (value === "--installer") result.installer = readRequired(values, ++index, value);
    else if (value.startsWith("--installer=")) result.installer = value.slice("--installer=".length);
    else throw new Error(`Unknown desktop gate baseline option: ${value}`);
  }
  for (const required of ["manifest", "target", "installer"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
