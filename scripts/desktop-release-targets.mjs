import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function desktopReleaseTargets(version) {
  return [
    {
      id: "mac-arm64",
      platform: "mac",
      buildPlatform: "darwin",
      arch: "arm64",
      installerKind: "dmg",
      installerFile: `OpenGrove-${version}-mac-arm64.dmg`,
      updaterFile: `OpenGrove-${version}-mac-arm64.zip`,
      updaterFeed: "latest-mac.yml",
    },
    {
      id: "mac-x64",
      platform: "mac",
      buildPlatform: "darwin",
      arch: "x64",
      installerKind: "dmg",
      installerFile: `OpenGrove-${version}-mac-x64.dmg`,
      updaterFile: `OpenGrove-${version}-mac-x64.zip`,
      updaterFeed: "latest-mac.yml",
    },
    {
      id: "windows-x64",
      platform: "windows",
      buildPlatform: "win32",
      arch: "x64",
      installerKind: "nsis",
      installerFile: `OpenGrove-${version}-win-x64.exe`,
      updaterFile: `OpenGrove-${version}-win-x64.exe`,
      updaterFeed: "latest.yml",
    },
  ].map((target) => ({ ...target, updaterBlockmap: `${target.updaterFile}.blockmap` }));
}

export function desktopReleaseWebBuildId(version, gitCommit) {
  if (!/^[a-f0-9]{40}$/i.test(gitCommit ?? ""))
    throw new Error("desktop release web build id requires a full Git commit");
  const normalizedVersion = String(version ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
  if (!normalizedVersion) throw new Error("desktop release web build id requires a version");
  return `release-${normalizedVersion}-${gitCommit.slice(0, 12).toLowerCase()}`;
}

export function availableDesktopReleaseTargets(releaseDir, version) {
  return desktopReleaseTargets(version).filter(
    (target) => existsSync(join(releaseDir, target.installerFile)) || existsSync(join(releaseDir, target.updaterFile)),
  );
}

export async function writeDesktopReleaseSourceManifests({ projectRoot, releaseDir, targetIds }) {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const source = readDesktopReleaseCandidateSource(projectRoot, packageJson.version);
  const targets = desktopReleaseTargets(packageJson.version).filter((target) => targetIds.includes(target.id));
  if (targets.length !== targetIds.length) throw new Error(`unknown desktop release target: ${targetIds.join(", ")}`);
  const sourceDir = join(releaseDir, "release-source");
  mkdirSync(sourceDir, { recursive: true });

  for (const target of targets) {
    const required = [...new Set([target.installerFile, target.updaterFile])];
    const missing = required.filter((file) => !existsSync(join(releaseDir, file)));
    if (missing.length > 0) throw new Error(`${target.id} release artifacts are incomplete: ${missing.join(", ")}`);
    const files = [...required, target.updaterBlockmap].filter((file) => existsSync(join(releaseDir, file)));
    const artifacts = [];
    for (const file of files) {
      const path = join(releaseDir, file);
      artifacts.push({ file, size: statSync(path).size, sha256: await hashFile(path) });
    }
    const manifest = {
      schemaVersion: 2,
      product: "OpenGrove",
      version: packageJson.version,
      clientReleaseNumber: packageJson.clientReleaseNumber,
      target: target.id,
      gitCommit: source.gitCommit,
      expectedGitTag: source.expectedGitTag,
      releasedAt: source.releasedAt,
      artifacts,
    };
    writeJsonAtomic(join(sourceDir, `${target.id}.json`), manifest);
  }
  return source;
}

export async function validateDesktopReleaseSourceManifests({ releaseDir, packageJson, targets }) {
  const expectedTag = `v${packageJson.version}`;
  const manifests = [];
  for (const target of targets) {
    const path = join(releaseDir, "release-source", `${target.id}.json`);
    if (!existsSync(path)) throw new Error(`missing release source manifest: ${path}`);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const manifestExpectedTag = manifest.schemaVersion === 1 ? manifest.gitTag : manifest.expectedGitTag;
    if (
      ![1, 2].includes(manifest.schemaVersion) ||
      manifest.product !== "OpenGrove" ||
      manifest.version !== packageJson.version ||
      manifest.clientReleaseNumber !== packageJson.clientReleaseNumber ||
      manifest.target !== target.id ||
      manifestExpectedTag !== expectedTag ||
      !/^[a-f0-9]{40}$/i.test(manifest.gitCommit ?? "") ||
      !Number.isFinite(Date.parse(manifest.releasedAt ?? "")) ||
      !Array.isArray(manifest.artifacts)
    ) {
      throw new Error(`invalid release source manifest for ${target.id}`);
    }
    const required = [...new Set([target.installerFile, target.updaterFile])];
    for (const file of required) {
      if (!manifest.artifacts.some((artifact) => artifact.file === file)) {
        throw new Error(`${target.id} source manifest is missing ${file}`);
      }
    }
    for (const artifact of manifest.artifacts) {
      if (typeof artifact.file !== "string" || artifact.file.includes("/") || artifact.file.includes("\\")) {
        throw new Error(`${target.id} source manifest contains an invalid artifact path`);
      }
      const artifactPath = join(releaseDir, artifact.file);
      if (!existsSync(artifactPath)) throw new Error(`${target.id} source artifact is missing: ${artifact.file}`);
      const size = statSync(artifactPath).size;
      const sha256 = await hashFile(artifactPath);
      if (artifact.size !== size || artifact.sha256 !== sha256) {
        throw new Error(`${target.id} source artifact does not match its manifest: ${artifact.file}`);
      }
    }
    manifests.push({ ...manifest, expectedGitTag: manifestExpectedTag });
  }

  const first = manifests[0];
  for (const manifest of manifests.slice(1)) {
    if (
      manifest.gitCommit !== first.gitCommit ||
      manifest.expectedGitTag !== first.expectedGitTag ||
      manifest.releasedAt !== first.releasedAt
    ) {
      throw new Error("desktop release targets come from different commits or expected release tags");
    }
  }
  return {
    gitCommit: first.gitCommit,
    expectedGitTag: first.expectedGitTag,
    releasedAt: first.releasedAt,
    targets: manifests.map((manifest) => manifest.target),
  };
}

export function readDesktopReleaseCandidateSource(projectRoot, version) {
  const status = git(projectRoot, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("desktop release candidates require a clean Git working tree");
  const gitCommit = git(projectRoot, ["rev-parse", "HEAD"]).trim();
  const expectedGitTag = `v${version}`;
  const configuredExpectedGitTag = process.env.OPENGROVE_EXPECTED_RELEASE_TAG?.trim();
  if (configuredExpectedGitTag && configuredExpectedGitTag !== expectedGitTag) {
    throw new Error(`candidate expected tag ${configuredExpectedGitTag} does not match package version ${version}`);
  }
  const releasedAt = new Date(git(projectRoot, ["show", "-s", "--format=%cI", "HEAD"]).trim()).toISOString();
  return { gitCommit, expectedGitTag, releasedAt };
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function readTaggedReleaseSource(projectRoot, version) {
  const status = git(projectRoot, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("formal desktop releases require a clean Git working tree");
  const gitCommit = git(projectRoot, ["rev-parse", "HEAD"]).trim();
  const gitTag = `v${version}`;
  const tags = git(projectRoot, ["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((item) => item.trim());
  if (!tags.includes(gitTag)) throw new Error(`formal desktop releases must be built from ${gitTag}`);
  const releasedAt = new Date(git(projectRoot, ["show", "-s", "--format=%cI", "HEAD"]).trim()).toISOString();
  return { gitCommit, gitTag, releasedAt };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}
