import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readDesktopReleaseGateReceipt, requiredDesktopReleaseGates } from "./desktop-release-gate-receipt.mjs";

const args = parseArgs(process.argv.slice(2));
const releaseDir = resolve(args.releaseDir);
const receipt = readDesktopReleaseGateReceipt(join(releaseDir, "release-gate-receipt.json"));
const manifest = JSON.parse(readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8"));
const expectedGitTag = manifest.source?.expectedGitTag ?? manifest.source?.gitTag;

if (receipt.schema_version !== 2) fail("candidate finalization requires a schema v2 gate receipt");
if (args.currentReleaseTag !== receipt.previous_release_tag && args.currentReleaseTag !== args.expectedTag) {
  fail(
    `Latest formal release changed from ${receipt.previous_release_tag} to ${args.currentReleaseTag}` +
      " after candidate gating; rebuild the candidate against the new N-1 release.",
  );
}
if (
  receipt.git_commit !== args.commit ||
  receipt.expected_git_tag !== args.expectedTag ||
  receipt.ci_run_url !== args.ciRunUrl ||
  receipt.version !== manifest.version ||
  receipt.client_release_number !== manifest.clientReleaseNumber ||
  manifest.source?.gitCommit !== args.commit ||
  expectedGitTag !== args.expectedTag
) {
  fail("candidate identity does not match the requested commit, tag, or Actions run");
}

const receiptKeys = { "mac-arm64": "mac_arm64", "mac-x64": "mac_x64", "windows-x64": "windows_x64" };
if (manifest.partialRelease || manifest.installers?.length !== Object.keys(receiptKeys).length) {
  fail("candidate finalization requires all canonical installers");
}
for (const installer of manifest.installers) {
  const receiptArtifact = receipt.artifacts[receiptKeys[installer.target]];
  const path = join(releaseDir, installer.file);
  if (
    !receiptArtifact ||
    receiptArtifact.file !== installer.file ||
    receiptArtifact.size !== installer.size ||
    receiptArtifact.sha256 !== installer.sha256 ||
    !existsSync(path) ||
    statSync(path).size !== installer.size ||
    (await sha256(path)) !== installer.sha256
  ) {
    fail(`candidate installer bytes do not match the gate receipt: ${installer.target}`);
  }
}

const expectedTargets = new Set(Object.keys(receiptKeys));
for (const gate of requiredDesktopReleaseGates) {
  const evidencePath = resolve(releaseDir, receipt.gates[gate].evidence);
  if (relative(releaseDir, evidencePath).startsWith("..") || !existsSync(evidencePath)) {
    fail(`candidate gate evidence is outside or missing from the artifact: ${gate}`);
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const coveredTargets = new Set(evidence.targets?.map((item) => item?.target));
  if (
    evidence.schemaVersion !== 1 ||
    evidence.gate !== gate ||
    evidence.passed !== true ||
    [...expectedTargets].some((target) => !coveredTargets.has(target))
  ) {
    fail(`candidate gate evidence is invalid: ${gate}`);
  }
}

console.log(`verified candidate ${args.expectedTag}@${args.commit.slice(0, 12)} from ${args.ciRunUrl}`);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const [name, inlineValue] = value.split("=", 2);
    const next = inlineValue ?? values[++index];
    if (!next || (!inlineValue && next.startsWith("--"))) fail(`${name} requires a value`);
    if (name === "--release-dir") result.releaseDir = next;
    else if (name === "--commit") result.commit = next.toLowerCase();
    else if (name === "--expected-tag") result.expectedTag = next;
    else if (name === "--current-release-tag") result.currentReleaseTag = next;
    else if (name === "--ci-run-url") result.ciRunUrl = next;
    else fail(`unknown candidate verification option: ${name}`);
  }
  if (
    !result.releaseDir ||
    !/^[a-f0-9]{40}$/.test(result.commit ?? "") ||
    !/^v\S+$/.test(result.expectedTag ?? "") ||
    !/^v\S+$/.test(result.currentReleaseTag ?? "") ||
    !/^https:\/\//.test(result.ciRunUrl ?? "")
  ) {
    fail(
      "candidate verification requires release-dir, full commit, expected tag, current release tag, and HTTPS CI run URL",
    );
  }
  return result;
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

function fail(message) {
  throw new Error(message);
}
