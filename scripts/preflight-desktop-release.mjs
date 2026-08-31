import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAppleNotaryCredentials,
  windowsSigningConfigPresent,
  windowsSigningProblems,
} from "./desktop-release-credentials.mjs";
import { macReleaseToolProblems } from "./desktop-release-preflight-tools.mjs";
import { readDesktopReleaseCandidateSource } from "./desktop-release-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const problems = [];

checkReleaseSource();
if (process.platform === "darwin") {
  problems.push(...macReleaseToolProblems());
  checkMacSigning();
  try {
    resolveAppleNotaryCredentials();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
} else if (process.platform === "win32") {
  const signingProblems = windowsSigningProblems();
  if (process.env.OPENGROVE_ALLOW_UNSIGNED_WINDOWS === "1") {
    const presentConfig = windowsSigningConfigPresent();
    if (presentConfig.length > 0) {
      problems.push(
        `OPENGROVE_ALLOW_UNSIGNED_WINDOWS=1 only covers a machine with no signing configuration at all; unset ${presentConfig.join(", ")} or drop the escape hatch and sign strictly`,
      );
    } else {
      console.warn(
        "preflight-desktop-release: OPENGROVE_ALLOW_UNSIGNED_WINDOWS=1 — building an UNSIGNED Windows release candidate:",
      );
      for (const problem of signingProblems) console.warn(`  ! ${problem}`);
    }
  } else {
    problems.push(...signingProblems);
  }
} else {
  problems.push(
    `desktop release candidates are only supported on macOS or Windows; current platform: ${process.platform}`,
  );
}

if (problems.length > 0) {
  console.error("Desktop release preflight failed:\n");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    "\nSee docs/development/RELEASE_PROCESS.md. " +
      "Use npm run pack:desktop or npm run dist:desktop for ad-hoc-signed internal builds.",
  );
  process.exit(1);
}

console.log(
  `preflight-desktop-release: ${packageJson.version} source, release tools, signing, and notarization checks passed.`,
);

function checkReleaseSource() {
  try {
    readDesktopReleaseCandidateSource(projectRoot, packageJson.version);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

function checkMacSigning() {
  const cscLink = process.env.CSC_LINK;
  const cscPassword = process.env.CSC_KEY_PASSWORD;
  if (cscLink || cscPassword) {
    if (!cscLink) problems.push("CSC_KEY_PASSWORD is set but CSC_LINK is missing");
    if (!cscPassword) problems.push("CSC_LINK is set but CSC_KEY_PASSWORD is missing");
    if (cscLink && !cscLink.startsWith("data:") && !isLikelyBase64(cscLink) && !existsSync(cscLink)) {
      problems.push(`CSC_LINK file does not exist: ${cscLink}`);
    }
    return;
  }
  const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!identities?.includes("Developer ID Application")) {
    problems.push("no Developer ID Application identity was found and CSC_LINK + CSC_KEY_PASSWORD are not configured");
  }
}

function capture(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

function isLikelyBase64(value) {
  return value.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}
