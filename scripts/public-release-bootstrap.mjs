import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultManifestPath = resolve(import.meta.dirname, "fixtures", "public-release-bootstrap-v0.6.5.json");
const targetSuffixes = Object.freeze({
  "mac-arm64": "mac-arm64.dmg",
  "mac-x64": "mac-x64.dmg",
  "windows-x64": "win-x64.exe",
});

export function readPublicReleaseBootstrap(path = defaultManifestPath) {
  return validatePublicReleaseBootstrap(JSON.parse(readFileSync(path, "utf8")));
}

export function validatePublicReleaseBootstrap(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("public release bootstrap manifest must use schema version 1");
  }
  if (!isVersionTag(value.firstPublicReleaseTag) || !isVersionTag(value.previousReleaseTag)) {
    throw new Error("public release bootstrap tags must be semantic version tags");
  }
  if (!isNewerVersion(value.firstPublicReleaseTag, value.previousReleaseTag)) {
    throw new Error("first public release tag must be newer than the bootstrap release tag");
  }

  const version = value.previousReleaseTag.slice(1);
  const assets = {};
  for (const [target, suffix] of Object.entries(targetSuffixes)) {
    const asset = value.assets?.[target];
    const expectedFile = `OpenGrove-${version}-${suffix}`;
    if (
      !asset ||
      asset.file !== expectedFile ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")
    ) {
      throw new Error(`public release bootstrap asset is invalid: ${target}`);
    }
    assets[target] = Object.freeze({ file: asset.file, size: asset.size, sha256: asset.sha256 });
  }

  return Object.freeze({
    schemaVersion: 1,
    firstPublicReleaseTag: value.firstPublicReleaseTag,
    previousReleaseTag: value.previousReleaseTag,
    assets: Object.freeze(assets),
  });
}

export function resolvePublicReleaseBootstrap(expectedTag, manifest = readPublicReleaseBootstrap()) {
  if (expectedTag !== manifest.firstPublicReleaseTag) {
    throw new Error(
      `first-public-release bootstrap is only valid for ${manifest.firstPublicReleaseTag}, received ${expectedTag}`,
    );
  }
  return manifest;
}

export async function downloadPublicReleaseBootstrapInstaller({
  expectedTag,
  target,
  publicRoot,
  outputDir,
  manifest = readPublicReleaseBootstrap(),
  fetchImpl = fetch,
}) {
  const bootstrap = resolvePublicReleaseBootstrap(expectedTag, manifest);
  const asset = bootstrap.assets[target];
  if (!asset) throw new Error(`unsupported public release bootstrap target: ${target}`);

  const root = new URL(publicRoot);
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash) {
    throw new Error("public release bootstrap root must be a credential-free HTTPS URL");
  }
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  const assetUrl = new URL(`${bootstrap.previousReleaseTag}/${asset.file}`, root);
  if (assetUrl.origin !== root.origin || !assetUrl.pathname.startsWith(root.pathname)) {
    throw new Error("public release bootstrap asset escaped the configured release root");
  }

  mkdirSync(outputDir, { recursive: true });
  const destination = join(outputDir, asset.file);
  const partial = `${destination}.part-${process.pid}`;
  try {
    const response = await fetchImpl(assetUrl, {
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60 * 1_000),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`bootstrap installer request failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) !== asset.size) {
      await response.body.cancel().catch(() => {});
      throw new Error(`bootstrap installer Content-Length does not match ${target}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    if (statSync(partial).size !== asset.size || (await sha256(partial)) !== asset.sha256) {
      throw new Error(`bootstrap installer bytes do not match the reviewed ${target} identity`);
    }
    renameSync(partial, destination);
    return destination;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

function isVersionTag(value) {
  return /^v\d+\.\d+\.\d+$/.test(value ?? "");
}

function isNewerVersion(current, previous) {
  const currentParts = current.slice(1).split(".").map(Number);
  const previousParts = previous.slice(1).split(".").map(Number);
  for (let index = 0; index < currentParts.length; index += 1) {
    if (currentParts[index] !== previousParts[index]) return currentParts[index] > previousParts[index];
  }
  return false;
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--")) throw new Error(`unsupported argument: ${name}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[name.slice(2)] = value;
  }
  return { command, options };
}

async function runCli() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "previous-tag") {
    const bootstrap = resolvePublicReleaseBootstrap(options["expected-tag"]);
    process.stdout.write(bootstrap.previousReleaseTag);
    return;
  }
  if (command === "download") {
    for (const required of ["expected-tag", "target", "public-root", "output-dir", "github-output"]) {
      if (!options[required]) throw new Error(`--${required} is required`);
    }
    const installer = await downloadPublicReleaseBootstrapInstaller({
      expectedTag: options["expected-tag"],
      target: options.target,
      publicRoot: options["public-root"],
      outputDir: options["output-dir"],
    });
    appendFileSync(options["github-output"], `installer=${installer}\n`);
    return;
  }
  throw new Error("expected previous-tag or download command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
