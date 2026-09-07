import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const requiredDesktopReleaseGates = [
  "package_inventory",
  "final_artifact_smoke",
  "updater_metadata",
  "previous_version_update",
];

const canonicalTargetKeys = new Map([
  ["mac-arm64", "mac_arm64"],
  ["mac-x64", "mac_x64"],
  ["windows-x64", "windows_x64"],
]);

export async function writeDesktopReleaseGateReceipt({
  releaseDir,
  ciRunUrl,
  previousReleaseTag,
  generatedAt = new Date().toISOString(),
  outputPath = join(releaseDir, "release-gate-receipt.json"),
}) {
  const manifestPath = join(releaseDir, "desktop-release-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`release manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 3 ||
    typeof manifest.releaseNotesByLocale?.en !== "string" ||
    !manifest.releaseNotesByLocale.en.trim() ||
    typeof manifest.releaseNotesByLocale?.["zh-CN"] !== "string" ||
    !manifest.releaseNotesByLocale["zh-CN"].trim()
  ) {
    throw new Error("gate receipt requires validated en and zh-CN release notes in a schema v3 manifest");
  }
  if (manifest.partialRelease || manifest.installers?.length !== canonicalTargetKeys.size) {
    throw new Error("gate receipt requires one complete mac-arm64, mac-x64, windows-x64 release");
  }
  if (!/^https:\/\//.test(ciRunUrl ?? "")) throw new Error("gate receipt requires an HTTPS CI run URL");
  const source = manifest.source;
  const expectedGitTag = source?.expectedGitTag ?? source?.gitTag;
  if (!/^v\S+$/.test(expectedGitTag ?? "") || !/^[a-f0-9]{40}$/.test(source?.gitCommit ?? "")) {
    throw new Error("release manifest expected tag or source commit is invalid");
  }
  if (!/^v\S+$/.test(previousReleaseTag ?? "") || previousReleaseTag === expectedGitTag) {
    throw new Error("gate receipt requires the distinct previous formal release tag");
  }

  const evidenceRoot = join(releaseDir, "release-gates");
  const gates = {};
  for (const gate of requiredDesktopReleaseGates) {
    const targetEvidence = [];
    for (const target of canonicalTargetKeys.keys()) {
      const path = join(evidenceRoot, target, `${gate}.json`);
      if (!existsSync(path)) throw new Error(`${gate} evidence is missing for ${target}: ${path}`);
      const evidence = JSON.parse(readFileSync(path, "utf8"));
      const coversTarget = evidence.target === target || evidence.targets?.some((item) => item?.target === target);
      if (evidence.schemaVersion !== 1 || evidence.gate !== gate || evidence.passed !== true || !coversTarget) {
        throw new Error(`${gate} evidence is invalid for ${target}`);
      }
      targetEvidence.push({ target, path: relative(releaseDir, path).replaceAll("\\", "/"), evidence });
    }
    const aggregatePath = join(evidenceRoot, `${gate}.json`);
    writeJson(aggregatePath, { schemaVersion: 1, gate, passed: true, targets: targetEvidence });
    gates[gate] = { passed: true, evidence: relative(releaseDir, aggregatePath).replaceAll("\\", "/") };
  }

  const artifacts = {};
  for (const installer of manifest.installers) {
    const key = canonicalTargetKeys.get(installer.target);
    if (!key) throw new Error(`unexpected installer target in release manifest: ${installer.target}`);
    const path = join(releaseDir, installer.file);
    if (!existsSync(path) || statSync(path).size !== installer.size || (await sha256(path)) !== installer.sha256) {
      throw new Error(`installer no longer matches release manifest: ${installer.file}`);
    }
    artifacts[key] = { file: installer.file, size: installer.size, sha256: installer.sha256 };
  }

  const receipt = {
    schema_version: 3,
    version: manifest.version,
    client_release_number: manifest.clientReleaseNumber,
    expected_git_tag: expectedGitTag,
    git_commit: source.gitCommit,
    previous_release_tag: previousReleaseTag,
    release_notes_sha256: localizedReleaseNotesSha256(manifest.releaseNotesByLocale),
    ci_run_url: ciRunUrl,
    generated_at: new Date(generatedAt).toISOString(),
    gates,
    artifacts,
  };
  writeJson(outputPath, receipt);
  return receipt;
}

export function readDesktopReleaseGateReceipt(path) {
  if (!existsSync(path)) throw new Error(`desktop release gate receipt is missing: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const isLegacy = receipt.schema_version === 1;
  const expectedGitTag = isLegacy ? receipt.git_tag : receipt.expected_git_tag;
  if (
    ![1, 2, 3].includes(receipt.schema_version) ||
    !/^v\S+$/.test(expectedGitTag ?? "") ||
    !/^[a-f0-9]{40}$/.test(receipt.git_commit ?? "") ||
    !/^https:\/\//.test(receipt.ci_run_url ?? "") ||
    !Number.isFinite(Date.parse(receipt.generated_at ?? ""))
  ) {
    throw new Error("desktop release gate receipt header is invalid");
  }
  if (receipt.schema_version === 3 && !/^[a-f0-9]{64}$/.test(receipt.release_notes_sha256 ?? "")) {
    throw new Error("desktop release gate receipt has invalid localized release-note SHA-256");
  }
  if (
    !isLegacy &&
    (typeof receipt.version !== "string" ||
      expectedGitTag !== `v${receipt.version}` ||
      !Number.isSafeInteger(receipt.client_release_number) ||
      receipt.client_release_number <= 0 ||
      !/^v\S+$/.test(receipt.previous_release_tag ?? "") ||
      receipt.previous_release_tag === expectedGitTag)
  ) {
    throw new Error("desktop release gate receipt candidate identity is invalid");
  }
  for (const gate of requiredDesktopReleaseGates) {
    if (receipt.gates?.[gate]?.passed !== true || typeof receipt.gates[gate].evidence !== "string") {
      throw new Error(`desktop release gate receipt is missing passed gate ${gate}`);
    }
  }
  for (const key of canonicalTargetKeys.values()) {
    const artifact = receipt.artifacts?.[key];
    if (
      !artifact ||
      typeof artifact.file !== "string" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
    ) {
      throw new Error(`desktop release gate receipt has invalid artifact ${key}`);
    }
  }
  return receipt;
}

export function localizedReleaseNotesSha256(notes) {
  const hash = createHash("sha256");
  hash.update(notes.en, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(notes["zh-CN"], "utf8");
  return hash.digest("hex");
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

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
