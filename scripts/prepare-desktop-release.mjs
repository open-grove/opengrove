import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableDesktopReleaseTargets,
  desktopReleaseTargets,
  validateDesktopReleaseSourceManifests,
} from "./desktop-release-targets.mjs";
import { crc64XzFile } from "./crc64-xz.mjs";
import { runParallelTasks } from "./parallel-release-tasks.mjs";
import {
  hashRemoteFile,
  readRemoteFileMetadata,
  releaseRequestSignal,
  releaseVerificationProxyHosts,
} from "./release-network.mjs";
import { formatReleaseBytes, openReleaseTiming } from "./release-timing.mjs";
import { readDesktopReleaseGateReceipt } from "./desktop-release-gate-receipt.mjs";
import { readDesktopReleasePackageIdentity } from "./desktop-release-package-identity.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const releasePackageJsonPath = resolve(args.releasePackageJson ?? join(projectRoot, "package.json"));
const packageJson = readDesktopReleasePackageIdentity(releasePackageJsonPath);

if (args.help) {
  printHelp();
  process.exit(0);
}

const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const updaterOutputDir = resolve(
  args.updaterOutputDir ?? process.env.OPENGROVE_DESKTOP_RELEASE_UPDATER_DIR ?? join(releaseDir, "updater"),
);
const publicBaseUrl = requiredBaseUrl(
  args.publicBaseUrl ??
    process.env.OPENGROVE_DESKTOP_RELEASE_PUBLIC_BASE_URL ??
    process.env.OPENGROVE_DESKTOP_RELEASE_BASE_URL,
  "--public-base-url / OPENGROVE_DESKTOP_RELEASE_PUBLIC_BASE_URL",
);
const updaterBaseUrl = requiredBaseUrl(
  args.updaterBaseUrl ?? process.env.OPENGROVE_DESKTOP_RELEASE_UPDATER_BASE_URL,
  "--updater-base-url / OPENGROVE_DESKTOP_RELEASE_UPDATER_BASE_URL",
);
const copyTo = args.copyTo ?? process.env.OPENGROVE_DESKTOP_RELEASE_UPLOAD_DIR ?? "";
const rawRegisterUrl = args.registerUrl ?? process.env.OPENGROVE_CLIENT_RELEASES_URL ?? "";
const registerUrl = rawRegisterUrl
  ? requiredBaseUrl(rawRegisterUrl, "--register-url / OPENGROVE_CLIENT_RELEASES_URL")
  : "";
const token = process.env.OPENGROVE_RELEASE_UPLOAD_TOKEN ?? "";
const releaseNotes = args.releaseNotes ?? releaseNotesSummary(packageJson.version);
const verifyConcurrency = positiveInteger(
  args.verifyConcurrency ?? process.env.OPENGROVE_RELEASE_VERIFY_CONCURRENCY ?? "16",
  "--verify-concurrency / OPENGROVE_RELEASE_VERIFY_CONCURRENCY",
);
const timing = args.timingFile
  ? openReleaseTiming({
      path: args.timingFile,
      command: "publish:desktop-release",
      version: packageJson.version,
      configuration: { verifyConcurrency },
    })
  : null;

if (!existsSync(releaseDir)) fail(`desktop release directory does not exist: ${releaseDir}`);
const allTargets = desktopReleaseTargets(packageJson.version);
const manifestPath = resolve(args.out ?? join(releaseDir, "desktop-release-manifest.json"));
const latestPath = resolve(args.latestOut ?? join(releaseDir, "client-latest-version.json"));
let targets;
let source;
let releasedAt;
let installers;
let updaterFiles;
let latestVersion;
let partialRelease;
let publicChecksumsPath;
let updaterChecksumsPath;

if (args.reusePreparedMetadata) {
  if (copyTo) fail("--reuse-prepared-metadata cannot be combined with --copy-to");
  const phaseId = timing?.startPhase("load-prepared-release-metadata");
  try {
    ({ targets, source, releasedAt, installers, updaterFiles, latestVersion, partialRelease } =
      loadPreparedReleaseMetadata(manifestPath));
    timing?.finishPhase(phaseId);
  } catch (error) {
    timing?.finishPhase(phaseId, { status: "failed", error });
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`Reused prepared release metadata from ${manifestPath}`);
} else {
  targets = availableDesktopReleaseTargets(releaseDir, packageJson.version);
  if (targets.length === 0) fail(`no desktop release artifacts found in ${releaseDir}`);
  for (const target of targets) {
    for (const file of new Set([target.installerFile, target.updaterFile])) {
      if (!existsSync(join(releaseDir, file))) fail(`${target.id} release is incomplete; missing ${file}`);
    }
  }
  validatePublicArtifactLayout(allTargets);

  source = await validateDesktopReleaseSourceManifests({ releaseDir, packageJson, targets });
  if (args.releasedAt && new Date(args.releasedAt).toISOString() !== source.releasedAt) {
    fail(`--released-at must match the source manifest timestamp ${source.releasedAt}`);
  }
  releasedAt = source.releasedAt;

  runPreparePayload(releasedAt);
  installers = await collectInstallers(targets, publicBaseUrl);
  updaterFiles = await collectAndValidateUpdaterFiles(targets, updaterBaseUrl);
  latestVersion = latestVersionPayload(installers, updaterFiles, updaterBaseUrl, releasedAt, releaseNotes);
  partialRelease = targets.length !== allTargets.length;
  ({ publicChecksumsPath, updaterChecksumsPath } = writeChecksums(installers, updaterFiles));

  const releaseManifest = {
    schemaVersion: 2,
    product: "OpenGrove",
    version: packageJson.version,
    clientReleaseNumber: packageJson.clientReleaseNumber,
    releasedAt,
    source,
    publicDownloadBaseUrl: publicBaseUrl,
    updaterBaseUrl,
    installers,
    updaterFiles: updaterFiles.map(({ sourcePath: _sourcePath, ...file }) => file),
    latestVersion,
    partialRelease,
  };
  writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
  writeFileSync(latestPath, `${JSON.stringify(latestVersion, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
  console.log(`Wrote ${latestPath}`);
  console.log(`Incremental release targets: ${targets.map((target) => target.id).join(", ")}`);

  if (copyTo) {
    copyReleasePayload({
      destination: resolve(copyTo),
      targets,
      installers,
      updaterFiles,
      manifestPath,
      latestPath,
      publicChecksumsPath,
      updaterChecksumsPath,
    });
  }
}

if (registerUrl && partialRelease) {
  fail("ww registration requires all three canonical targets and cannot register a partial platform release");
} else if (registerUrl) {
  await verifyRemotePayload(installers, updaterFiles);
  const receiptPath = resolve(args.gateReceipt ?? join(releaseDir, "release-gate-receipt.json"));
  const gateReceipt = readDesktopReleaseGateReceipt(receiptPath);
  validateGateReceiptForRelease(gateReceipt, source, installers);
  const phaseId = timing?.startPhase("ww-registration", { url: registerUrl });
  try {
    const response = await fetch(registerUrl, {
      method: "POST",
      signal: releaseRequestSignal(),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ release: latestVersion, gate_receipt: gateReceipt }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `client release registration failed: HTTP ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`,
      );
    }
    timing?.finishPhase(phaseId);
    console.log(`Registered gated client release with ${registerUrl}; active pointer was not changed.`);
  } catch (error) {
    timing?.finishPhase(phaseId, { status: "failed", error });
    fail(error instanceof Error ? error.message : String(error));
  }
} else if (args.verifyRemote) {
  await verifyRemotePayload(installers, updaterFiles);
  console.log("Verified all remote release files against local metadata.");
} else {
  console.log(
    "Release metadata is ready. Upload GitHub and updater assets, then rerun with --register-url for remote verification and candidate registration.",
  );
}

function validateGateReceiptForRelease(receipt, sourceValue, installersValue) {
  const expectedGitTag = sourceValue.expectedGitTag ?? sourceValue.gitTag;
  const receiptExpectedGitTag = receipt.expected_git_tag ?? receipt.git_tag;
  if (receiptExpectedGitTag !== expectedGitTag || receipt.git_commit !== sourceValue.gitCommit) {
    fail("gate receipt expected tag/commit does not match the release manifest");
  }
  if (
    receipt.schema_version === 2 &&
    (receipt.version !== packageJson.version || receipt.client_release_number !== packageJson.clientReleaseNumber)
  ) {
    fail("gate receipt version identity does not match package.json");
  }
  const keyByTarget = { "mac-arm64": "mac_arm64", "mac-x64": "mac_x64", "windows-x64": "windows_x64" };
  for (const installer of installersValue) {
    const artifact = receipt.artifacts[keyByTarget[installer.target]];
    if (
      !artifact ||
      artifact.file !== installer.file ||
      artifact.size !== installer.size ||
      artifact.sha256 !== installer.sha256
    ) {
      fail(`gate receipt installer does not match release metadata: ${installer.target}`);
    }
  }
  const expectedTargets = new Set(installersValue.map((installer) => installer.target));
  for (const [gate, record] of Object.entries(receipt.gates)) {
    const evidencePath = resolve(releaseDir, record.evidence);
    const evidenceRelativePath = relative(releaseDir, evidencePath);
    if (evidenceRelativePath.startsWith("..") || !existsSync(evidencePath)) {
      fail(`gate receipt evidence is outside or missing from the release directory: ${gate}`);
    }
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const coveredTargets = new Set(evidence.targets?.map((item) => item?.target));
    if (
      evidence.schemaVersion !== 1 ||
      evidence.gate !== gate ||
      evidence.passed !== true ||
      [...expectedTargets].some((target) => !coveredTargets.has(target))
    ) {
      fail(`gate receipt aggregate evidence is invalid: ${gate}`);
    }
  }
}

function loadPreparedReleaseMetadata(path) {
  if (!existsSync(path)) fail(`prepared release manifest does not exist: ${path}`);
  const manifestBytes = readFileSync(path);
  const actualManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/.test(args.expectedPreparedManifestSha256 ?? "") ||
    actualManifestSha256 !== args.expectedPreparedManifestSha256
  ) {
    fail("prepared release manifest changed after publication planning");
  }
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.product !== "OpenGrove" ||
    manifest.version !== packageJson.version ||
    manifest.clientReleaseNumber !== packageJson.clientReleaseNumber ||
    manifest.publicDownloadBaseUrl !== publicBaseUrl ||
    manifest.updaterBaseUrl !== updaterBaseUrl ||
    !Number.isFinite(Date.parse(manifest.releasedAt ?? "")) ||
    !Array.isArray(manifest.installers) ||
    !Array.isArray(manifest.updaterFiles) ||
    typeof manifest.latestVersion !== "object" ||
    !manifest.latestVersion
  ) {
    fail("prepared release manifest does not match this package or publication destination");
  }
  const targetById = new Map(allTargets.map((target) => [target.id, target]));
  const preparedTargets = manifest.installers.map((installer) => targetById.get(installer.target));
  if (preparedTargets.some((target) => !target)) fail("prepared release manifest contains an unknown target");
  const preparedUpdaterFiles = manifest.updaterFiles.map((file) => {
    const sourcePath = preparedSourcePath(file);
    if (!existsSync(sourcePath) || statSync(sourcePath).size !== file.size) {
      fail(`prepared updater source is missing or has the wrong size: ${file.file}`);
    }
    return { ...file, sourcePath };
  });
  for (const installer of manifest.installers) {
    const path = join(releaseDir, installer.file);
    if (!existsSync(path) || statSync(path).size !== installer.size) {
      fail(`prepared installer is missing or has the wrong size: ${installer.file}`);
    }
  }
  if (JSON.stringify(JSON.parse(readFileSync(latestPath, "utf8"))) !== JSON.stringify(manifest.latestVersion)) {
    fail("prepared latest-version payload does not match the release manifest");
  }
  return {
    targets: preparedTargets,
    source: manifest.source,
    releasedAt: manifest.releasedAt,
    installers: manifest.installers,
    updaterFiles: preparedUpdaterFiles,
    latestVersion: manifest.latestVersion,
    partialRelease: manifest.partialRelease === true,
  };
}

function preparedSourcePath(file) {
  if (!["release", "updater"].includes(file.source) || typeof file.sourceFile !== "string") {
    fail(`prepared updater source is invalid: ${file.file ?? "unknown file"}`);
  }
  const root = file.source === "release" ? releaseDir : updaterOutputDir;
  const path = resolve(root, ...file.sourceFile.split("/"));
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail(`prepared updater source escapes its root: ${file.sourceFile}`);
  }
  return path;
}

function runPreparePayload(timestamp) {
  console.log(
    `\n$ node scripts/prepare-desktop-update-payload.mjs --release-dir ${releaseDir} --output-dir ${updaterOutputDir} --released-at ${timestamp}`,
  );
  execFileSync(
    process.execPath,
    [
      join(projectRoot, "scripts", "prepare-desktop-update-payload.mjs"),
      "--release-dir",
      releaseDir,
      "--output-dir",
      updaterOutputDir,
      "--released-at",
      timestamp,
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
}

function validatePublicArtifactLayout(specs) {
  const expected = new Set(specs.flatMap((target) => [target.installerFile, target.updaterFile]));
  const candidates = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(dmg|zip|exe|AppImage)$/i.test(entry.name))
    .map((entry) => entry.name);
  const unexpected = candidates.filter((file) => !expected.has(file));
  if (unexpected.length > 0) fail(`unexpected desktop release artifacts: ${unexpected.join(", ")}`);
}

async function collectInstallers(targetsValue, baseUrl) {
  const result = [];
  for (const target of targetsValue) {
    const path = join(releaseDir, target.installerFile);
    const [sha256, crc64] = await Promise.all([hashFile(path, "sha256", "hex"), crc64XzFile(path)]);
    result.push({
      target: target.id,
      file: target.installerFile,
      platform: target.platform,
      arch: target.arch,
      kind: target.installerKind,
      size: statSync(path).size,
      sha256,
      crc64,
      downloadUrl: joinUrl(baseUrl, target.installerFile),
    });
  }
  return result;
}

async function collectAndValidateUpdaterFiles(targetsValue, baseUrl) {
  const result = [];
  for (const target of targetsValue) {
    const targetDir = join(updaterOutputDir, target.id);
    if (!existsSync(targetDir)) fail(`missing updater target directory: ${target.id}`);
    const expected = new Set([target.updaterFeed]);
    const actual = readdirSync(targetDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const unexpected = actual.filter((file) => !expected.has(file));
    if (unexpected.length > 0)
      fail(`${target.id} updater directory contains unexpected files: ${unexpected.join(", ")}`);
    if (!actual.includes(target.updaterFeed)) fail(`${target.id} updater payload is missing ${target.updaterFeed}`);

    const payloadPath = join(releaseDir, target.updaterFile);
    const payloadSha512 = await hashFile(payloadPath, "sha512", "base64");
    const feedPath = join(targetDir, target.updaterFeed);
    const feed = load(readFileSync(feedPath, "utf8"));
    const feedFile = Array.isArray(feed?.files) ? feed.files[0] : undefined;
    if (
      feed?.version !== packageJson.version ||
      feed?.path !== target.updaterFile ||
      feed?.sha512 !== payloadSha512 ||
      feed?.files?.length !== 1 ||
      feedFile?.url !== target.updaterFile ||
      feedFile?.sha512 !== payloadSha512 ||
      feedFile?.size !== statSync(payloadPath).size ||
      feed?.releaseDate !== releasedAt
    ) {
      fail(`${target.id} updater feed does not match its payload or release source`);
    }

    const logicalFiles = [
      {
        file: target.updaterFeed,
        source: "updater",
        sourceFile: `${target.id}/${target.updaterFeed}`,
        sourcePath: feedPath,
      },
      { file: target.updaterFile, source: "release", sourceFile: target.updaterFile, sourcePath: payloadPath },
      ...(existsSync(join(releaseDir, target.updaterBlockmap))
        ? [
            {
              file: target.updaterBlockmap,
              source: "release",
              sourceFile: target.updaterBlockmap,
              sourcePath: join(releaseDir, target.updaterBlockmap),
            },
          ]
        : []),
    ];
    for (const { file, source, sourceFile, sourcePath } of logicalFiles.sort((left, right) =>
      left.file.localeCompare(right.file),
    )) {
      const [sha256, crc64] = await Promise.all([hashFile(sourcePath, "sha256", "hex"), crc64XzFile(sourcePath)]);
      result.push({
        target: target.id,
        file: `updater/${target.id}/${file}`,
        relativePath: `${target.id}/${file}`,
        platform: target.platform,
        arch: target.arch,
        kind: file === target.updaterFeed ? "feed" : file === target.updaterBlockmap ? "blockmap" : "payload",
        size: statSync(sourcePath).size,
        sha256,
        crc64,
        downloadUrl: joinUrl(baseUrl, target.id, file),
        source,
        sourceFile,
        sourcePath,
      });
    }
  }
  return result;
}

function latestVersionPayload(installersValue, updaterFilesValue, updateBase, timestamp, notes) {
  const releaseNumber = Number(packageJson.clientReleaseNumber);
  if (!Number.isSafeInteger(releaseNumber) || releaseNumber <= 0) {
    fail("package.json clientReleaseNumber must be a positive safe integer");
  }
  const payload = {};
  for (const installer of installersValue) {
    const feed = updaterFilesValue.find((file) => file.target === installer.target && file.kind === "feed");
    if (!feed) fail(`missing updater feed for ${installer.target}`);
    const updaterBase = joinUrl(updateBase, installer.target);
    const entry = {
      version: releaseNumber,
      released_at: timestamp,
      download_url: installer.downloadUrl,
      release_notes: notes,
      sha256: installer.sha256,
      file: installer.file,
      arch: installer.arch,
      updater_base_url: updaterBase,
      updater_feed_url: feed.downloadUrl,
    };
    if (installer.platform === "mac") {
      payload[`mac_${installer.arch}`] = entry;
      if (!payload.mac || installer.arch === "arm64") payload.mac = entry;
    } else if (installer.platform === "windows") {
      payload[`windows_${installer.arch}`] = entry;
      payload.windows ??= entry;
    }
  }
  return payload;
}

function writeChecksums(installersValue, updaterFilesValue) {
  const publicChecksumsPath = join(releaseDir, "SHA256SUMS.txt");
  const publicLines = installersValue.map((file) => `${file.sha256}  ${file.file}`).sort();
  writeFileSync(publicChecksumsPath, `${publicLines.join("\n")}\n`);

  const updaterChecksumsPath = join(updaterOutputDir, "SHA256SUMS.txt");
  const updaterLines = updaterFilesValue.map((file) => `${file.sha256}  ${file.relativePath}`).sort();
  writeFileSync(updaterChecksumsPath, `${updaterLines.join("\n")}\n`);
  return { publicChecksumsPath, updaterChecksumsPath };
}

function copyReleasePayload(input) {
  if (input.destination === releaseDir) fail("--copy-to must not be the release directory itself");
  mkdirSync(input.destination, { recursive: true });
  for (const installer of input.installers) {
    copyFileSync(join(releaseDir, installer.file), join(input.destination, installer.file));
  }
  for (const file of input.updaterFiles) {
    const target = join(input.destination, file.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourcePath, target);
  }
  mkdirSync(join(input.destination, "updater"), { recursive: true });
  copyFileSync(input.updaterChecksumsPath, join(input.destination, "updater", "SHA256SUMS.txt"));
  mkdirSync(join(input.destination, "release-source"), { recursive: true });
  for (const target of input.targets) {
    copyFileSync(
      join(releaseDir, "release-source", `${target.id}.json`),
      join(input.destination, "release-source", `${target.id}.json`),
    );
  }
  for (const path of [input.manifestPath, input.latestPath, input.publicChecksumsPath]) {
    copyFileSync(path, join(input.destination, path.split(/[\\/]/).pop()));
  }
  const receiptPath = join(releaseDir, "release-gate-receipt.json");
  if (existsSync(receiptPath)) copyFileSync(receiptPath, join(input.destination, "release-gate-receipt.json"));
  const gatesPath = join(releaseDir, "release-gates");
  if (existsSync(gatesPath)) cpSync(gatesPath, join(input.destination, "release-gates"), { recursive: true });
  console.log(`Copied release payload to ${input.destination}`);
}

async function verifyRemotePayload(installersValue, updaterFilesValue) {
  const files = [...installersValue, ...updaterFilesValue];
  const proxyHosts = new Set(releaseVerificationProxyHosts(files.map((file) => file.downloadUrl)));
  warnIfProxyMaySlowVerification(proxyHosts);
  const fileConcurrency = Math.min(verifyConcurrency, files.length);
  const phaseId = timing?.startPhase("remote-verification", {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    fileConcurrency,
  });
  try {
    const metadataEntries = await runParallelTasks(
      "Remote release HEAD verification",
      files.map((file) => ({
        id: file.file,
        run: async () => {
          try {
            return [file.file, await readRemoteFileMetadata(file.downloadUrl)];
          } catch (error) {
            const label = file.kind === "feed" ? "updater feed" : "release file";
            throw new Error(
              `remote ${label} is not downloadable: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        },
      })),
      { concurrency: fileConcurrency },
    );
    const metadataByFile = new Map(metadataEntries);
    const sampleFile = [...files]
      .filter((file) => metadataByFile.get(file.file)?.crc64)
      .sort((left, right) => left.size - right.size || left.file.localeCompare(right.file))[0];
    timing?.setConfiguration({
      verifyConcurrency,
      verifyFileConcurrency: fileConcurrency,
      verifyMode: "head-crc64-with-smallest-file-sha256-sample",
      verifySampleFile: sampleFile?.file,
      proxyHosts: [...proxyHosts],
    });
    console.log(
      `Remote verification: HEAD size + CRC64/XZ with ${fileConcurrency} concurrent files; SHA-256 sample=${sampleFile?.file ?? "none (full SHA-256 fallback)"}`,
    );
    await runParallelTasks(
      "Remote release verification",
      files.map((file) => ({
        id: file.file,
        run: () =>
          verifyRemoteFile(
            file,
            metadataByFile.get(file.file),
            file.file === sampleFile?.file,
            proxyHosts.has(new URL(file.downloadUrl).hostname),
          ),
      })),
      { concurrency: fileConcurrency },
    );
    timing?.finishPhase(phaseId);
  } catch (error) {
    timing?.finishPhase(phaseId, { status: "failed", error });
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function verifyRemoteFile(file, metadata, sample, proxyApplied) {
  const label = file.kind === "feed" ? "updater feed" : "release file";
  const startedAt = Date.now();
  const timingFileId = timing?.startFile("remote-verification", {
    file: file.file,
    url: file.downloadUrl,
    kind: file.kind,
    totalBytes: file.size,
    proxyApplied,
    sample,
  });
  if (metadata.size !== file.size) {
    timing?.finishFile(timingFileId, {
      status: "failed",
      error: "remote size does not match local output",
      actualBytes: metadata.size,
    });
    throw new Error(`remote ${label} does not match local output: ${file.downloadUrl}`);
  }

  let mode = "sha256-fallback";
  let networkBytes = file.size;
  let remoteSha256;
  if (metadata.crc64) {
    mode = sample ? "head-crc64+sha256-sample" : "head-crc64";
    networkBytes = sample ? file.size : 0;
    if (metadata.crc64 !== file.crc64) {
      timing?.finishFile(timingFileId, {
        status: "failed",
        error: "remote CRC64 does not match local output",
        actualCrc64: metadata.crc64,
      });
      throw new Error(`remote ${label} does not match local output: ${file.downloadUrl}`);
    }
    if (sample) {
      const remote = await hashRemoteFile(file.downloadUrl, file.size, { concurrency: 1 });
      remoteSha256 = remote.sha256;
      if (remote.size !== file.size || remote.sha256 !== file.sha256) {
        timing?.finishFile(timingFileId, {
          status: "failed",
          error: "remote SHA-256 sample does not match local output",
          actualSha256: remote.sha256,
        });
        throw new Error(`remote ${label} SHA-256 sample does not match local output: ${file.downloadUrl}`);
      }
    }
  } else {
    const remote = await hashRemoteFile(file.downloadUrl, file.size, { concurrency: 1 });
    remoteSha256 = remote.sha256;
    if (remote.size !== file.size || remote.sha256 !== file.sha256) {
      timing?.finishFile(timingFileId, {
        status: "failed",
        error: "remote content does not match local output",
        actualSha256: remote.sha256,
      });
      throw new Error(`remote ${label} does not match local output: ${file.downloadUrl}`);
    }
  }
  const durationMs = Math.max(1, Date.now() - startedAt);
  timing?.finishFile(timingFileId, {
    mode,
    bytesProcessed: file.size,
    totalBytes: file.size,
    networkBytes,
    averageBytesPerSecond: Math.round((file.size * 1_000) / durationMs),
    completed: true,
    crc64: metadata.crc64,
    sha256: remoteSha256,
  });
  console.log(
    `Remote release verification: ${file.file} verified in ${(durationMs / 1_000).toFixed(1)}s` +
      ` mode=${mode} verified=${formatReleaseBytes(file.size)} network=${formatReleaseBytes(networkBytes)}`,
  );
}

function warnIfProxyMaySlowVerification(affectedHosts) {
  if (affectedHosts.size === 0) return;

  console.warn(
    `prepare-desktop-release: environment proxy applies to ${[...affectedHosts].join(", ")}; ` +
      "remote HEAD checks and any SHA-256 fallback will use it. If direct access is intended, add these hosts to both NO_PROXY and no_proxy.",
  );
}

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest(encoding)));
  });
}

function releaseNotesSummary(version) {
  const notesPath = join(projectRoot, "docs", "releases", `v${version}.md`);
  if (!existsSync(notesPath)) return `OpenGrove v${version}`;
  const bullets = [];
  let current = "";
  for (const line of readFileSync(notesPath, "utf8").split("\n")) {
    if (line.startsWith("- ")) {
      if (current) bullets.push(current.trim());
      current = line.slice(2).trim();
    } else if (current && /^  \S/.test(line)) {
      current = `${current} ${line.trim()}`;
    } else if (current && (line.startsWith("#") || line.trim() === "")) {
      bullets.push(current.trim());
      current = "";
    }
  }
  if (current) bullets.push(current.trim());
  return bullets.slice(0, 5).join("\n") || `OpenGrove v${version}`;
}

function requiredBaseUrl(value, name) {
  if (!value) fail(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be a valid URL`);
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) fail(`${name} must use HTTPS`);
  return url.href.replace(/\/+$/, "");
}

function joinUrl(base, ...parts) {
  return `${base.replace(/\/+$/, "")}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-h" || value === "--help") result.help = true;
    else if (value === "--release-package-json") result.releasePackageJson = readRequired(values, ++index, value);
    else if (value.startsWith("--release-package-json="))
      result.releasePackageJson = value.slice("--release-package-json=".length);
    else if (value === "--base-url" || value === "--public-base-url")
      result.publicBaseUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--base-url=") || value.startsWith("--public-base-url="))
      result.publicBaseUrl = value.slice(value.indexOf("=") + 1);
    else if (value === "--updater-base-url") result.updaterBaseUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-base-url=")) result.updaterBaseUrl = value.slice("--updater-base-url=".length);
    else if (value === "--updater-output-dir") result.updaterOutputDir = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-output-dir="))
      result.updaterOutputDir = value.slice("--updater-output-dir=".length);
    else if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--copy-to") result.copyTo = readRequired(values, ++index, value);
    else if (value.startsWith("--copy-to=")) result.copyTo = value.slice("--copy-to=".length);
    else if (value === "--register-url") result.registerUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--register-url=")) result.registerUrl = value.slice("--register-url=".length);
    else if (value === "--gate-receipt") result.gateReceipt = readRequired(values, ++index, value);
    else if (value.startsWith("--gate-receipt=")) result.gateReceipt = value.slice("--gate-receipt=".length);
    else if (value === "--post-latest-url" || value.startsWith("--post-latest-url="))
      throw new Error("--post-latest-url was removed; use --register-url, then promote separately");
    else if (value === "--token" || value.startsWith("--token="))
      throw new Error(
        "--token was removed; use OPENGROVE_RELEASE_UPLOAD_TOKEN so credentials do not enter shell history",
      );
    else if (value === "--out") result.out = readRequired(values, ++index, value);
    else if (value === "--latest-out") result.latestOut = readRequired(values, ++index, value);
    else if (value === "--released-at") result.releasedAt = readRequired(values, ++index, value);
    else if (value.startsWith("--released-at=")) result.releasedAt = value.slice("--released-at=".length);
    else if (value === "--release-notes") result.releaseNotes = readRequired(values, ++index, value);
    else if (value === "--verify-concurrency") result.verifyConcurrency = readRequired(values, ++index, value);
    else if (value.startsWith("--verify-concurrency="))
      result.verifyConcurrency = value.slice("--verify-concurrency=".length);
    else if (value === "--timing-file") result.timingFile = readRequired(values, ++index, value);
    else if (value.startsWith("--timing-file=")) result.timingFile = value.slice("--timing-file=".length);
    else if (value === "--reuse-prepared-metadata") result.reusePreparedMetadata = true;
    else if (value === "--expected-prepared-manifest-sha256")
      result.expectedPreparedManifestSha256 = readRequired(values, ++index, value);
    else if (value.startsWith("--expected-prepared-manifest-sha256="))
      result.expectedPreparedManifestSha256 = value.slice("--expected-prepared-manifest-sha256=".length);
    else if (value === "--allow-partial-backend-update")
      throw new Error("partial backend registration was removed; all three release targets are required");
    else if (value === "--verify-remote") result.verifyRemote = true;
    else throw new Error(`Unknown prepare-desktop-release option: ${value}`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/prepare-desktop-release.mjs [options]

Validates one or more architecture-specific release targets, builds deterministic
updater payloads, and optionally registers an immutable gated ww candidate.

  --public-base-url URL     GitHub Release download base for DMG/EXE
  --updater-base-url URL    OSS/CDN base for architecture-specific updater files
  --updater-output-dir DIR  Updater staging directory (default release/desktop/updater)
  --release-dir DIR         Desktop release artifact directory
  --release-package-json FILE
                            package.json supplying candidate version identity
  --copy-to DIR             Copy the complete upload payload to a staging directory
  --register-url URL        Verify all remote files, then register the gated candidate
  --gate-receipt FILE       Gate receipt (default release/desktop/release-gate-receipt.json)
  --verify-remote           Verify all remote files without POSTing to ww
  --verify-concurrency N    Concurrent remote HEAD/file checks (default 16;
                            OPENGROVE_RELEASE_VERIFY_CONCURRENCY)
  --timing-file FILE        Append file-level verification timing to a publish report
  --reuse-prepared-metadata Internal publisher handoff; requires the expected prepared
                            manifest SHA-256 and never regenerates release metadata
`);
}

function fail(message) {
  console.error(`prepare-desktop-release: ${message}`);
  process.exit(1);
}
