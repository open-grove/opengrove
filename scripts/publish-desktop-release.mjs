import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveR2ReleaseCredentials, resolveReleaseUploadToken } from "./desktop-release-credentials.mjs";
import { runCommand, runParallelTasks } from "./parallel-release-tasks.mjs";
import { releaseRequestSignal } from "./release-network.mjs";
import { formatReleaseBytes, openReleaseTiming } from "./release-timing.mjs";
import { ensureImmutableR2Object } from "./r2-release-upload.mjs";
import { readDesktopReleasePackageIdentity } from "./desktop-release-package-identity.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const releasePackageJsonPath = resolve(args.releasePackageJson ?? join(projectRoot, "package.json"));
const packageJson = readDesktopReleasePackageIdentity(releasePackageJsonPath);
let timing = null;

if (args.help) {
  printHelp();
  process.exit(0);
}

const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const updaterOutputDir = resolve(
  args.updaterOutputDir ?? process.env.OPENGROVE_DESKTOP_RELEASE_UPDATER_DIR ?? join(releaseDir, "updater"),
);
const updaterBaseUrl = requiredBaseUrl(
  args.updaterBaseUrl ?? process.env.OPENGROVE_DESKTOP_RELEASE_UPDATER_BASE_URL,
  "--updater-base-url / OPENGROVE_DESKTOP_RELEASE_UPDATER_BASE_URL",
);
const uploadInstallers = args.uploadInstallers || process.env.OPENGROVE_RELEASE_UPLOAD_INSTALLERS === "1";
const publicBaseUrl = uploadInstallers
  ? requiredBaseUrl(
      args.publicBaseUrl ??
        process.env.OPENGROVE_DESKTOP_RELEASE_PUBLIC_BASE_URL ??
        process.env.OPENGROVE_DESKTOP_RELEASE_BASE_URL,
      "--public-base-url / OPENGROVE_DESKTOP_RELEASE_PUBLIC_BASE_URL",
    )
  : "";
if (uploadInstallers && new URL(publicBaseUrl).host !== new URL(updaterBaseUrl).host) {
  fail(
    "--upload-installers expects the public base URL and the updater base URL on the same OSS host, so installers land in the bucket their download_url points at",
  );
}
const rawRegisterUrl = args.registerUrl ?? process.env.OPENGROVE_CLIENT_RELEASES_URL ?? "";
const registerUrl = rawRegisterUrl
  ? requiredBaseUrl(rawRegisterUrl, "--register-url / OPENGROVE_CLIENT_RELEASES_URL")
  : "";
const uploadCredential = registerUrl ? resolveReleaseUploadToken() : { token: "", source: "missing" };
const token = uploadCredential.token;
const ossutilBin = process.env.OPENGROVE_OSSUTIL_BIN || "ossutil";
const r2Bucket = args.r2Bucket ?? process.env.OPENGROVE_RELEASE_R2_BUCKET ?? "";
const r2AccountId = args.r2AccountId ?? process.env.OPENGROVE_RELEASE_R2_ACCOUNT_ID ?? "";
const r2EnvironmentCredentialRequested = Boolean(
  process.env.OPENGROVE_RELEASE_R2_ACCESS_KEY_ID || process.env.OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY,
);
const r2Requested = Boolean(r2Bucket || r2AccountId || r2EnvironmentCredentialRequested);
const r2Credential = r2Requested
  ? resolveR2ReleaseCredentials()
  : { accessKeyId: "", secretAccessKey: "", source: "missing" };
const r2AccessKeyId = r2Credential.accessKeyId;
const r2SecretAccessKey = r2Credential.secretAccessKey;
if (r2Requested && (!r2Bucket || !r2AccountId)) {
  fail(
    "the R2 mirror requires both --r2-bucket / OPENGROVE_RELEASE_R2_BUCKET and --r2-account-id / OPENGROVE_RELEASE_R2_ACCOUNT_ID",
  );
}
if (r2Requested && !uploadInstallers) {
  fail("the R2 mirror only mirrors public installers; use --upload-installers / OPENGROVE_RELEASE_UPLOAD_INSTALLERS=1");
}
if (r2Requested && !args.dryRun && !args.skipUpload && (!r2AccessKeyId || !r2SecretAccessKey)) {
  fail(
    "the R2 mirror requires both R2 credentials in the environment or the macOS OpenGrove R2 Release Upload Keychain items",
  );
}
const uploadConcurrency = positiveInteger(
  args.uploadConcurrency ?? process.env.OPENGROVE_RELEASE_UPLOAD_CONCURRENCY ?? "4",
  "--upload-concurrency / OPENGROVE_RELEASE_UPLOAD_CONCURRENCY",
);
const ossAttempts = positiveInteger(
  args.ossAttempts ?? process.env.OPENGROVE_RELEASE_OSS_ATTEMPTS ?? "3",
  "--oss-attempts / OPENGROVE_RELEASE_OSS_ATTEMPTS",
);
const r2Attempts = positiveInteger(
  args.r2Attempts ?? process.env.OPENGROVE_RELEASE_R2_ATTEMPTS ?? "3",
  "--r2-attempts / OPENGROVE_RELEASE_R2_ATTEMPTS",
);
const ossCheckpointDir = resolve(
  args.ossCheckpointDir ??
    process.env.OPENGROVE_RELEASE_OSS_CHECKPOINT_DIR ??
    join(dirname(releaseDir), `.${basename(releaseDir)}-oss-checkpoints`, `v${packageJson.version}`),
);
const verifyConcurrency = positiveInteger(
  args.verifyConcurrency ?? process.env.OPENGROVE_RELEASE_VERIFY_CONCURRENCY ?? "16",
  "--verify-concurrency / OPENGROVE_RELEASE_VERIFY_CONCURRENCY",
);
const timingPath = resolve(
  args.timingFile ?? process.env.OPENGROVE_RELEASE_TIMING_FILE ?? join(releaseDir, "release-timing.json"),
);
timing = openReleaseTiming({
  path: timingPath,
  command: "publish:desktop-release",
  version: packageJson.version,
  reset: !args.appendTiming,
  configuration: {
    uploadConcurrency,
    ossAttempts,
    ossCheckpointDir,
    r2Mirror: r2Requested,
    r2Bucket: r2Requested ? r2Bucket : undefined,
    r2Attempts,
    verifyConcurrency,
    uploadInstallers,
    skipUpload: Boolean(args.skipUpload),
    dryRun: Boolean(args.dryRun),
    candidateCommit: process.env.OPENGROVE_RELEASE_CANDIDATE_COMMIT || undefined,
    deploymentCommit: process.env.OPENGROVE_RELEASE_DEPLOYMENT_COMMIT || undefined,
  },
});

if (registerUrl && !token && !args.dryRun) {
  fail(
    "a ww release upload token is required to register the candidate; set OPENGROVE_RELEASE_UPLOAD_TOKEN, store the default OpenGrove Release Upload / ww Keychain item on macOS, or drop --register-url",
  );
}
if (registerUrl && uploadCredential.source === "keychain") {
  console.log("publish-desktop-release: using the ww upload token from macOS Keychain");
}
if (r2Requested && r2Credential.source === "keychain" && !args.dryRun && !args.skipUpload) {
  console.log("publish-desktop-release: using the R2 upload credentials from macOS Keychain");
}
const destination = args.skipUpload ? null : resolveOssDestination(updaterBaseUrl);

const preparePhaseId = timing.startPhase("prepare-release-metadata");
try {
  runPrepare([]);
  timing.finishPhase(preparePhaseId);
} catch (error) {
  timing.finishPhase(preparePhaseId, { status: "failed", error });
  fail(`release metadata preparation failed: ${errorMessage(error)}`);
}

const manifestPath = join(releaseDir, "desktop-release-manifest.json");
const manifestBytes = readFileSync(manifestPath);
const preparedManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const manifest = JSON.parse(manifestBytes);
if (registerUrl && manifest.partialRelease) {
  fail("ww registration requires all three canonical targets; register only after the complete release is assembled");
}

const installerKeyPrefix = uploadInstallers ? new URL(publicBaseUrl).pathname.replace(/^\/+|\/+$/g, "") : "";
const uploads = [
  ...(uploadInstallers
    ? manifest.installers.map((file) => ({
        localPath: join(releaseDir, file.file),
        objectKey: [installerKeyPrefix, file.file].filter(Boolean).join("/"),
      }))
    : []),
  ...manifest.updaterFiles.map((file) => ({
    localPath: preparedUpdaterSourcePath(file),
    objectKey: objectKey(destination, file.relativePath),
  })),
  {
    localPath: join(updaterOutputDir, "SHA256SUMS.txt"),
    objectKey: objectKey(destination, "SHA256SUMS.txt"),
  },
];
const r2Uploads = r2Requested
  ? manifest.installers.map((file) => ({
      localPath: join(releaseDir, file.file),
      objectKey: [installerKeyPrefix, file.file].filter(Boolean).join("/"),
      filename: file.file,
      sha256: file.sha256,
      contentType: installerContentType(file.file),
    }))
  : [];
if (args.dryRun) {
  if (args.skipUpload) {
    console.log("publish-desktop-release: would skip the OSS upload (--skip-upload)");
  } else {
    for (const upload of uploads) {
      console.log(`publish-desktop-release: would run ${ossutilCommandLine(upload)}`);
    }
    for (const upload of r2Uploads) {
      console.log(`publish-desktop-release: would mirror ${upload.localPath} to r2://${r2Bucket}/${upload.objectKey}`);
    }
  }
  console.log(
    registerUrl
      ? `publish-desktop-release: would verify all remote files and register the gated candidate with ${registerUrl}; it would not promote it`
      : "publish-desktop-release: would verify all remote files without registering with ww",
  );
  if (registerUrl && !token) {
    console.warn(
      "publish-desktop-release: no environment or macOS Keychain ww upload token was found; the real run will refuse to register",
    );
  }
  timing.finishRun();
  console.log(`publish-desktop-release: wrote timing report to ${timing.path}`);
  process.exit(0);
}

if (registerUrl && !uploadInstallers) await assertInstallersDownloadable(manifest.installers);

if (args.skipUpload) {
  console.log("publish-desktop-release: skipping OSS upload (--skip-upload)");
  const phaseId = timing.startPhase("oss-upload", { fileCount: 0 });
  timing.finishPhase(phaseId, { status: "skipped" });
} else {
  mkdirSync(ossCheckpointDir, { recursive: true });
  for (const upload of uploads) {
    if (!existsSync(upload.localPath)) fail(`release file is missing: ${upload.localPath}`);
  }
  const phaseId = timing.startPhase("oss-upload", {
    fileCount: uploads.length,
    totalBytes: uploads.reduce((total, upload) => total + statSync(upload.localPath).size, 0),
    concurrency: uploadConcurrency,
  });
  try {
    await runParallelTasks(
      "OSS upload",
      uploads.map((upload, index) => ({
        id: `${index + 1}/${uploads.length} ${upload.objectKey}`,
        run: () => runOssutil(upload),
      })),
      { concurrency: uploadConcurrency },
    );
    timing.finishPhase(phaseId);
  } catch (error) {
    timing.finishPhase(phaseId, { status: "failed", error });
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`publish-desktop-release: uploaded ${uploads.length} release files to oss://${destination.bucket}`);
}

if (r2Requested) {
  if (args.skipUpload) {
    console.log("publish-desktop-release: skipping R2 mirror upload (--skip-upload)");
    const phaseId = timing.startPhase("r2-upload", { fileCount: 0 });
    timing.finishPhase(phaseId, { status: "skipped" });
  } else {
    const phaseId = timing.startPhase("r2-upload", {
      fileCount: r2Uploads.length,
      totalBytes: r2Uploads.reduce((total, upload) => total + statSync(upload.localPath).size, 0),
      concurrency: Math.min(uploadConcurrency, r2Uploads.length),
    });
    try {
      await runParallelTasks(
        "R2 mirror upload",
        r2Uploads.map((upload, index) => ({
          id: `${index + 1}/${r2Uploads.length} ${upload.objectKey}`,
          run: () => runR2Upload(upload),
        })),
        { concurrency: uploadConcurrency },
      );
      timing.finishPhase(phaseId);
    } catch (error) {
      timing.finishPhase(phaseId, { status: "failed", error });
      fail(error instanceof Error ? error.message : String(error));
    }
    console.log(`publish-desktop-release: mirrored ${r2Uploads.length} installers to r2://${r2Bucket}`);
  }
}

try {
  runPrepare(
    [
      "--reuse-prepared-metadata",
      "--expected-prepared-manifest-sha256",
      preparedManifestSha256,
      ...(registerUrl
        ? [
            "--register-url",
            registerUrl,
            "--gate-receipt",
            resolve(args.gateReceipt ?? join(releaseDir, "release-gate-receipt.json")),
          ]
        : ["--verify-remote"]),
    ],
    { appendTiming: true },
  );
} catch (error) {
  fail(`remote verification or registration failed: ${errorMessage(error)}`);
}
timing.finishRun();
console.log(
  registerUrl
    ? "publish-desktop-release: remote files verified and gated candidate registered with ww; the active pointer was not changed"
    : "publish-desktop-release: remote files verified; rerun with --register-url after the complete gate receipt is ready",
);
console.log(`publish-desktop-release: wrote timing report to ${timing.path}`);

function runPrepare(extra, { appendTiming = false } = {}) {
  const childEnv = { ...process.env };
  // Candidate registration only consumes the immutable metadata prepared
  // before upload; it cannot regenerate or silently substitute release bytes.
  delete childEnv.OPENGROVE_CLIENT_RELEASES_URL;
  delete childEnv.OPENGROVE_CLIENT_LATEST_VERSION_URL;
  if (token) childEnv.OPENGROVE_RELEASE_UPLOAD_TOKEN = token;
  const prepareArgs = [
    join(projectRoot, "scripts", "prepare-desktop-release.mjs"),
    "--release-package-json",
    releasePackageJsonPath,
    "--release-dir",
    releaseDir,
    "--updater-output-dir",
    updaterOutputDir,
    "--updater-base-url",
    updaterBaseUrl,
    "--verify-concurrency",
    String(verifyConcurrency),
    ...(appendTiming ? ["--timing-file", timing.path] : []),
    ...(args.publicBaseUrl ? ["--public-base-url", args.publicBaseUrl] : []),
    ...extra,
  ];
  execFileSync(process.execPath, prepareArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    env: childEnv,
  });
}

function resolveOssDestination(baseUrl) {
  const url = new URL(baseUrl);
  const nativeHost = /^([a-z0-9][a-z0-9-]*)\.(oss-[a-z0-9-]+\.aliyuncs\.com)$/i.exec(url.hostname);
  const bucket = args.ossBucket ?? process.env.OPENGROVE_RELEASE_OSS_BUCKET ?? nativeHost?.[1];
  if (!bucket) {
    fail(
      "cannot resolve the OSS bucket: set --oss-bucket / OPENGROVE_RELEASE_OSS_BUCKET, or use a native <bucket>.oss-<region>.aliyuncs.com updater base URL",
    );
  }
  const endpoint = args.ossEndpoint ?? process.env.OPENGROVE_RELEASE_OSS_ENDPOINT ?? nativeHost?.[2] ?? "";
  const keyPrefix = (args.ossKeyPrefix ?? process.env.OPENGROVE_RELEASE_OSS_KEY_PREFIX ?? url.pathname).replace(
    /^\/+|\/+$/g,
    "",
  );
  // The release bucket can be private: without a per-object public-read ACL the
  // uploaded updater files would 403 for clients and for remote verification.
  const objectAcl = args.ossObjectAcl ?? process.env.OPENGROVE_RELEASE_OSS_OBJECT_ACL ?? "public-read";
  return { bucket, endpoint, keyPrefix, objectAcl };
}

function objectKey(destinationValue, relativePath) {
  if (!destinationValue) return relativePath;
  return [destinationValue.keyPrefix, relativePath].filter(Boolean).join("/");
}

function preparedUpdaterSourcePath(file) {
  if (!["release", "updater"].includes(file.source) || typeof file.sourceFile !== "string") {
    fail(`release manifest updater source is invalid: ${file.file ?? "unknown file"}`);
  }
  const root = file.source === "release" ? releaseDir : updaterOutputDir;
  const path = resolve(root, ...file.sourceFile.split("/"));
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail(`release manifest updater source escapes its root: ${file.sourceFile}`);
  }
  return path;
}

function ossutilArgs(upload) {
  return [
    "cp",
    upload.localPath,
    `oss://${destination.bucket}/${upload.objectKey}`,
    "--ignore-existing",
    ...(destination.objectAcl !== "inherit" ? ["--acl", destination.objectAcl] : []),
    ...(destination.endpoint ? ["--endpoint", destination.endpoint] : []),
    "--checkpoint-dir",
    ossCheckpointDir,
    "--retry-times",
    "10",
  ];
}

function ossutilCommandLine(upload) {
  return [ossutilBin, ...ossutilArgs(upload)].join(" ");
}

async function runOssutil(upload) {
  const size = statSync(upload.localPath).size;
  const startedAt = Date.now();
  const timingFileId = timing.startFile("oss-upload", {
    file: upload.localPath,
    objectKey: upload.objectKey,
    totalBytes: size,
  });
  console.log(`publish-desktop-release: ensuring immutable object ${upload.objectKey} 0 B/${formatReleaseBytes(size)}`);
  console.log(`publish-desktop-release: ${ossutilCommandLine(upload)}`);
  let attemptsUsed = 0;
  try {
    for (let attempt = 1; attempt <= ossAttempts; attempt += 1) {
      attemptsUsed = attempt;
      try {
        await runCommand(ossutilBin, ossutilArgs(upload), { cwd: projectRoot });
        break;
      } catch (error) {
        if (error?.code === "ENOENT") throw error;
        if (attempt === ossAttempts) throw error;
        const delayMs = Math.min(5_000, 1_000 * 2 ** (attempt - 1));
        console.warn(
          `publish-desktop-release: retrying ${upload.objectKey} in ${(delayMs / 1_000).toFixed(1)}s` +
            ` after attempt ${attempt}/${ossAttempts}`,
        );
        await delay(delayMs);
      }
    }
    const durationMs = Math.max(1, Date.now() - startedAt);
    const averageBytesPerSecond = Math.round((size * 1_000) / durationMs);
    timing.finishFile(timingFileId, {
      bytesProcessed: size,
      totalBytes: size,
      intervalBytesPerSecond: averageBytesPerSecond,
      averageBytesPerSecond,
      completed: true,
      attempts: attemptsUsed,
    });
    console.log(
      `publish-desktop-release: uploaded ${upload.objectKey} in ${(durationMs / 1_000).toFixed(1)}s` +
        ` average=${formatReleaseBytes(averageBytesPerSecond)}/s`,
    );
  } catch (error) {
    timing.finishFile(timingFileId, { status: "failed", error });
    if (error?.code === "ENOENT") {
      throw new Error(
        `ossutil is not available as '${ossutilBin}'; install it (https://help.aliyun.com/zh/oss/developer-reference/ossutil) or set OPENGROVE_OSSUTIL_BIN`,
      );
    }
    throw new Error(`ossutil upload failed for ${upload.localPath}`, { cause: error });
  }
}

async function runR2Upload(upload) {
  const size = statSync(upload.localPath).size;
  const startedAt = Date.now();
  const timingFileId = timing.startFile("r2-upload", {
    file: upload.localPath,
    objectKey: upload.objectKey,
    totalBytes: size,
  });
  console.log(
    `publish-desktop-release: ensuring immutable R2 object ${upload.objectKey} 0 B/${formatReleaseBytes(size)}`,
  );
  try {
    const result = await ensureImmutableR2Object({
      accountId: r2AccountId,
      bucket: r2Bucket,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      localPath: upload.localPath,
      objectKey: upload.objectKey,
      filename: upload.filename,
      sha256: upload.sha256,
      contentType: upload.contentType,
      attempts: r2Attempts,
    });
    const durationMs = Math.max(1, Date.now() - startedAt);
    const averageBytesPerSecond = Math.round((size * 1_000) / durationMs);
    timing.finishFile(timingFileId, {
      bytesProcessed: result.status === "uploaded" ? size : 0,
      totalBytes: size,
      intervalBytesPerSecond: averageBytesPerSecond,
      averageBytesPerSecond,
      completed: true,
      mode: result.status,
    });
    console.log(
      `publish-desktop-release: ${result.status === "uploaded" ? "uploaded" : "reused"} ${upload.objectKey}` +
        ` in ${(durationMs / 1_000).toFixed(1)}s`,
    );
  } catch (error) {
    timing.finishFile(timingFileId, { status: "failed", error });
    throw new Error(`R2 mirror upload failed for ${upload.localPath}`, { cause: error });
  }
}

function installerContentType(filename) {
  if (filename.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (filename.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function assertInstallersDownloadable(installers) {
  for (const installer of installers) {
    const response = await fetch(installer.downloadUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: releaseRequestSignal(),
    });
    if (!response.ok) {
      fail(
        `installer is not downloadable yet: HTTP ${response.status} ${installer.downloadUrl}; upload it with 'gh release upload' before publishing`,
      );
    }
  }
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

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-h" || value === "--help") result.help = true;
    else if (value === "--release-package-json") result.releasePackageJson = readRequired(values, ++index, value);
    else if (value.startsWith("--release-package-json="))
      result.releasePackageJson = value.slice("--release-package-json=".length);
    else if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--updater-output-dir") result.updaterOutputDir = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-output-dir="))
      result.updaterOutputDir = value.slice("--updater-output-dir=".length);
    else if (value === "--public-base-url") result.publicBaseUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--public-base-url=")) result.publicBaseUrl = value.slice("--public-base-url=".length);
    else if (value === "--updater-base-url") result.updaterBaseUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-base-url=")) result.updaterBaseUrl = value.slice("--updater-base-url=".length);
    else if (value === "--register-url") result.registerUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--register-url=")) result.registerUrl = value.slice("--register-url=".length);
    else if (value === "--gate-receipt") result.gateReceipt = readRequired(values, ++index, value);
    else if (value.startsWith("--gate-receipt=")) result.gateReceipt = value.slice("--gate-receipt=".length);
    else if (value === "--post-latest-url" || value.startsWith("--post-latest-url="))
      throw new Error("--post-latest-url was removed; use --register-url, then promote separately");
    else if (value === "--oss-bucket") result.ossBucket = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-bucket=")) result.ossBucket = value.slice("--oss-bucket=".length);
    else if (value === "--oss-endpoint") result.ossEndpoint = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-endpoint=")) result.ossEndpoint = value.slice("--oss-endpoint=".length);
    else if (value === "--oss-key-prefix") result.ossKeyPrefix = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-key-prefix=")) result.ossKeyPrefix = value.slice("--oss-key-prefix=".length);
    else if (value === "--oss-object-acl") result.ossObjectAcl = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-object-acl=")) result.ossObjectAcl = value.slice("--oss-object-acl=".length);
    else if (value === "--r2-bucket") result.r2Bucket = readRequired(values, ++index, value);
    else if (value.startsWith("--r2-bucket=")) result.r2Bucket = value.slice("--r2-bucket=".length);
    else if (value === "--r2-account-id") result.r2AccountId = readRequired(values, ++index, value);
    else if (value.startsWith("--r2-account-id=")) result.r2AccountId = value.slice("--r2-account-id=".length);
    else if (value === "--r2-attempts") result.r2Attempts = readRequired(values, ++index, value);
    else if (value.startsWith("--r2-attempts=")) result.r2Attempts = value.slice("--r2-attempts=".length);
    else if (value === "--upload-concurrency") result.uploadConcurrency = readRequired(values, ++index, value);
    else if (value.startsWith("--upload-concurrency="))
      result.uploadConcurrency = value.slice("--upload-concurrency=".length);
    else if (value === "--oss-attempts") result.ossAttempts = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-attempts=")) result.ossAttempts = value.slice("--oss-attempts=".length);
    else if (value === "--oss-checkpoint-dir") result.ossCheckpointDir = readRequired(values, ++index, value);
    else if (value.startsWith("--oss-checkpoint-dir="))
      result.ossCheckpointDir = value.slice("--oss-checkpoint-dir=".length);
    else if (value === "--verify-concurrency") result.verifyConcurrency = readRequired(values, ++index, value);
    else if (value.startsWith("--verify-concurrency="))
      result.verifyConcurrency = value.slice("--verify-concurrency=".length);
    else if (value === "--timing-file") result.timingFile = readRequired(values, ++index, value);
    else if (value.startsWith("--timing-file=")) result.timingFile = value.slice("--timing-file=".length);
    else if (value === "--append-timing") result.appendTiming = true;
    else if (value === "--allow-partial-backend-update")
      throw new Error("partial backend registration was removed; all three release targets are required");
    else if (value === "--upload-installers") result.uploadInstallers = true;
    else if (value === "--skip-upload") result.skipUpload = true;
    else if (value === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown publish-desktop-release option: ${value}`);
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
  console.log(`Usage: node scripts/publish-desktop-release.mjs [options]

Desktop candidate publish: regenerates and validates the release metadata,
uploads the updater payload to OSS with ossutil, verifies every public URL by
HEAD size + OSS CRC64/XZ, fully re-reads the smallest CRC-backed file as a
SHA-256 sample, and only then registers an immutable gated candidate with ww. It
never changes the active user update pointer. Hosts
without a CRC64 header fall back to exact full-file SHA-256 verification. The
upload-before-register ordering is enforced by construction; promotion is a
separate explicit command.

ossutil supplies the OSS credentials itself (its config file or environment);
this script never reads access keys. The ww Bearer credential comes from
OPENGROVE_RELEASE_UPLOAD_TOKEN or the macOS OpenGrove Release Upload / ww
Keychain item, never from command-line arguments. R2 mirroring uses dedicated
OPENGROVE_RELEASE_R2_ACCESS_KEY_ID and OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY
environment variables, or the macOS OpenGrove R2 Release Upload Keychain
items. Conditional writes reuse an existing immutable object only when its
size and SHA-256 metadata match and its fully read-back bytes hash correctly.

  --release-dir DIR         Desktop release artifact directory
  --release-package-json FILE
                            Candidate package.json used only for release version identity;
                            deployment code and dependencies still come from trusted main
  --updater-output-dir DIR  Updater staging directory (default release/desktop/updater)
  --public-base-url URL     GitHub Release download base for DMG/EXE
  --updater-base-url URL    OSS/CDN base for architecture-specific updater files
  --register-url URL        ww /v1/admin/client/releases endpoint; omit to upload + verify only
  --gate-receipt FILE       Complete CI gate receipt to attach to the candidate
  --oss-bucket NAME         OSS bucket (OPENGROVE_RELEASE_OSS_BUCKET); derived from a
                            native <bucket>.oss-<region>.aliyuncs.com updater base URL
  --oss-endpoint HOST       ossutil --endpoint (OPENGROVE_RELEASE_OSS_ENDPOINT); derived
                            from a native updater base URL, else ossutil's own config
  --oss-key-prefix PREFIX   Object key prefix (OPENGROVE_RELEASE_OSS_KEY_PREFIX);
                            defaults to the URL path of the updater base URL
  --oss-object-acl ACL      Per-object ACL (OPENGROVE_RELEASE_OSS_OBJECT_ACL); defaults
                            to public-read for private buckets, "inherit" to skip
  --r2-bucket NAME          Cloudflare R2 mirror bucket (OPENGROVE_RELEASE_R2_BUCKET)
  --r2-account-id ID        Cloudflare account ID
                            (OPENGROVE_RELEASE_R2_ACCOUNT_ID)
  --r2-attempts N           Attempts per R2 request, multipart part, or whole-object
                            readback (default 3; OPENGROVE_RELEASE_R2_ATTEMPTS)
  --upload-installers       Also upload DMG/EXE installers to the public base URL's OSS
                            prefix (OPENGROVE_RELEASE_UPLOAD_INSTALLERS=1); use when the
                            GitHub repo is private and downloads must come from OSS
  --upload-concurrency N    Concurrent ossutil uploads (default 4;
                            OPENGROVE_RELEASE_UPLOAD_CONCURRENCY)
  --oss-attempts N          Whole-command OSS attempts after ossutil's internal retries
                            (default 3; OPENGROVE_RELEASE_OSS_ATTEMPTS)
  --oss-checkpoint-dir DIR  Persistent multipart checkpoint directory
                            (OPENGROVE_RELEASE_OSS_CHECKPOINT_DIR)
  --verify-concurrency N    Concurrent remote HEAD/file checks (default 16;
                            OPENGROVE_RELEASE_VERIFY_CONCURRENCY)
  --timing-file FILE        Structured timing output (default release/desktop/release-timing.json;
                            OPENGROVE_RELEASE_TIMING_FILE)
  --append-timing           Append publisher phases while preserving the existing report's
                            top-level command, product, version, and start time
  --skip-upload             Files are already on OSS; verify and register the candidate only
  --dry-run                 Print the upload/register plan without network calls
`);
}

function fail(message) {
  console.error(`publish-desktop-release: ${message}`);
  timing?.finishRun({ status: "failed", error: message });
  process.exit(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
