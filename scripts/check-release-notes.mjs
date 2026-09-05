import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readLocalizedDesktopReleaseNotes } from "./release-note-format.mjs";

const releaseMode = process.argv.includes("--release");
const root = process.cwd();
const changelogPath = join(root, "CHANGELOG.md");
const packagePath = join(root, "package.json");
const releasesPath = join(root, "docs", "releases");

function fail(message) {
  console.error(`Release notes check failed: ${message}`);
  process.exit(1);
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function meaningfulBullets(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .filter((line) => !/^[-*]\s+\.{3}\s*$/.test(line));
}

function section(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${title}\\]?\\s*$`, "i").test(line.trim()));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

if (!existsSync(changelogPath)) {
  fail("CHANGELOG.md is missing. Add an Unreleased section before preparing a release.");
}
if (!existsSync(packagePath)) {
  fail("package.json is missing.");
}
if (!existsSync(releasesPath)) {
  fail("docs/releases is missing.");
}

const releaseFiles = readdirSync(releasesPath).filter((file) => /^v\d+\.\d+\.\d+(?:\.zh-CN)?\.md$/.test(file));
const releaseFileSet = new Set(releaseFiles);
const languageLinkErrors = [];

for (const file of releaseFiles) {
  const match = file.match(/^(v\d+\.\d+\.\d+)(\.zh-CN)?\.md$/);
  const tag = match[1];
  const isChinese = Boolean(match[2]);
  const counterpart = isChinese ? `${tag}.md` : `${tag}.zh-CN.md`;
  if (!releaseFileSet.has(counterpart)) {
    languageLinkErrors.push(`${file} is missing its paired ${counterpart}`);
    continue;
  }

  const markdown = readFileSync(join(releasesPath, file), "utf8");
  const languageLink = markdown.match(
    isChinese ? /\[English\]\(([^)]+)\)/ : /\[(?:Simplified Chinese|简体中文)\]\(([^)]+)\)/,
  );
  const tagExists = git(["rev-parse", "--verify", `refs/tags/${tag}`]) !== undefined;
  const counterpartExistsAtTag =
    tagExists && git(["cat-file", "-e", `${tag}:docs/releases/${counterpart}`]) !== undefined;
  const expectedRef = !tagExists || counterpartExistsAtTag ? tag : "main";
  const expectedTarget = `https://github.com/open-grove/opengrove/blob/${expectedRef}/docs/releases/${counterpart}`;

  if (!languageLink) {
    languageLinkErrors.push(`${file} does not link to ${counterpart}`);
  } else if (languageLink[1] !== expectedTarget) {
    languageLinkErrors.push(`${file} links to ${languageLink[1]}; expected ${expectedTarget}`);
  }
}

if (languageLinkErrors.length > 0) {
  fail(
    `release language links must use the immutable tag when the counterpart existed there, or main for a historical backfill:\n- ${languageLinkErrors.join("\n- ")}`,
  );
}

const changelog = readFileSync(changelogPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const version = String(packageJson.version || "").trim();
if (!version) fail("package.json does not contain a version.");

const latestTag = git(["describe", "--tags", "--abbrev=0"]);
const currentTag = `v${version}`;
const commitRange = latestTag ? `${latestTag}..HEAD` : "HEAD";
const commits = git(["log", "--oneline", commitRange]);
const status = git(["status", "--short"]);
const unreleased = section(changelog, "Unreleased");
const unreleasedEntries = unreleased ? meaningfulBullets(unreleased) : [];

const releaseNotePath = join(root, "docs", "releases", `${currentTag}.md`);
const localizedReleaseNotePath = join(root, "docs", "releases", `${currentTag}.zh-CN.md`);
const releaseNoteExists = existsSync(releaseNotePath);
const localizedReleaseNoteExists = existsSync(localizedReleaseNotePath);
const releaseNoteEntries = releaseNoteExists ? meaningfulBullets(readFileSync(releaseNotePath, "utf8")) : [];
const releaseNoteReady = latestTag !== currentTag && releaseNoteEntries.length > 0;

console.log("Release notes preflight");
console.log(`- package version: ${version}`);
console.log(`- latest tag: ${latestTag || "(none)"}`);
console.log(`- commits checked: ${commitRange}`);
console.log(`- working tree: ${status ? "has local changes" : "clean"}`);
if (commits) {
  console.log("");
  console.log(commits);
} else {
  console.log("- no commits found in range");
}
if (status) {
  console.log("");
  console.log(status);
}
console.log("");
console.log(`- CHANGELOG.md Unreleased entries: ${unreleasedEntries.length}`);
console.log(`- release note file: ${releaseNoteExists ? `docs/releases/${currentTag}.md` : "(missing)"}`);
console.log(
  `- localized release note file: ${localizedReleaseNoteExists ? `docs/releases/${currentTag}.zh-CN.md` : "(missing)"}`,
);
console.log(`- release note entries: ${releaseNoteEntries.length}`);

if (releaseMode) {
  if (latestTag === currentTag) {
    fail(
      `package.json is still at the latest released version (${currentTag}). Run npm version X.Y.Z --no-git-tag-version first.`,
    );
  }
  const releaseNumber = packageJson.clientReleaseNumber;
  if (!Number.isSafeInteger(releaseNumber) || releaseNumber <= 0) {
    fail("package.json clientReleaseNumber must be a positive safe integer.");
  }
  if (latestTag) {
    const previousPackageText = git(["show", `${latestTag}:package.json`]);
    let previousReleaseNumber;
    try {
      previousReleaseNumber = JSON.parse(previousPackageText ?? "").clientReleaseNumber;
    } catch {
      fail(`could not read clientReleaseNumber from ${latestTag}:package.json.`);
    }
    if (!Number.isSafeInteger(previousReleaseNumber) || releaseNumber <= previousReleaseNumber) {
      fail(`clientReleaseNumber must be greater than ${previousReleaseNumber} from ${latestTag}.`);
    }
  }
  if (!releaseNoteReady) {
    fail(`create docs/releases/${currentTag}.md with at least one meaningful bullet before release.`);
  }
  if (!localizedReleaseNoteExists) {
    fail(`create docs/releases/${currentTag}.zh-CN.md before release.`);
  }
  try {
    readLocalizedDesktopReleaseNotes(root, version);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log("Release note files are ready for the current package version.");
} else {
  if (unreleasedEntries.length === 0 && !releaseNoteReady) {
    fail(
      "add at least one entry to CHANGELOG.md under ## Unreleased, or prepare the current version release note after bumping.",
    );
  }
  console.log("Changelog buffer is ready. Compare the commit list above before drafting the release note.");
}
