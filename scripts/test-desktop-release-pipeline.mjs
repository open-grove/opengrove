import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as createHttpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { macArchitectureBuildPlan } from "./desktop-release-build-plan.mjs";
import {
  macDmgRequiresSigning,
  resolveAppleNotaryCredentials,
  resolveR2ReleaseCredentials,
  resolveReleaseUploadToken,
  windowsSigningConfigPresent,
  windowsSigningProblems,
} from "./desktop-release-credentials.mjs";
import { desktopReleaseTargets, desktopReleaseWebBuildId } from "./desktop-release-targets.mjs";
import { waitForNotarizationPipelines } from "./desktop-notarization-pipeline.mjs";
import { runCommand, runParallelTasks } from "./parallel-release-tasks.mjs";
import { ensureImmutableR2Object, verifyR2ReleaseAccess } from "./r2-release-upload.mjs";
import { crc64Xz, crc64XzFile } from "./crc64-xz.mjs";
import {
  desktopDistInventory,
  desktopPackageInventoryProblems,
  forbiddenDesktopRuntimePackagePrefixes,
  historicalDesktopRuntimeForbiddenPackagePrefixes,
  historicalDesktopRuntimePackageFiles,
  requiredDesktopRuntimePackageFiles,
} from "./desktop-package-inventory.mjs";
import { desktopAsarLookupPath, normalizeDesktopAsarPath } from "./desktop-asar-path.mjs";
import { containsPossibleDesktopPackageSecret } from "./desktop-package-secret-scan.mjs";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";
import { sanitizedWindowsPowerShellEnv, windowsPowerShellExecutable } from "./windows-powershell-env.mjs";
import { macReleaseToolProblems } from "./desktop-release-preflight-tools.mjs";
import { verifyDesktopUpdateMetadata } from "./desktop-update-metadata.mjs";
import { writeDesktopReleaseGateReceipt } from "./desktop-release-gate-receipt.mjs";
import {
  hashRemoteFile,
  readRemoteFileMetadata,
  releaseProxyUrl,
  releaseRequestSignal,
  releaseVerificationProxyHosts,
} from "./release-network.mjs";
import { readAsarPackageVersion } from "./asar-package-version.mjs";
import { processCommandMatchesExecutable } from "./process-command-path.mjs";
import {
  seedWindowsInstallerFirewallState,
  windowsInstallerFirewallRegistryKey,
} from "./windows-installer-gate-state.mjs";
import { readDesktopReleasePackageIdentity } from "./desktop-release-package-identity.mjs";
import { checkDesktopReleaseInfrastructure } from "./check-desktop-release-infrastructure.mjs";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";
import {
  isWindowsExactExecutableRunning,
  stopWindowsExactExecutable,
  stopWindowsExactExecutableScript,
  windowsExactExecutableRunningScript,
} from "./windows-exact-process.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createPackage } = require("@electron/asar");
const { load: loadYaml } = require("js-yaml");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-release-"));
const releaseDir = join(tempRoot, "release");
const updaterDir = join(tempRoot, "custom-updater");
const copyDir = join(tempRoot, "upload");
const timingPath = join(tempRoot, "release-timing.json");
const releasedAt = "2026-07-10T00:00:00.000Z";
const gitCommit = "a".repeat(40);
const specs = desktopReleaseTargets(packageJson.version);

try {
  testCredentialParsing();
  testReleaseUploadTokenResolution();
  testR2ReleaseCredentialResolution();
  testDesktopReleaseWorkflow();
  await testDesktopReleaseInfrastructureReadiness();
  testDesktopReleasePackageIdentity();
  testReleaseProxyDetection();
  await testReleaseRequestSignal();
  await testCrc64Xz();
  await testRemoteMetadata();
  await testR2ImmutableUpload();
  await testR2ReadbackRetriesInterruptedStreams();
  await testR2MultipartUploadRetries();
  await testAsarPackageVersionRefresh();
  testDesktopPackageInventory();
  testDesktopPackagingPortability();
  testNodePackageManagerInvocation();
  testProcessCommandPathAliases();
  testWindowsExactProcessControl();
  testWindowsInstallerGateState();
  testDesktopPackageSecretScan();
  testMacReleaseTools();
  const releaseBuilderConfig = require(join(projectRoot, "electron-builder.release.cjs"));
  assert.equal(releaseBuilderConfig.dmg.sign, true);
  assert.equal(releaseBuilderConfig.npmRebuild, false);
  assert.equal(releaseBuilderConfig.extraMetadata.opengroveOfficialRelease, true);
  assert.equal(
    Object.hasOwn(releaseBuilderConfig.mac, "identity"),
    false,
    "formal macOS releases must discover a Developer ID identity instead of inheriting the development ad-hoc identity",
  );
  testUnsignedWindowsEscapeHatch();
  testIsolatedMacBuilderConfig();
  testMacArchitectureBuildPlan();
  assert.equal(macDmgRequiresSigning({ signed: true }), false);
  assert.equal(macDmgRequiresSigning({ signed: false }), true);
  assert.equal(macDmgRequiresSigning({ signed: true, force: true }), true);
  assert.equal(desktopReleaseWebBuildId("0.4.2", gitCommit), `release-0_4_2-${gitCommit.slice(0, 12)}`);
  assert.deepEqual(
    specs.map((spec) => spec.id),
    ["mac-arm64", "mac-x64", "windows-x64"],
  );
  await testParallelReleaseTasks();
  await testNotarizationArchitecturePipelines();
  await testRangedRemoteHash();
  await testReleaseNetworkTimeouts();

  addTarget("mac-arm64", gitCommit);
  runPublisher();
  const firstLatest = readFileSync(join(releaseDir, "client-latest-version.json"), "utf8");
  const firstFeed = readFileSync(join(updaterDir, "mac-arm64", "latest-mac.yml"), "utf8");
  const firstManifest = readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8");
  runPublisher();
  assert.equal(readFileSync(join(releaseDir, "client-latest-version.json"), "utf8"), firstLatest);
  assert.equal(readFileSync(join(updaterDir, "mac-arm64", "latest-mac.yml"), "utf8"), firstFeed);
  assert.equal(readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8"), firstManifest);
  assert.equal(JSON.parse(firstManifest).partialRelease, true);
  assert.equal(JSON.parse(firstManifest).schemaVersion, 3);
  assert.deepEqual(Object.keys(JSON.parse(firstManifest).releaseNotesByLocale).sort(), ["en", "zh-CN"]);
  assert.equal(
    JSON.parse(firstLatest).mac_arm64.release_notes,
    JSON.parse(firstManifest).releaseNotesByLocale.en,
    "the legacy per-platform field must be the English projection of the localized source",
  );
  assert.equal(JSON.parse(firstLatest).mac_arm64.released_at, releasedAt);
  assert.equal(existsSync(join(updaterDir, "update-payload-manifest.json")), false);
  assert.equal(
    existsSync(join(updaterDir, "mac-arm64", specs[0].updaterFile)),
    false,
    "updater metadata must reference the canonical root payload instead of copying it",
  );
  assert.equal(
    existsSync(join(updaterDir, "mac-arm64", specs[0].updaterBlockmap)),
    false,
    "updater metadata must reference the canonical root blockmap instead of copying it",
  );
  const firstUpdaterFiles = JSON.parse(firstManifest).updaterFiles;
  assert.equal(firstUpdaterFiles.find((file) => file.kind === "payload").sourceFile, specs[0].updaterFile);
  assert.equal(existsSync(join(copyDir, "updater", "mac-arm64", specs[0].updaterFile)), true);
  assert.equal(existsSync(join(copyDir, "release-source", "mac-arm64.json")), true);
  assert.equal(readLines(join(releaseDir, "SHA256SUMS.txt")).length, 1);
  assert.equal(readFileSync(join(releaseDir, "SHA256SUMS.txt"), "utf8").includes(".zip"), false);
  assert.equal(readLines(join(updaterDir, "SHA256SUMS.txt")).length, 2);

  addTarget("windows-x64", "b".repeat(40));
  assertPublisherFails(/different commits or expected release tags/);
  writeSourceManifest(specs[2], gitCommit);
  runPublisher();

  addTarget("mac-x64", gitCommit);
  runPublisher();
  assert.equal(readLines(join(releaseDir, "SHA256SUMS.txt")).length, 3);
  assert.equal(readLines(join(updaterDir, "SHA256SUMS.txt")).length, 6);
  assert.equal(
    JSON.parse(readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8")).partialRelease,
    false,
  );
  assertPublisherFails(/must match the source manifest timestamp/, ["--released-at", "2026-07-11T00:00:00.000Z"]);
  assertPublisherFails(/removed/, ["--post-latest-url", "https://ww.example.test/latest"]);
  assertPublisherFails(/must use HTTPS/, ["--register-url", "http://downloads.example.test/releases"]);

  const metadataEvidence = await verifyDesktopUpdateMetadata({
    releaseDir,
    updaterDir,
    version: packageJson.version,
    releasedAt,
    requireAll: true,
  });
  assert.equal(metadataEvidence.targets.length, 3);
  const feedPath = join(updaterDir, "mac-arm64", "latest-mac.yml");
  const validFeed = readFileSync(feedPath, "utf8");
  writeFileSync(feedPath, validFeed.replace(/sha512: [^\n]+/, "sha512: broken"));
  await assert.rejects(
    verifyDesktopUpdateMetadata({
      releaseDir,
      updaterDir,
      version: packageJson.version,
      releasedAt,
      requireAll: true,
    }),
    /sha512/i,
  );
  writeFileSync(feedPath, validFeed);

  await writeGateReceipt();
  await testRemoteVerification();
  await testPublishPipeline();
  await testReleaseControl();

  writeFileSync(join(releaseDir, specs[0].updaterFile), "mutated-after-source-manifest");
  assertPublisherFails(/does not match its manifest/);

  console.log("desktop-release-pipeline ok");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function testCredentialParsing() {
  assert.throws(() => resolveAppleNotaryCredentials({}, () => false), /credentials are missing/);
  const api = resolveAppleNotaryCredentials(
    {
      APPLE_API_KEY: "/private/AuthKey.p8",
      APPLE_API_KEY_ID: "KEY123",
      APPLE_API_ISSUER: "issuer",
    },
    () => true,
  );
  assert.equal(api.strategy, "api-key");
  assert.equal(api.redactedArgs.includes("/private/AuthKey.p8"), false);

  const appleId = resolveAppleNotaryCredentials({
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "secret-password",
    APPLE_TEAM_ID: "TEAM123",
  });
  assert.equal(appleId.strategy, "apple-id");
  assert.equal(appleId.redactedArgs.includes("secret-password"), false);
  assert.equal(appleId.redactedArgs.includes("release@example.com"), false);

  const keychain = resolveAppleNotaryCredentials({
    APPLE_KEYCHAIN_PROFILE: "OpenGrove",
    APPLE_KEYCHAIN: "/tmp/release.keychain-db",
  });
  assert.deepEqual(keychain.args, ["--keychain-profile", "OpenGrove", "--keychain", "/tmp/release.keychain-db"]);
  assert.throws(
    () =>
      resolveAppleNotaryCredentials(
        {
          APPLE_API_KEY: "/tmp/key.p8",
          APPLE_KEYCHAIN_PROFILE: "OpenGrove",
        },
        () => true,
      ),
    /multiple Apple notarization/,
  );

  assert.ok(windowsSigningProblems({}).length >= 3);
  assert.deepEqual(
    windowsSigningProblems(
      {
        CSC_LINK: "/tmp/release.pfx",
        CSC_KEY_PASSWORD: "secret",
        OPENGROVE_WINDOWS_SIGNING_SUBJECT: "OpenGrove",
      },
      () => true,
    ),
    [],
  );

  assert.deepEqual(windowsSigningConfigPresent({}), []);
  assert.deepEqual(windowsSigningConfigPresent({ CSC_LINK: "   " }), []);
  assert.deepEqual(
    windowsSigningConfigPresent({ CSC_LINK: "/tmp/release.pfx", OPENGROVE_WINDOWS_SIGNING_SUBJECT: "OpenGrove" }),
    ["CSC_LINK", "OPENGROVE_WINDOWS_SIGNING_SUBJECT"],
  );
}

function testReleaseUploadTokenResolution() {
  let keychainReads = 0;
  const environment = resolveReleaseUploadToken({
    env: { OPENGROVE_RELEASE_UPLOAD_TOKEN: "environment-token" },
    platform: "darwin",
    execFile: () => {
      keychainReads += 1;
      return "unused";
    },
  });
  assert.deepEqual(environment, { token: "environment-token", source: "environment" });
  assert.equal(keychainReads, 0, "the explicit environment credential must take precedence over Keychain");

  const keychain = resolveReleaseUploadToken({
    env: {},
    platform: "darwin",
    execFile: (command, args, options) => {
      keychainReads += 1;
      assert.equal(command, "security");
      assert.deepEqual(args, ["find-generic-password", "-s", "OpenGrove Release Upload", "-a", "ww", "-w"]);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
      return "keychain-token\n";
    },
  });
  assert.deepEqual(keychain, { token: "keychain-token", source: "keychain" });
  assert.equal(keychainReads, 1);

  const unsupported = resolveReleaseUploadToken({
    env: {},
    platform: "linux",
    execFile: () => {
      throw new Error("must not read Keychain outside macOS");
    },
  });
  assert.deepEqual(unsupported, { token: "", source: "missing" });
}

function testR2ReleaseCredentialResolution() {
  let keychainReads = 0;
  const environment = resolveR2ReleaseCredentials({
    env: {
      OPENGROVE_RELEASE_R2_ACCESS_KEY_ID: " environment-access ",
      OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY: " environment-secret ",
    },
    platform: "darwin",
    execFile: () => {
      keychainReads += 1;
      return "unused";
    },
  });
  assert.deepEqual(environment, {
    accessKeyId: "environment-access",
    secretAccessKey: "environment-secret",
    source: "environment",
  });
  assert.equal(keychainReads, 0, "explicit R2 environment credentials must take precedence over Keychain");

  const keychain = resolveR2ReleaseCredentials({
    env: {},
    platform: "darwin",
    execFile: (command, args, options) => {
      keychainReads += 1;
      assert.equal(command, "security");
      assert.equal(args[0], "find-generic-password");
      assert.deepEqual(args.slice(1, 5), [
        "-s",
        "OpenGrove R2 Release Upload",
        "-a",
        keychainReads === 1 ? "access-key-id" : "secret-access-key",
      ]);
      assert.equal(args.at(-1), "-w");
      assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
      return keychainReads === 1 ? "keychain-access\n" : "keychain-secret\n";
    },
  });
  assert.deepEqual(keychain, {
    accessKeyId: "keychain-access",
    secretAccessKey: "keychain-secret",
    source: "keychain",
  });
  assert.equal(keychainReads, 2);

  const unsupported = resolveR2ReleaseCredentials({
    env: {},
    platform: "linux",
    execFile: () => {
      throw new Error("must not read Keychain outside macOS");
    },
  });
  assert.deepEqual(unsupported, { accessKeyId: "", secretAccessKey: "", source: "missing" });
}

function testDesktopReleaseWorkflow() {
  const workflow = readFileSync(join(projectRoot, ".github", "workflows", "desktop-release.yml"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
  assert.match(workflow, /ref:\s*\n\s*description: Current main commit SHA or the main branch/);
  assert.match(workflow, /main_commit="\$\(git rev-parse --verify 'origin\/main\^\{commit\}'\)"/);
  assert.match(workflow, /if \[\[ "\$commit" != "\$main_commit" \]\]/);
  assert.match(
    workflow,
    /Formal tag \$expected_tag already exists; candidate gates must run before the tag is created/,
  );
  assert.doesNotMatch(workflow, /git describe --tags --exact-match/);
  assert.match(workflow, /include: \$\{\{ fromJSON\(needs\.resolve-candidate\.outputs\.mac_matrix\) \}\}/);
  const platformSelection = readFileSync(
    join(projectRoot, "scripts", "desktop-release-platform-selection.mjs"),
    "utf8",
  );
  assert.match(platformSelection, /runner: "macos-15"/);
  assert.match(platformSelection, /runner: "macos-15-intel"/);
  assert.doesNotMatch(workflow, /local_preflight_sha|LOCAL_PREFLIGHT_SHA/);
  assert.doesNotMatch(workflow, /full-validation:|Run full release validation/);
  assert.match(workflow, /environment: desktop-release/);
  assert.match(workflow, /MAC_CSC_LINK/);
  assert.match(workflow, /APPLE_API_KEY_BASE64/);
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /Configure exactly one notarization strategy/);
  assert.match(workflow, /Apple ID notarization strategy selected; no API key to materialize/);
  const macJob = workflow.slice(workflow.indexOf("  mac-release:"), workflow.indexOf("  windows-release:"));
  const macJobHeader = macJob.slice(0, macJob.indexOf("    steps:"));
  assert.match(macJobHeader, /needs: \[resolve-candidate, release-readiness, deployment-readiness, golden-replay\]/);
  assert.match(macJobHeader, /!cancelled\(\)/);
  assert.doesNotMatch(macJobHeader, /always\(\)/);
  assert.match(macJobHeader, /full_candidate != 'true'/);
  assert.match(macJobHeader, /needs\.release-readiness\.result == 'success'/);
  assert.match(macJobHeader, /needs\.deployment-readiness\.result == 'success'/);
  assert.match(macJobHeader, /needs\.golden-replay\.result == 'success'/);
  assert.doesNotMatch(macJobHeader, /secrets\./, "mac release secrets must not be job-scoped");
  const macStep = (name) => {
    const start = macJob.indexOf(`      - name: ${name}`);
    assert.notEqual(start, -1, `missing mac release step: ${name}`);
    const next = macJob.indexOf("\n      - name:", start + 1);
    return macJob.slice(start, next === -1 ? macJob.length : next);
  };
  for (const name of ["Build application", "Prepare desktop package inputs"]) {
    assert.doesNotMatch(macStep(name), /secrets\./, `${name} must not receive release secrets`);
  }
  for (const name of [
    "Check signing and notarization secrets",
    "Run release preflight",
    "Package, sign, and notarize macOS ${{ matrix.arch }}",
    "Finalize and verify distribution bytes",
  ]) {
    assert.match(macStep(name), /secrets\.MAC_CSC_LINK/, `${name} must explicitly receive signing secrets`);
  }
  assert.match(macStep("Materialize Apple API key when configured"), /secrets\.APPLE_API_KEY_BASE64/);
  assert.match(platformSelection, /ossutil-2\.3\.0-mac-arm64\.zip/);
  const windowsJob = workflow.slice(workflow.indexOf("  windows-release:"), workflow.indexOf("  release-gates:"));
  const windowsJobHeader = windowsJob.slice(0, windowsJob.indexOf("    steps:"));
  assert.match(
    windowsJobHeader,
    /needs: \[resolve-candidate, release-readiness, deployment-readiness, golden-replay\]/,
  );
  assert.match(windowsJobHeader, /!cancelled\(\)/);
  assert.doesNotMatch(windowsJobHeader, /always\(\)/);
  assert.match(windowsJobHeader, /full_candidate != 'true'/);
  assert.match(windowsJobHeader, /needs\.release-readiness\.result == 'success'/);
  assert.match(windowsJobHeader, /needs\.deployment-readiness\.result == 'success'/);
  assert.match(windowsJobHeader, /needs\.golden-replay\.result == 'success'/);
  assert.match(workflow, /node scripts\/preflight-desktop-release\.mjs/);
  const releaseBuilderConfig = readFileSync(join(projectRoot, "electron-builder.release.cjs"), "utf8");
  assert.match(releaseBuilderConfig, /OPENGROVE_ELECTRON_DIST/);
  assert.match(releaseBuilderConfig, /OPENGROVE_ELECTRON_DOWNLOAD_CACHE/);
  assert.match(workflow, /node scripts\/stage-desktop-runtime\.mjs --target windows/);
  assert.match(workflow, /electron-builder .* --win --x64 --publish never/);
  assert.match(workflow, /node scripts\/verify-desktop-release\.mjs/);
  assert.match(workflow, /node scripts\/smoke-desktop-installer\.mjs --target \$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /node scripts\/smoke-desktop-installer\.mjs --target windows-x64/);
  assert.doesNotMatch(workflow, /--legacy-process-only/);
  assert.match(workflow, /node scripts\/test-previous-desktop-update\.mjs/);
  assert.match(
    workflow,
    /Update previous release through the real updater\n\s+timeout-minutes: 20\n\s+run: node scripts\/test-previous-desktop-update\.mjs --target windows-x64/,
  );
  assert.match(workflow, /gh release list --exclude-drafts --exclude-pre-releases/);
  assert.doesNotMatch(workflow, /git tag --sort=-version:refname/);
  assert.equal((workflow.match(/\$PSNativeCommandUseErrorActionPreference = \$true/g) ?? []).length, 3);
  assert.match(workflow, /node scripts\/verify-desktop-update-metadata\.mjs --require-all/);
  assert.doesNotMatch(workflow, /--download-only/, "cloud candidates must complete the real install and restart gate");
  assert.match(workflow, /node scripts\/write-desktop-release-gate-receipt\.mjs/);
  assert.match(workflow, /Assemble immutable gated candidate/);
  const candidateResolution = workflow.slice(
    workflow.indexOf("  resolve-candidate:"),
    workflow.indexOf("  release-readiness:"),
  );
  assert.match(candidateResolution, /Verify exact Main CI and recent Nightly evidence/);
  assert.match(candidateResolution, /node scripts\/release-ci-eligibility\.mjs/);
  assert.match(candidateResolution, /--main-workflow main-ci\.yml/);
  assert.match(candidateResolution, /--nightly-workflow nightly\.yml/);
  assert.match(candidateResolution, /--max-nightly-age-hours 24/);
  assert.match(candidateResolution, /if: steps\.platforms\.outputs\.full_candidate == 'true'/);
  const readiness = workflow.slice(workflow.indexOf("  release-readiness:"), workflow.indexOf("  golden-replay:"));
  assert.match(readiness, /needs: resolve-candidate/);
  assert.match(readiness, /if: needs\.resolve-candidate\.outputs\.full_candidate == 'true'/);
  assert.match(readiness, /ref: \$\{\{ needs\.resolve-candidate\.outputs\.commit \}\}/);
  assert.match(readiness, /timeout-minutes: 15/);
  assert.doesNotMatch(readiness, /container:/);
  assert.match(readiness, /npm ci/);
  assert.match(readiness, /npm run release:readiness/);
  assert.doesNotMatch(readiness, /npm run release:check/);
  const deploymentReadiness = workflow.slice(
    workflow.indexOf("  deployment-readiness:"),
    workflow.indexOf("  golden-replay:"),
  );
  assert.match(deploymentReadiness, /if: needs\.resolve-candidate\.outputs\.full_candidate == 'true'/);
  assert.match(deploymentReadiness, /environment: desktop-release/);
  assert.match(deploymentReadiness, /ref: main/);
  assert.match(deploymentReadiness, /run: bash scripts\/install-pinned-ossutil\.sh/);
  assert.match(deploymentReadiness, /node scripts\/check-desktop-release-infrastructure\.mjs/);
  assert.match(deploymentReadiness, /secrets\.OSS_ACCESS_KEY_ID/);
  assert.match(deploymentReadiness, /secrets\.OPENGROVE_RELEASE_R2_ACCESS_KEY_ID/);
  assert.match(deploymentReadiness, /secrets\.OPENGROVE_RELEASE_UPLOAD_TOKEN/);
  const goldenReplayJob = workflow.slice(workflow.indexOf("  golden-replay:"), workflow.indexOf("  mac-release:"));
  assert.match(goldenReplayJob, /needs: resolve-candidate/);
  assert.match(goldenReplayJob, /if: needs\.resolve-candidate\.outputs\.full_candidate == 'true'/);
  const releaseGates = workflow.slice(
    workflow.indexOf("  release-gates:"),
    workflow.indexOf("  partial-platform-summary:"),
  );
  assert.match(
    releaseGates,
    /needs: \[resolve-candidate, release-readiness, deployment-readiness, golden-replay, mac-release, windows-release\]/,
  );
  assert.match(releaseGates, /needs\.release-readiness\.result == 'success'/);
  assert.match(releaseGates, /needs\.deployment-readiness\.result == 'success'/);
  assert.match(releaseGates, /needs\.golden-replay\.result == 'success'/);
  assert.match(workflow, /opengrove-\$\{\{ env\.CANDIDATE_ID \}\}-gated-candidate/);
  assert.match(workflow, /release-source\/windows-x64\.json/);
  assert.match(workflow, /first_public_release:/);
  assert.match(workflow, /first_public_release is disabled after the first public GitHub Release exists/);
  assert.match(workflow, /public-release-bootstrap\.mjs download/);
  assert.match(workflow, /vars\.OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT/);
  assert.doesNotMatch(workflow, /npm run dist:desktop:release/);
  const finalizer = readFileSync(
    join(projectRoot, ".github", "workflows", "desktop-release-finalize.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const finalizerJobHeader = finalizer.slice(finalizer.indexOf("  finalize:"), finalizer.indexOf("    steps:"));
  assert.match(finalizerJobHeader, /environment: desktop-release/);
  assert.match(finalizer, /candidate_run_id:/);
  assert.match(finalizer, /test "\$workflow_path" = '\.github\/workflows\/desktop-release\.yml'/);
  assert.match(finalizer, /git merge-base --is-ancestor "\$commit" origin\/main/);
  assert.match(finalizer, /verify-desktop-release-candidate\.mjs/);
  assert.match(finalizer, /--current-release-tag "\$current_release_tag"/);
  assert.match(finalizer, /public-release-bootstrap\.mjs previous-tag/);
  assert.doesNotMatch(finalizer, /--previous-release-tag/);
  assert.match(finalizer, /gh run download "\$CANDIDATE_RUN_ID"/);
  assert.match(finalizer, /git config user\.name "github-actions\[bot\]"/);
  assert.match(finalizer, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
  assert.match(finalizer, /gh release create "\$RELEASE_TAG"/);
  assert.doesNotMatch(finalizer, /electron-builder|publish:desktop-release|control:desktop-release|ossutil/);
  assert.match(finalizer, /desktop-release-deploy\.yml/);
  const deploy = readFileSync(join(projectRoot, ".github", "workflows", "desktop-release-deploy.yml"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.match(deploy, /environment: desktop-release/);
  const deployJobHeader = deploy.slice(deploy.indexOf("  deploy:"), deploy.indexOf("    steps:"));
  assert.doesNotMatch(deployJobHeader, /secrets\./, "deployment credentials must not be job-scoped");
  assert.match(deploy, /test "\$\(jq -r '\.path' <<< "\$run"\)" = '\.github\/workflows\/desktop-release\.yml'/);
  assert.match(deploy, /git merge-base --is-ancestor "\$commit" origin\/main/);
  assert.match(deploy, /gh release view "\$REQUESTED_TAG"/);
  assert.doesNotMatch(deploy, /git checkout --detach "\$commit"/);
  assert.match(deploy, /candidate_package_json="\$RUNNER_TEMP\/desktop-release-candidate-package\.json"/);
  assert.match(deploy, /git show "\$commit:package\.json" > "\$candidate_package_json"/);
  assert.match(deploy, /deployment_commit="\$\(git rev-parse HEAD\)"/);
  assert.match(deploy, /gh run download "\$CANDIDATE_RUN_ID"/);
  assert.match(deploy, /verify-desktop-release-candidate\.mjs/);
  assert.match(deploy, /current_release_tag="\$\(gh release list --exclude-drafts --exclude-pre-releases/);
  assert.match(deploy, /--current-release-tag "\$current_release_tag"/);
  assert.doesNotMatch(deploy, /--previous-release-tag/);
  assert.match(deploy, /node scripts\/publish-desktop-release\.mjs/);
  assert.match(deploy, /--release-package-json "\$CANDIDATE_PACKAGE_JSON"/);
  assert.match(deploy, /OPENGROVE_RELEASE_CANDIDATE_COMMIT:/);
  assert.match(deploy, /OPENGROVE_RELEASE_DEPLOYMENT_COMMIT:/);
  assert.match(deploy, /--append-timing/);
  assert.match(deploy, /--phase install-ossutil/);
  assert.match(deploy, /-- bash scripts\/install-pinned-ossutil\.sh/);
  assert.match(deploy, /--phase check-deployment-credentials/);
  assert.match(deploy, /node scripts\/check-desktop-release-infrastructure\.mjs/);
  assert.match(deploy, /OPENGROVE_RELEASE_UPLOAD_TOKEN: \$\{\{ secrets\.OPENGROVE_RELEASE_UPLOAD_TOKEN \}\}/);
  assert.match(deploy, /RELEASE_TIMING_FILE=\$RUNNER_TEMP\/desktop-release-deploy-timing\.json/);
  assert.doesNotMatch(deploy, /RELEASE_TIMING_FILE: release\/desktop/);
  assert.doesNotMatch(deploy, /electron-builder|control:desktop-release/);
  assert.match(deploy, /uses: actions\/setup-node@v4\s+with:\s+node-version: 24/);
  const ossutilInstaller = readFileSync(join(projectRoot, "scripts", "install-pinned-ossutil.sh"), "utf8");
  const ossutilSha256 = "3ae4d9fc85a7a6e9f5654d1599766f1a3a42a3692870887b5ae9338d582ef65a";
  assert.equal((`${workflow}\n${deploy}`.match(new RegExp(ossutilSha256, "g")) ?? []).length, 0);
  assert.equal((ossutilInstaller.match(new RegExp(ossutilSha256, "g")) ?? []).length, 1);
  const control = readFileSync(
    join(projectRoot, ".github", "workflows", "desktop-release-control.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(control, /options:\s*\n\s*- promote\s*\n\s*- rollback\s*\n\s*- withdraw/);
  assert.match(control, /environment: desktop-release/);
  const controlJobHeader = control.slice(control.indexOf("  control:"), control.indexOf("    steps:"));
  assert.doesNotMatch(controlJobHeader, /secrets\./, "release control credentials must not be job-scoped");
  assert.match(control, /control-desktop-release\.mjs/);
  assert.match(control, /--finish-run/);
  assert.match(control, /uses: actions\/setup-node@v4\s+with:\s+node-version: 24/);
  assert.doesNotMatch(control, /node-version: 24\s+cache: npm/);
  assert.match(control, /Release upload token is not configured/);
  assert.match(control, /withdraw does not accept a client release number/);
  assert.match(control, /promote and rollback require a positive integer client release number/);
  const ci = readFileSync(join(projectRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.match(ci, /npm run check:static:base/);
  assert.match(packageJson.scripts["check:static:base"], /npm run check:typescript-runtime-compat/);
  const publisher = readFileSync(join(projectRoot, "scripts", "publish-desktop-release.mjs"), "utf8");
  const preparer = readFileSync(join(projectRoot, "scripts", "prepare-desktop-release.mjs"), "utf8");
  assert.match(publisher, /"--release-package-json",\s+releasePackageJsonPath/);
  assert.match(preparer, /args\.releasePackageJson \?\? join\(projectRoot, "package\.json"\)/);
  const timingRunner = readFileSync(join(projectRoot, "scripts", "run-release-timing-phase.mjs"), "utf8");
  assert.match(timingRunner, /runTimedPhase\(timing, args\.phase/);
  assert.match(timingRunner, /timing\.finishRun\(\{ status: "failed", error \}\)/);
  const failedTimingPath = join(tempRoot, "failed-wrapper-timing.json");
  const failedTimingRun = spawnSync(
    process.execPath,
    [
      "scripts/run-release-timing-phase.mjs",
      "--timing-file",
      failedTimingPath,
      "--command",
      "test-release-timing-wrapper",
      "--version",
      "1.0.0",
      "--phase",
      "preserve-exit-code",
      "--reset",
      "--",
      process.execPath,
      "-e",
      "process.exit(7)",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(failedTimingRun.status, 7, failedTimingRun.stderr);
  const failedTimingReport = JSON.parse(readFileSync(failedTimingPath, "utf8"));
  assert.equal(failedTimingReport.status, "failed");
  assert.equal(failedTimingReport.phases[0].status, "failed");
  const smoke = readFileSync(join(projectRoot, "scripts", "smoke-desktop-installer.mjs"), "utf8");
  assert.match(smoke, /hdiutil/);
  assert.match(smoke, /\/S/);
  assert.match(smoke, /installTimeoutMs = 300_000/);
  assert.match(smoke, /release-gate-ready\.json/);
  assert.match(smoke, /spawn\(executablePath/);
  assert.match(smoke, /--legacy-process-only/);
  assert.doesNotMatch(smoke, /_electron|electron\.launch/);
  const goldenReplay = readFileSync(
    join(projectRoot, ".github", "workflows", "desktop-gate-replay.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(goldenReplay, /--legacy-process-only/);
  assert.match(goldenReplay, /desktop-release-golden-v0\.6\.0\.json/);
  assert.match(goldenReplay, /value\.tag/);
  assert.doesNotMatch(goldenReplay, /v0\.5\.18/);
  const goldenManifest = JSON.parse(
    readFileSync(join(projectRoot, "scripts", "fixtures", "desktop-release-golden-v0.6.0.json"), "utf8"),
  );
  assert.equal(goldenManifest.tag, "v0.6.0");
  assert.equal(goldenManifest.gitCommit, "0bf60fddb84ae99403738b9deb0fadfecec501f2");
  assert.deepEqual(goldenManifest.distInventory, {
    fileCount: 324,
    sha256: "0c3ba0434c297043ea200930c68e8f2a89d2134acfda1cd81ac5336e441ba43c",
  });
  const updateSmoke = readFileSync(join(projectRoot, "scripts", "test-previous-desktop-update.mjs"), "utf8");
  assert.match(updateSmoke, /chromium\.connectOverCDP/);
  assert.match(updateSmoke, /--remote-debugging-port=0/);
  assert.doesNotMatch(updateSmoke, /_electron|electron\.launch/);
  assert.match(updateSmoke, /checkForClientUpdate/);
  assert.match(updateSmoke, /hasSavedAuthSession/);
  assert.match(updateSmoke, /seedFixtureAuthCookies/);
  assert.match(updateSmoke, /waitForDesktopBridgeHealth/);
  assert.match(updateSmoke, /health\.body\?\.name === "opengrove-local-bridge"/);
  assert.match(updateSmoke, /pre-authentication background check/);
  assert.match(updateSmoke, /installClientUpdate/);
  assert.match(updateSmoke, /installRequestTimeoutMs = 180_000/);
  assert.match(updateSmoke, /electronProcess\.exitCode === null/);
  assert.match(updateSmoke, /closeAllConnections/);
  assert.match(updateSmoke, /windows-installer-gate\.log/);
  assert.match(updateSmoke, /OPENGROVE_DESKTOP_RELEASE_GATE_LOG/);
  assert.match(updateSmoke, /windows-installer-processes\.txt/);
  assert.match(updateSmoke, /readAsarPackageVersion/);
  assert.match(updateSmoke, /sanitizedWindowsPowerShellEnv/);
  assert.match(updateSmoke, /removeTemporaryTree/);
  assert.match(updateSmoke, /previous.*version/i);
  assert.doesNotMatch(updateSmoke, /pgrep["'], \[["']-f["']/);
  const desktopClientUpdateManager = readFileSync(join(projectRoot, "desktop", "client-update-manager.ts"), "utf8");
  assert.match(
    desktopClientUpdateManager,
    /quitAndInstall\(process\.platform === "win32", true\)/,
    "a user-confirmed Windows update must not wait on the assisted NSIS install-mode page",
  );
  assert.doesNotMatch(desktopClientUpdateManager, /quitAndInstall\(false, true\)/);
  assert.doesNotMatch(desktopClientUpdateManager, /OPENGROVE_UPDATE_FEED_URL/);
  const desktopMain = readFileSync(join(projectRoot, "desktop", "main.ts"), "utf8");
  assert.match(desktopMain, /OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR/);
  assert.match(desktopMain, /release-gate-ready\.json/);
  assert.match(desktopMain, /desktopMarker/);
  assert.match(desktopMain, /healthStatus/);
  assert.match(desktopMain, /\/health/);
  assert.match(smoke, /OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR/);
}

async function testDesktopReleaseInfrastructureReadiness() {
  const calls = [];
  const env = {
    OPENGROVE_RELEASE_OSS_REGION: "cn-test",
    OPENGROVE_RELEASE_OSS_BUCKET: "oss-release-test",
    OPENGROVE_RELEASE_OSS_ENDPOINT: "oss-test.example.test",
    OPENGROVE_RELEASE_R2_BUCKET: "r2-release-test",
    OPENGROVE_RELEASE_R2_ACCOUNT_ID: "r2-account-test",
    OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT: "https://download.example.test/desktop",
    OPENGROVE_DESKTOP_RELEASE_UPDATER_ROOT: "https://download.example.test/desktop/updater",
    OPENGROVE_CLIENT_RELEASES_URL: "https://api.example.test/v1/admin/client/releases",
    OSS_ACCESS_KEY_ID: "oss-access-key",
    OSS_ACCESS_KEY_SECRET: "oss-secret-key",
    OPENGROVE_RELEASE_R2_ACCESS_KEY_ID: "r2-access-key",
    OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY: "r2-secret-key",
    OPENGROVE_RELEASE_UPLOAD_TOKEN: "ww-release-token",
  };
  const r2Client = {
    async send(command) {
      calls.push({ kind: "r2", command });
      return {};
    },
  };
  const executeFile = async (command, args, options) => {
    calls.push({ kind: "oss", command, args, options });
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    calls.push({ kind: "ww", url, options });
    return { status: 404, ok: false };
  };
  const run = (overrides = {}) =>
    checkDesktopReleaseInfrastructure({
      env,
      r2Client,
      executeFile,
      fetchImpl,
      wait: async () => {},
      warn: () => {},
      ...overrides,
    });

  const result = await run();
  assert.deepEqual(result, { oss: "authenticated", r2: "authenticated", ww: "origin-reachable" });
  const oss = calls.find((call) => call.kind === "oss");
  assert.equal(oss.command, "ossutil");
  assert.deepEqual(oss.args, [
    "ls",
    "oss://oss-release-test/",
    "--limited-num",
    "1",
    "--region",
    "cn-test",
    "--endpoint",
    "oss-test.example.test",
  ]);
  assert.equal(oss.options.env.OSS_ACCESS_KEY_ID, "oss-access-key");
  assert.equal(oss.options.env.OSS_ACCESS_KEY_SECRET, "oss-secret-key");
  const r2 = calls.find((call) => call.kind === "r2");
  assert.equal(r2.command.constructor.name, "HeadBucketCommand");
  assert.deepEqual(r2.command.input, { Bucket: "r2-release-test" });
  const ww = calls.find((call) => call.kind === "ww");
  assert.equal(ww.url, "https://api.example.test/v1/admin/client/releases");
  assert.equal(ww.options.method, "HEAD");
  assert.equal(ww.options.headers.authorization, "Bearer ww-release-token");

  for (const [override, expected] of [
    [
      { OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT: "not-a-url" },
      /OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT must be a valid URL/,
    ],
    [
      { OPENGROVE_DESKTOP_RELEASE_UPDATER_ROOT: "http://download.example.test/updater" },
      /OPENGROVE_DESKTOP_RELEASE_UPDATER_ROOT must use HTTPS/,
    ],
    [
      { OPENGROVE_CLIENT_RELEASES_URL: "https://api.example.test/v1/admin/client/release" },
      /must use the exact \/v1\/admin\/client\/releases path/,
    ],
    [
      { OPENGROVE_CLIENT_RELEASES_URL: "https://api.example.test/v1/admin/client/releases?probe=1" },
      /without query or fragment/,
    ],
  ]) {
    let networkCalled = false;
    await assert.rejects(
      run({
        env: { ...env, ...override },
        executeFile: async () => {
          networkCalled = true;
        },
        fetchImpl: async () => {
          networkCalled = true;
        },
      }),
      expected,
    );
    assert.equal(networkCalled, false, "invalid URLs must fail before network access");
  }

  let networkCalled = false;
  await assert.rejects(
    run({
      env: { ...env, OPENGROVE_RELEASE_UPLOAD_TOKEN: "" },
      executeFile: async () => {
        networkCalled = true;
      },
      fetchImpl: async () => {
        networkCalled = true;
      },
    }),
    /Missing desktop-release environment configuration: OPENGROVE_RELEASE_UPLOAD_TOKEN/,
  );
  assert.equal(networkCalled, false, "missing configuration must fail before network access");

  let downstreamCalled = false;
  await assert.rejects(
    run({
      executeFile: async () => {
        throw new Error("OSS unavailable");
      },
      r2Client: {
        async send() {
          downstreamCalled = true;
        },
      },
      fetchImpl: async () => {
        downstreamCalled = true;
      },
    }),
    /OSS unavailable/,
  );
  assert.equal(downstreamCalled, false, "OSS failure must stop later probes");

  downstreamCalled = false;
  await assert.rejects(
    run({
      executeFile: async () => ({ stdout: "", stderr: "" }),
      r2Client: {
        async send() {
          throw new Error("R2 unavailable");
        },
      },
      fetchImpl: async () => {
        downstreamCalled = true;
      },
    }),
    /R2 unavailable/,
  );
  assert.equal(downstreamCalled, false, "R2 failure must stop the ww probe");

  for (const status of [401, 403]) {
    let attempts = 0;
    await assert.rejects(
      run({
        fetchImpl: async () => {
          attempts += 1;
          return { status };
        },
      }),
      new RegExp(`ww release API readiness failed: HTTP ${status}`),
    );
    assert.equal(attempts, 1, `HTTP ${status} must fail without retry`);
  }

  const retryWaits = [];
  let serverAttempts = 0;
  await assert.rejects(
    run({
      fetchImpl: async () => {
        serverAttempts += 1;
        return { status: 500 };
      },
      wait: async (milliseconds) => {
        retryWaits.push(milliseconds);
      },
    }),
    /ww release API readiness failed: HTTP 500/,
  );
  assert.equal(serverAttempts, 3);
  assert.deepEqual(retryWaits, [1_000, 2_000]);

  const networkRetryWaits = [];
  let networkAttempts = 0;
  assert.deepEqual(
    await run({
      fetchImpl: async () => {
        networkAttempts += 1;
        if (networkAttempts < 3) throw new Error("temporary network failure");
        return { status: 404 };
      },
      wait: async (milliseconds) => {
        networkRetryWaits.push(milliseconds);
      },
    }),
    { oss: "authenticated", r2: "authenticated", ww: "origin-reachable" },
  );
  assert.equal(networkAttempts, 3);
  assert.deepEqual(networkRetryWaits, [1_000, 2_000]);
}

function testDesktopReleasePackageIdentity() {
  const path = join(tempRoot, "candidate-package.json");
  writeFileSync(path, `${JSON.stringify({ version: "9.8.7", clientReleaseNumber: 12345 })}\n`);
  assert.deepEqual(readDesktopReleasePackageIdentity(path), {
    version: "9.8.7",
    clientReleaseNumber: 12345,
  });
  writeFileSync(path, `${JSON.stringify({ version: "9.8.7", clientReleaseNumber: 0 })}\n`);
  assert.throws(() => readDesktopReleasePackageIdentity(path), /invalid clientReleaseNumber/);
}

function testDesktopPackagingPortability() {
  assert.equal(desktopAsarLookupPath("\\LICENSE"), "LICENSE");
  assert.equal(
    desktopAsarLookupPath("\\assets\\brand\\opengrove-readme-lockup.svg"),
    "assets\\brand\\opengrove-readme-lockup.svg",
  );
  assert.equal(normalizeDesktopAsarPath("\\LICENSE"), "LICENSE");
  assert.equal(normalizeDesktopAsarPath("/dist/server/desktop-bridge-entry.js"), "dist/server/desktop-bridge-entry.js");
  assert.equal(
    normalizeDesktopAsarPath("\\dist\\server\\desktop-bridge-entry.js"),
    "dist/server/desktop-bridge-entry.js",
  );

  const warnings = [];
  removeTemporaryTree("C:\\locked", {
    platform: "win32",
    remove: () => {
      const error = new Error("locked");
      error.code = "EPERM";
      throw error;
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.throws(
    () =>
      removeTemporaryTree("/locked", {
        platform: "darwin",
        remove: () => {
          const error = new Error("locked");
          error.code = "EPERM";
          throw error;
        },
      }),
    /locked/,
  );

  assert.equal(windowsPowerShellExecutable, "powershell.exe");
  const powershellEnv = sanitizedWindowsPowerShellEnv(
    { Path: "C:\\Windows", PSModulePath: "pwsh-only", KEEP: "yes" },
    {
      OPENGROVE_VERIFY_TARGET: "C:\\OpenGrove.exe",
    },
  );
  assert.equal(powershellEnv.PSModulePath, undefined);
  assert.equal(powershellEnv.KEEP, "yes");
  assert.equal(powershellEnv.OPENGROVE_VERIFY_TARGET, "C:\\OpenGrove.exe");
  const verifier = readFileSync(join(projectRoot, "scripts", "verify-desktop-release.mjs"), "utf8");
  assert.match(verifier, /Import-Module Microsoft\.PowerShell\.Security/);
  assert.match(verifier, /windowsPowerShellExecutable/);
}

function testNodePackageManagerInvocation() {
  assert.deepEqual(nodePackageManagerInvocation("npm", ["run", "build"], { platform: "darwin" }), {
    command: "npm",
    args: ["run", "build"],
  });
  assert.deepEqual(
    nodePackageManagerInvocation("npm", ["run", "release:check"], {
      platform: "win32",
      npmExecPath: "C:\\npm\\bin\\npm-cli.js",
      nodePath: "C:\\node\\node.exe",
      pathExists: () => true,
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\bin\\npm-cli.js", "run", "release:check"],
    },
  );
  assert.deepEqual(
    nodePackageManagerInvocation("npx", ["electron-builder"], {
      platform: "win32",
      npmExecPath: "C:\\npm\\bin\\npm-cli.js",
      nodePath: "C:\\node\\node.exe",
      pathExists: () => true,
    }),
    {
      command: "C:\\node\\node.exe",
      args: [win32.join("C:\\npm\\bin", "npx-cli.js"), "electron-builder"],
    },
  );
  assert.deepEqual(
    nodePackageManagerInvocation("npm", ["run", "build"], {
      platform: "win32",
      environment: {},
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "run", "build"],
    },
    "a direct Node entry point must fall back to the Windows command processor when npm_execpath is absent",
  );
  assert.deepEqual(
    nodePackageManagerInvocation("npx", ["electron-builder"], {
      platform: "win32",
      npmExecPath: "C:\\pnpm\\pnpm.cjs",
      nodePath: "C:\\node\\node.exe",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npx.cmd", "electron-builder"],
    },
    "a non-npm npm_execpath must not be mistaken for npm's npx-cli.js",
  );
}

async function testAsarPackageVersionRefresh() {
  const first = join(tempRoot, "asar-first");
  const second = join(tempRoot, "asar-second");
  const archive = join(tempRoot, "replaceable-app.asar");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "package.json"), '{"version":"0.5.7"}');
  writeFileSync(join(second, "package.json"), '{"version":"0.5.13-candidate"}');
  await createPackage(first, archive);
  assert.equal(readAsarPackageVersion(archive), "0.5.7");
  await createPackage(second, archive);
  assert.equal(readAsarPackageVersion(archive), "0.5.13-candidate");
}

function testDesktopPackageSecretScan() {
  for (const content of [
    'const config = { apiKey: "sk-example-secret" };',
    'const config = {"registryToken":"registry-secret"};',
    "x-opengrove-token: actual-token",
    `-----BEGIN ${"PRIVATE"} KEY-----`,
  ]) {
    assert.equal(containsPossibleDesktopPackageSecret(content), true, content);
  }
  for (const content of [
    '{"settings.apiKey":"API key","settings.registryToken":"Registry token"}',
    '{"settings.apiKeyPlaceholder":"Paste provider key or ENV=key"}',
  ]) {
    assert.equal(containsPossibleDesktopPackageSecret(content), false, content);
  }
}

function testProcessCommandPathAliases() {
  const executable = "/var/folders/release gate/OpenGrove.app/Contents/MacOS/OpenGrove";
  const canonical = "/private/var/folders/release gate/OpenGrove.app/Contents/MacOS/OpenGrove";
  const canonicalize = () => canonical;
  assert.equal(processCommandMatchesExecutable(canonical, executable, { canonicalize }), true);
  assert.equal(processCommandMatchesExecutable(`${canonical} --updated`, executable, { canonicalize }), true);
  assert.equal(processCommandMatchesExecutable(`"${canonical}" --updated`, executable, { canonicalize }), true);
  assert.equal(processCommandMatchesExecutable(`${canonical}-helper`, executable, { canonicalize }), false);
}

function testWindowsExactProcessControl() {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 1 ? 0 : 1 };
  };
  const path = "C:\\Program Files\\OpenGrove\\OpenGrove.exe";
  stopWindowsExactExecutable(path, { run, env: { KEEP: "yes", PSModulePath: "remove-me" } });
  assert.equal(isWindowsExactExecutableRunning(path, { run, env: { KEEP: "yes" } }), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args, ["-NoProfile", "-Command", stopWindowsExactExecutableScript]);
  assert.deepEqual(calls[1].args, ["-NoProfile", "-Command", windowsExactExecutableRunningScript]);
  assert.equal(calls[0].options.env.OPENGROVE_GATE_EXE, path);
  assert.equal(calls[0].options.env.PSModulePath, undefined);
  assert.match(stopWindowsExactExecutableScript, /ExecutablePath -eq \$env:OPENGROVE_GATE_EXE/);
  assert.match(windowsExactExecutableRunningScript, /ExecutablePath -eq \$env:OPENGROVE_GATE_EXE/);
  assert.doesNotMatch(stopWindowsExactExecutableScript, /-Name|taskkill|\*-like/);
}

function testWindowsInstallerGateState() {
  const registry = new Map();
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    const operation = args[0];
    const name = args[args.indexOf("/v") + 1];
    if (operation === "QUERY") {
      if (!registry.has(name)) return { status: 1, stdout: "", stderr: "missing" };
      return { status: 0, stdout: `    ${name}    REG_SZ    ${registry.get(name)}\r\n`, stderr: "" };
    }
    if (operation === "ADD") {
      registry.set(name, args[args.indexOf("/d") + 1]);
      return { status: 0, stdout: "ok", stderr: "" };
    }
    registry.delete(name);
    return { status: 0, stdout: "ok", stderr: "" };
  };
  const state = seedWindowsInstallerFirewallState("C:\\release gate\\installed", { platform: "win32", run });
  assert.equal(windowsInstallerFirewallRegistryKey, "HKCU\\Software\\OpenGrove\\Installer");
  assert.equal(state.program, "C:\\release gate\\installed\\OpenGrove.exe");
  assert.equal(state.rule, "OpenGrove loopback TCP - C:\\release gate\\installed");
  assert.equal(registry.get("LoopbackFirewallProgram"), state.program);
  assert.equal(registry.get("LoopbackFirewallRule"), state.rule);
  state.restore();
  assert.equal(registry.size, 0);
  assert.equal(calls.filter((args) => args[0] === "QUERY").length, 2);
  assert.equal(calls.filter((args) => args[0] === "ADD").length, 2);
  assert.equal(calls.filter((args) => args[0] === "DELETE").length, 2);
}

async function testCrc64Xz() {
  assert.equal(crc64Xz(Buffer.from("123456789")), "11051210869376104954");
  const path = join(tempRoot, "crc64-vector.txt");
  writeFileSync(path, "123456789");
  assert.equal(await crc64XzFile(path), "11051210869376104954");
}

async function testRemoteMetadata() {
  const bytes = Buffer.from("oss-head-metadata");
  const crc64 = crc64Xz(bytes);
  const server = createServer((request, response) => {
    if (request.url === "/malformed") {
      response.writeHead(200, {
        "content-length": String(bytes.length),
        "x-oss-hash-crc64ecma": "not-a-decimal",
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-length": String(bytes.length),
      "x-oss-hash-crc64ecma": crc64,
      etag: '"head-test"',
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await readRemoteFileMetadata(`${base}/artifact`), {
      size: bytes.length,
      crc64,
      etag: '"head-test"',
      url: `${base}/artifact`,
    });
    await assert.rejects(readRemoteFileMetadata(`${base}/malformed`), /invalid x-oss-hash-crc64ecma/i);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

async function testR2ImmutableUpload() {
  const localPath = join(tempRoot, "r2-release.dmg");
  const bytes = Buffer.from("immutable-r2-release");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const expectedSha256Base64 = Buffer.from(expectedSha256, "hex").toString("base64");
  writeFileSync(localPath, bytes);
  let stored = null;
  let putRequests = 0;
  let getRequests = 0;
  let readbackRetryWaits = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.match(request.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=test-access\//);
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "HEAD" && requestUrl.pathname === "/opengrove-releases/") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "HEAD") {
        if (!stored) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-length": String(stored.bytes.length),
          "x-amz-meta-sha256": stored.sha256,
          "x-amz-checksum-sha256": stored.checksumSha256,
        });
        response.end();
        return;
      }
      if (request.method === "GET") {
        getRequests += 1;
        if (!stored) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-length": String(stored.bytes.length) });
        response.end(stored.bytes);
        return;
      }
      assert.equal(request.method, "PUT");
      assert.equal(request.headers["if-none-match"], "*");
      assert.equal(request.headers["x-amz-meta-sha256"], expectedSha256);
      assert.equal(request.headers["x-amz-checksum-sha256"], undefined);
      assert.equal(request.headers["cache-control"], "public, max-age=31536000, immutable");
      putRequests += 1;
      if (stored) {
        response.writeHead(412);
        response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const uploadedBytes = Buffer.concat(chunks);
      assert.equal(createHash("sha256").update(uploadedBytes).digest("base64"), expectedSha256Base64);
      stored = {
        bytes: uploadedBytes,
        sha256: request.headers["x-amz-meta-sha256"],
        checksumSha256: expectedSha256Base64,
      };
      response.writeHead(200, { etag: '"test"' });
      response.end();
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  let proxyRequests = 0;
  const proxy = createServer((request, response) => {
    proxyRequests += 1;
    const upstream = createHttpRequest(
      new URL(request.url),
      {
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
  try {
    const config = {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      accountId: "test-account",
      bucket: "opengrove-releases",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      localPath,
      objectKey: "opengrove/releases/v-test/OpenGrove-test.dmg",
      filename: "OpenGrove-test.dmg",
      sha256: expectedSha256,
      contentType: "application/x-apple-diskimage",
      attempts: 3,
    };
    const dependencies = {
      env: {
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      },
      wait: async () => {
        readbackRetryWaits += 1;
      },
    };
    assert.deepEqual(await verifyR2ReleaseAccess(config, dependencies), {
      status: "authenticated",
    });
    assert.deepEqual(await ensureImmutableR2Object(config, dependencies), {
      status: "uploaded",
      size: bytes.length,
    });
    assert.deepEqual(stored.bytes, bytes);
    assert.deepEqual(await ensureImmutableR2Object(config, dependencies), {
      status: "existing",
      size: bytes.length,
    });
    assert.equal(putRequests, 1, "an identical immutable object must be reused without another PUT");
    assert.equal(getRequests, 2, "an existing immutable object must be read back before it is reused");
    assert.ok(proxyRequests >= 3, "R2 HEAD and PUT requests must use the enabled environment proxy");

    stored.bytes = Buffer.alloc(bytes.length, "x");
    const getsBeforeCorruptReadback = getRequests;
    const waitsBeforeCorruptReadback = readbackRetryWaits;
    await assert.rejects(
      ensureImmutableR2Object(config, dependencies),
      /R2 object verification failed/,
      "matching self-reported metadata must not hide different stored bytes",
    );
    assert.equal(getRequests, getsBeforeCorruptReadback + 1, "deterministically corrupt R2 bytes must not be retried");
    assert.equal(readbackRetryWaits, waitsBeforeCorruptReadback, "integrity mismatches must fail without retry delay");

    stored.bytes = bytes;
    stored.sha256 = "0".repeat(64);
    await assert.rejects(ensureImmutableR2Object(config, dependencies), /immutable object conflict/);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      proxy.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

async function testR2ReadbackRetriesInterruptedStreams() {
  const localPath = join(tempRoot, "r2-readback-retry.dmg");
  const bytes = Buffer.from("retry-the-whole-r2-readback");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(localPath, bytes);
  let getAttempts = 0;
  const client = {
    async send(command) {
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentLength: bytes.length, Metadata: { sha256: expectedSha256 } };
      }
      if (command.constructor.name !== "GetObjectCommand") {
        throw new Error(`unexpected R2 command: ${command.constructor.name}`);
      }
      getAttempts += 1;
      if (getAttempts === 1) {
        return {
          Body: (async function* interruptedBody() {
            yield bytes.subarray(0, 5);
            throw new Error("simulated interrupted R2 readback");
          })(),
        };
      }
      return {
        Body: (async function* completeBody() {
          yield bytes;
        })(),
      };
    },
  };

  assert.deepEqual(
    await ensureImmutableR2Object(
      {
        bucket: "opengrove-releases",
        localPath,
        objectKey: "opengrove/releases/v-test/OpenGrove-readback-retry.dmg",
        sha256: expectedSha256,
        attempts: 2,
      },
      { client, wait: async () => {} },
    ),
    {
      status: "existing",
      size: bytes.length,
    },
  );
  assert.equal(getAttempts, 2, "an interrupted response body must restart the whole GET request");
}

async function testR2MultipartUploadRetries() {
  const partSize = 5 * 1024 * 1024;
  const localPath = join(tempRoot, "r2-multipart-release.dmg");
  const bytes = Buffer.alloc(partSize * 2 + 73, "r2-multipart-release");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(localPath, bytes);
  const uploadedParts = new Map();
  let stored = null;
  let firstPartAttempts = 0;
  let multipartCreates = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.match(request.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=test-access\//);
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "HEAD") {
        if (!stored) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-length": String(stored.length),
          "x-amz-meta-sha256": expectedSha256,
        });
        response.end();
        return;
      }
      if (request.method === "GET") {
        if (!stored) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-length": String(stored.length) });
        response.end(stored);
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        multipartCreates += 1;
        assert.equal(request.headers["x-amz-checksum-algorithm"], undefined);
        assert.equal(request.headers["x-amz-meta-sha256"], expectedSha256);
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          [
            '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
            "<Bucket>opengrove-releases</Bucket>",
            "<Key>opengrove/releases/v-test/OpenGrove-multipart-test.dmg</Key>",
            "<UploadId>test-upload</UploadId>",
            "</InitiateMultipartUploadResult>",
          ].join(""),
        );
        return;
      }
      if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        const partNumber = Number(url.searchParams.get("partNumber"));
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const part = Buffer.concat(chunks);
        assert.equal(request.headers["x-amz-checksum-sha256"], undefined);
        if (partNumber === 1) {
          firstPartAttempts += 1;
          if (firstPartAttempts === 1) {
            response.writeHead(500, { "content-type": "application/xml" });
            response.end("<Error><Code>InternalError</Code><Message>retry this part</Message></Error>");
            return;
          }
        }
        uploadedParts.set(partNumber, part);
        response.writeHead(200, {
          etag: `\"part-${partNumber}\"`,
        });
        response.end();
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        assert.equal(request.headers["if-none-match"], "*");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const completionBody = Buffer.concat(chunks).toString("utf8");
        assert.doesNotMatch(completionBody, /<ChecksumSHA256>/);
        stored = Buffer.concat(
          [...uploadedParts.entries()].sort(([left], [right]) => left - right).map(([, part]) => part),
        );
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          [
            '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
            "<Location>http://127.0.0.1/opengrove-releases/test</Location>",
            "<Bucket>opengrove-releases</Bucket>",
            "<Key>opengrove/releases/v-test/OpenGrove-multipart-test.dmg</Key>",
            '<ETag>"multipart-3"</ETag>',
            "</CompleteMultipartUploadResult>",
          ].join(""),
        );
        return;
      }
      if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(405);
      response.end();
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/xml" });
      response.end(`<Error><Code>InternalError</Code><Message>${String(error)}</Message></Error>`);
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const config = {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      accountId: "test-account",
      bucket: "opengrove-releases",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      localPath,
      objectKey: "opengrove/releases/v-test/OpenGrove-multipart-test.dmg",
      filename: "OpenGrove-multipart-test.dmg",
      sha256: expectedSha256,
      contentType: "application/x-apple-diskimage",
      attempts: 2,
      partSize,
      queueSize: 1,
    };
    assert.deepEqual(await ensureImmutableR2Object(config), {
      status: "uploaded",
      size: bytes.length,
    });
    assert.deepEqual(stored, bytes);
    assert.equal(firstPartAttempts, 2, "a failed multipart part must be resent from the beginning");
    assert.equal(uploadedParts.size, 3);
    assert.deepEqual(await ensureImmutableR2Object(config), {
      status: "existing",
      size: bytes.length,
    });
    assert.equal(multipartCreates, 1, "an existing multipart object must be reused without another upload");
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

function testDesktopPackageInventory() {
  assert.deepEqual(
    desktopDistInventory([
      "/node_modules/example/index.js",
      "/dist/server/desktop-bridge-entry.js",
      "dist/runtime/context-token-budget.js",
    ]),
    {
      fileCount: 2,
      sha256: createHash("sha256")
        .update("dist/runtime/context-token-budget.js\ndist/server/desktop-bridge-entry.js\n")
        .digest("hex"),
    },
  );
  assert.deepEqual(
    desktopPackageInventoryProblems({
      sourceFiles: ["dist/runtime/context-token-budget.js", "dist/server/desktop-bridge-entry.js"],
      packagedFiles: ["/dist/runtime/context-token-budget.js", "/dist/server/desktop-bridge-entry.js"],
      resourceFiles: ["app-update.yml"],
      appUpdateConfig: {
        provider: "generic",
        url: "https://desktop-updates.invalid/",
        updaterCacheDirName: "opengrove-updater",
      },
    }),
    [],
  );
  assert.match(
    desktopPackageInventoryProblems({
      sourceFiles: ["dist/runtime/context-token-budget.js"],
      packagedFiles: [],
      resourceFiles: [],
    }).join("\n"),
    /context-token-budget\.js.*app\.asar|app-update\.yml/s,
  );
  assert.match(
    desktopPackageInventoryProblems({
      sourceFiles: ["dist/runtime/context-token-budget.js"],
      packagedFiles: ["dist/runtime/context-token-budget.js", "dist/runtime/stale-runtime.js"],
      resourceFiles: ["app-update.yml"],
      appUpdateConfig: {
        provider: "generic",
        url: "https://desktop-updates.invalid/",
        updaterCacheDirName: "opengrove-updater",
      },
    }).join("\n"),
    /unexpected.*dist\/runtime\/stale-runtime\.js/,
  );
  assert.match(
    desktopPackageInventoryProblems({
      sourceFiles: [],
      packagedFiles: [],
      resourceFiles: ["app-update.yml"],
      appUpdateConfig: {
        provider: "generic",
        url: "https://wrong.example.test/",
        updaterCacheDirName: "opengrove-updater",
      },
    }).join("\n"),
    /bootstrap URL/,
  );
  assert.match(
    desktopPackageInventoryProblems({
      sourceFiles: [],
      packagedFiles: [],
      resourceFiles: ["app-update.yml"],
      requiredPackageFiles: requiredDesktopRuntimePackageFiles,
    }).join("\n"),
    /yaml\/dist\/doc\/directives\.js/,
  );
  for (const path of [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
  ]) {
    assert.equal(
      requiredDesktopRuntimePackageFiles.includes(path),
      true,
      `${path} must be required in desktop artifacts`,
    );
  }
  assert.deepEqual(
    historicalDesktopRuntimePackageFiles,
    [
      "node_modules/@opengrove/agent-protocol/dist/locale-registry.js",
      "node_modules/@opengrove/agent-protocol/package.json",
      "node_modules/yaml/dist/doc/directives.js",
    ],
    "the immutable v0.6.0 replay must retain its original package requirements",
  );
  assert.deepEqual(
    historicalDesktopRuntimeForbiddenPackagePrefixes,
    [
      "node_modules/@milkdown/crepe/",
      "node_modules/@milkdown/kit/",
      "node_modules/@vidstack/react/",
      "node_modules/react-markdown/",
      "node_modules/remark-gfm/",
    ],
    "the immutable v0.6.0 replay must retain its original absence requirements",
  );
  assert.match(
    desktopPackageInventoryProblems({
      sourceFiles: [],
      packagedFiles: ["node_modules/react-markdown/index.js"],
      resourceFiles: ["app-update.yml"],
      forbiddenPackagePrefixes: forbiddenDesktopRuntimePackagePrefixes,
    }).join("\n"),
    /renderer-only dependency.*react-markdown/,
  );

  const config = readFileSync(join(projectRoot, "electron-builder.yml"), "utf8");
  const parsedConfig = loadYaml(config);
  assert.equal(
    parsedConfig.mac.identity,
    "-",
    "development macOS packages must be ad-hoc signed before the packaged Bridge executes",
  );
  for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(parsedConfig.files.includes(path), true, `${path} must be included by electron-builder`);
  }
  const broadThirdPartyExclusions = parsedConfig.files.filter(
    (entry) => typeof entry === "string" && (entry.startsWith("!node_modules/") || entry === "!**/README*"),
  );
  assert.deepEqual(
    broadThirdPartyExclusions,
    [],
    "third-party package contents must use electron-builder defaults, not recursive custom exclusions",
  );
  assert.doesNotMatch(config, /!\*\*\/\*token\*/);
  assert.doesNotMatch(config, /!node_modules\/\*\*\/docs?\/\*\*/);
  assert.equal(existsSync(join(projectRoot, "node_modules/yaml/dist/doc/directives.js")), true);
  assert.match(config, /!dist\/\*\*\/\*\.map/);
  assert.match(config, /from:\s*build\/app-update\.yml[\s\S]*to:\s*app-update\.yml/);
  assert.match(config, /publish:[\s\S]*provider:\s*generic[\s\S]*url:\s*https:\/\/desktop-updates\.invalid\//);
}

function testMacReleaseTools() {
  const available = new Set(["ossutil", "spctl", "hdiutil", "xcrun", "stapler"]);
  assert.deepEqual(
    macReleaseToolProblems({
      ossutilBin: "ossutil",
      commandAvailable: (command) => available.has(command),
      xcrunToolAvailable: (tool) => available.has(tool),
    }),
    [],
  );
  assert.deepEqual(
    macReleaseToolProblems({
      ossutilBin: "/missing/ossutil",
      commandAvailable: () => false,
      xcrunToolAvailable: () => false,
    }),
    [
      "ossutil is not executable: /missing/ossutil",
      "spctl is not available in PATH",
      "hdiutil is not available in PATH",
      "xcrun is not available in PATH",
      "stapler is not discoverable via xcrun --find stapler",
    ],
  );
}

function testReleaseProxyDetection() {
  const urls = [
    "https://downloads.example.test/OpenGrove.dmg",
    "https://updates.example.test/mac-arm64/latest-mac.yml",
  ];
  assert.deepEqual(
    releaseVerificationProxyHosts(urls, {
      env: {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "downloads.example.test",
      },
    }),
    ["updates.example.test"],
  );
  assert.deepEqual(
    releaseVerificationProxyHosts(urls, {
      env: {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: ".example.test",
      },
    }),
    [],
  );
  assert.deepEqual(
    releaseVerificationProxyHosts(urls, {
      env: { HTTPS_PROXY: "http://proxy.example.test:8080" },
    }),
    [],
    "proxy variables do not affect Node fetch unless env proxy support is enabled",
  );
  assert.equal(
    releaseProxyUrl("https://account.r2.cloudflarestorage.com", {
      env: {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.example.test:8080",
      },
    }),
    "http://proxy.example.test:8080",
  );
  assert.equal(
    releaseProxyUrl("https://account.r2.cloudflarestorage.com", {
      env: {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "r2.cloudflarestorage.com",
      },
    }),
    null,
  );
}

async function testReleaseRequestSignal() {
  const signal = releaseRequestSignal(10);
  await delay(20);
  assert.equal(signal.aborted, true, "bounded release metadata requests must abort after their deadline");
}

function testUnsignedWindowsEscapeHatch() {
  const result = spawnSync(
    process.execPath,
    ["-e", "const c=require('./electron-builder.release.cjs'); process.stdout.write(String(c.forceCodeSigning));"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, OPENGROVE_ALLOW_UNSIGNED_WINDOWS: "1", CSC_LINK: "", CSC_KEY_PASSWORD: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    process.platform === "win32" ? "false" : "true",
    "the unsigned-Windows escape hatch must disable signing only on Windows",
  );

  if (process.platform === "win32") {
    const conflict = spawnSync(process.execPath, ["-e", "require('./electron-builder.release.cjs')"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, OPENGROVE_ALLOW_UNSIGNED_WINDOWS: "1", CSC_LINK: "C:\\leftover.pfx" },
    });
    assert.notEqual(conflict.status, 0, "leftover CSC_LINK must not silently combine with the unsigned escape hatch");
    assert.match(conflict.stderr, /conflicts with CSC_LINK/);
  }
}

function testIsolatedMacBuilderConfig() {
  for (const arch of ["arm64", "x64"]) {
    const result = spawnSync(
      process.execPath,
      ["-e", "const c=require('./electron-builder.release.cjs'); process.stdout.write(JSON.stringify(c.mac.target));"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENGROVE_DESKTOP_ARCH: arch,
          OPENGROVE_DESKTOP_OUTPUT_DIR: join(tempRoot, arch),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const targets = JSON.parse(result.stdout);
    assert.deepEqual(
      targets.map((target) => target.arch),
      [[arch], [arch]],
    );
  }
  const invalid = spawnSync(process.execPath, ["-e", "require('./electron-builder.release.cjs')"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, OPENGROVE_DESKTOP_ARCH: "universal" },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid OPENGROVE_DESKTOP_ARCH/);
}

function testMacArchitectureBuildPlan() {
  const deferred = macArchitectureBuildPlan({
    baseBuilderArgs: ["--config", "electron-builder.release.cjs"],
    arch: "arm64",
    version: "1.2.3",
    deferNotarization: true,
  });
  assert.deepEqual(deferred.builderArgs, [
    "electron-builder",
    "--config",
    "electron-builder.release.cjs",
    "--mac",
    "--arm64",
    "--dir",
  ]);
  assert.deepEqual(deferred.artifactFiles, [], "deferred notarization must not create disposable ZIP/DMG artifacts");

  const synchronous = macArchitectureBuildPlan({
    baseBuilderArgs: ["--config", "electron-builder.release.cjs"],
    arch: "x64",
    version: "1.2.3",
    deferNotarization: false,
  });
  assert.equal(synchronous.builderArgs.includes("--dir"), false);
  assert.deepEqual(synchronous.artifactFiles, [
    "OpenGrove-1.2.3-mac-x64.dmg",
    "OpenGrove-1.2.3-mac-x64.zip",
    "OpenGrove-1.2.3-mac-x64.dmg.blockmap",
    "OpenGrove-1.2.3-mac-x64.zip.blockmap",
  ]);
}

async function testParallelReleaseTasks() {
  let active = 0;
  let peak = 0;
  const values = await runParallelTasks(
    "parallel runner test",
    ["arm64", "x64"].map((arch) => ({
      id: arch,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(40);
        active -= 1;
        return arch;
      },
    })),
  );
  assert.equal(peak, 2, "architecture tasks must overlap");
  assert.deepEqual(values, ["arm64", "x64"]);

  active = 0;
  peak = 0;
  const limitedValues = await runParallelTasks(
    "limited parallel runner test",
    ["a", "b", "c", "d"].map((id) => ({
      id,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(40);
        active -= 1;
        return id;
      },
    })),
    { concurrency: 2 },
  );
  assert.equal(peak, 2, "bounded parallel tasks must respect the configured concurrency");
  assert.deepEqual(limitedValues, ["a", "b", "c", "d"]);

  let siblingFinished = false;
  await assert.rejects(
    runParallelTasks("parallel failure test", [
      {
        id: "arm64",
        run: async () => {
          await delay(10);
          throw new Error("synthetic arm64 failure");
        },
      },
      {
        id: "x64",
        run: async () => {
          await delay(30);
          siblingFinished = true;
        },
      },
    ]),
    /synthetic arm64 failure/,
  );
  assert.equal(siblingFinished, true, "successful sibling must settle so its release state can be preserved");

  const success = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
    captureStdout: true,
  });
  assert.equal(success.stdout, "ok");
  const allowedFailure = await runCommand(process.execPath, ["-e", "process.exit(7)"], {
    captureStdout: true,
    inheritStderr: false,
    allowFailure: true,
  });
  assert.equal(allowedFailure.status, 7);
}

async function testNotarizationArchitecturePipelines() {
  const submissions = [
    { arch: "arm64", status: "Submitted" },
    { arch: "x64", status: "Submitted" },
  ];
  const events = [];
  let x64Polls = 0;
  const result = await waitForNotarizationPipelines({
    submissions,
    timeoutMs: 1_000,
    pollMs: 1,
    refreshSubmission: async (item) => {
      events.push(`${item.arch}-poll`);
      if (item.arch === "arm64") {
        return { status: "Accepted", stapledAt: "2026-07-15T00:00:00.000Z" };
      }
      x64Polls += 1;
      return x64Polls === 1
        ? { status: "In Progress", updatedAt: "2026-07-15T00:00:00.000Z" }
        : { status: "Accepted", stapledAt: "2026-07-15T00:00:01.000Z" };
    },
    persistState: () => {},
    onStapled: async (item) => {
      events.push(`${item.arch}-finalize-start`);
      if (item.arch === "arm64") await delay(40);
      events.push(`${item.arch}-finalize-end`);
    },
  });
  assert.equal(result.pending, 0);
  assert.ok(
    events.indexOf("x64-finalize-end") < events.indexOf("arm64-finalize-end"),
    "one architecture must continue polling and finalizing while its sibling is being repackaged",
  );
}

async function testRangedRemoteHash() {
  const bytes = Buffer.alloc(256 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  let active = 0;
  let peak = 0;
  const etag = '"range-test-etag"';
  const server = createServer((request, response) => {
    void (async () => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      const includeEtag = request.url !== "/no-etag";
      if (!match || request.url === "/stream") {
        response.writeHead(200, {
          "content-length": bytes.length,
          ...(includeEtag ? { etag } : {}),
        });
        response.end(bytes);
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      active += 1;
      peak = Math.max(peak, active);
      await delay(15);
      const chunk = bytes.subarray(start, end + 1);
      response.writeHead(206, {
        "content-length": chunk.length,
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        ...(includeEtag ? { etag } : {}),
      });
      response.end(chunk);
      active -= 1;
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const rangedProgress = [];
    const result = await hashRemoteFile(`http://127.0.0.1:${server.address().port}/artifact`, bytes.length, {
      concurrency: 4,
      rangeThreshold: 1,
      chunkSize: 16 * 1024,
      onProgress: (progress) => rangedProgress.push(progress),
    });
    assert.deepEqual(result, { size: bytes.length, sha256: expectedHash, mode: "ranges" });
    assert.equal(peak, 4, "ranged hashing must respect its connection budget");
    assert.equal(rangedProgress.at(-1).bytesProcessed, bytes.length);
    assert.equal(rangedProgress.at(-1).totalBytes, bytes.length);
    assert.equal(rangedProgress.at(-1).completed, true);
    assert.equal(rangedProgress.at(-1).mode, "ranges");
    assert.equal(rangedProgress.at(-1).rangeConcurrency, 4);
    assert.ok(rangedProgress.at(-1).averageBytesPerSecond > 0);

    const streamProgress = [];
    const fallback = await hashRemoteFile(`http://127.0.0.1:${server.address().port}/stream`, bytes.length, {
      concurrency: 4,
      rangeThreshold: 1,
      chunkSize: 16 * 1024,
      onProgress: (progress) => streamProgress.push(progress),
    });
    assert.deepEqual(fallback, { size: bytes.length, sha256: expectedHash, mode: "stream" });
    assert.equal(streamProgress.at(-1).bytesProcessed, bytes.length);
    assert.equal(streamProgress.at(-1).completed, true);
    assert.equal(streamProgress.at(-1).mode, "stream");
    assert.equal(streamProgress.at(-1).rangeConcurrency, 1);

    const noEtagResult = await hashRemoteFile(`http://127.0.0.1:${server.address().port}/no-etag`, bytes.length, {
      concurrency: 4,
      rangeThreshold: 1,
      chunkSize: 16 * 1024,
    });
    assert.deepEqual(
      noEtagResult,
      { size: bytes.length, sha256: expectedHash, mode: "stream" },
      "multiple Range requests require a strong ETag; without one verification must use one stream",
    );
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

async function testReleaseNetworkTimeouts() {
  await assertReleaseNetworkTimeout("headers", (_request, _response) => {
    // Deliberately never send response headers.
  });
  await assertReleaseNetworkTimeout("body", (_request, response) => {
    response.writeHead(200, { "content-length": "1024" });
    response.write(Buffer.from("x"));
  });
}

async function assertReleaseNetworkTimeout(kind, handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const pending = hashRemoteFile(`http://127.0.0.1:${server.address().port}/${kind}`, 1024, {
    concurrency: 1,
    connectionTimeoutMs: 40,
    noProgressTimeoutMs: 40,
  }).then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  );
  const outcome = await Promise.race([pending, delay(250).then(() => "test-deadline")]);
  if (outcome === "test-deadline") server.closeAllConnections?.();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  assert.match(outcome, /timed out/i, `${kind} stall must fail before the test deadline; received ${outcome}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function addTarget(id, commit) {
  const spec = specs.find((item) => item.id === id);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, spec.installerFile), `${id}-installer`);
  if (spec.updaterFile !== spec.installerFile) {
    writeFileSync(join(releaseDir, spec.updaterFile), `${id}-updater`);
  }
  writeSourceManifest(spec, commit);
}

function writeSourceManifest(spec, commit) {
  mkdirSync(join(releaseDir, "release-source"), { recursive: true });
  const files = [...new Set([spec.installerFile, spec.updaterFile])];
  writeFileSync(
    join(releaseDir, "release-source", `${spec.id}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "OpenGrove",
        version: packageJson.version,
        clientReleaseNumber: packageJson.clientReleaseNumber,
        target: spec.id,
        gitCommit: commit,
        gitTag: `v${packageJson.version}`,
        releasedAt,
        artifacts: files.map((file) => ({
          file,
          size: statSync(join(releaseDir, file)).size,
          sha256: sha256(join(releaseDir, file)),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeGateReceipt() {
  for (const spec of specs) {
    for (const gate of ["package_inventory", "final_artifact_smoke", "updater_metadata", "previous_version_update"]) {
      const path = join(releaseDir, "release-gates", spec.id, `${gate}.json`);
      mkdirSync(join(releaseDir, "release-gates", spec.id), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            gate,
            passed: true,
            target: spec.id,
            syntheticTestEvidence: true,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  const receipt = await writeDesktopReleaseGateReceipt({
    releaseDir,
    ciRunUrl: "https://github.com/open-grove/opengrove/actions/runs/123456",
    previousReleaseTag: "v0.5.17",
    generatedAt: releasedAt,
  });
  assert.equal(receipt.schema_version, 3);
  assert.equal(receipt.version, packageJson.version);
  assert.equal(receipt.client_release_number, packageJson.clientReleaseNumber);
  assert.equal(receipt.expected_git_tag, `v${packageJson.version}`);
  assert.equal(receipt.previous_release_tag, "v0.5.17");
  assert.match(receipt.release_notes_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.gates.previous_version_update.passed, true);
  const verification = spawnSync(
    process.execPath,
    [
      "scripts/verify-desktop-release-candidate.mjs",
      "--release-dir",
      releaseDir,
      "--commit",
      gitCommit,
      "--expected-tag",
      `v${packageJson.version}`,
      "--current-release-tag",
      "v0.5.17",
      "--ci-run-url",
      "https://github.com/open-grove/opengrove/actions/runs/123456",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);
  const driftedVerification = spawnSync(
    process.execPath,
    [
      "scripts/verify-desktop-release-candidate.mjs",
      "--release-dir",
      releaseDir,
      "--commit",
      gitCommit,
      "--expected-tag",
      `v${packageJson.version}`,
      "--current-release-tag",
      "v999.0.0",
      "--ci-run-url",
      "https://github.com/open-grove/opengrove/actions/runs/123456",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.notEqual(driftedVerification.status, 0);
  assert.match(`${driftedVerification.stdout}\n${driftedVerification.stderr}`, /Latest formal release changed/);
}

function publisherArgs(extra = [], bases = {}) {
  return [
    "scripts/prepare-desktop-release.mjs",
    "--release-dir",
    releaseDir,
    "--updater-output-dir",
    updaterDir,
    "--copy-to",
    copyDir,
    "--public-base-url",
    bases.publicBaseUrl ?? "https://downloads.example.test/opengrove",
    "--updater-base-url",
    bases.updaterBaseUrl ?? "https://updates.example.test/opengrove",
    ...extra,
  ];
}

function runPublisher(extra = []) {
  const result = spawnSync(process.execPath, publisherArgs(extra), { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function assertPublisherFails(pattern, extra = []) {
  const result = spawnSync(process.execPath, publisherArgs(extra), { cwd: projectRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

async function testRemoteVerification() {
  let corruptFeed = false;
  let corruptPayload = false;
  let activeDownloads = 0;
  let peakDownloads = 0;
  let posted;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/releases") {
        let body = "";
        for await (const chunk of request) body += chunk;
        posted = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const publicPrefix = "/public/";
      const updaterPrefix = "/updater/";
      let path;
      if (url.pathname.startsWith(publicPrefix)) {
        path = join(releaseDir, decodeURIComponent(url.pathname.slice(publicPrefix.length)));
      } else if (url.pathname.startsWith(updaterPrefix)) {
        const updaterParts = url.pathname.slice(updaterPrefix.length).split("/").map(decodeURIComponent);
        const updaterFile = updaterParts.at(-1);
        const rootArtifact = specs.some(
          (spec) => updaterFile === spec.updaterFile || updaterFile === spec.updaterBlockmap,
        );
        path = rootArtifact ? join(releaseDir, updaterFile) : join(updaterDir, ...updaterParts);
      }
      if (!path || !existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      let bytes = readFileSync(path);
      if (corruptFeed && /latest(?:-mac)?\.yml$/.test(path)) bytes = Buffer.from("corrupt feed");
      if (corruptPayload && path.endsWith(specs[0].installerFile)) {
        bytes = Buffer.from(bytes);
        bytes[0] ^= 0xff;
      }
      response.setHeader("content-length", String(bytes.length));
      if (request.method === "HEAD") {
        response.writeHead(200);
        response.end();
        return;
      }
      activeDownloads += 1;
      peakDownloads = Math.max(peakDownloads, activeDownloads);
      await delay(30);
      response.writeHead(200);
      response.end(bytes);
      activeDownloads -= 1;
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    let result = await runPublisherAsync(["--register-url", `${base}/releases`], {
      publicBaseUrl: `${base}/public`,
      updaterBaseUrl: `${base}/updater`,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(posted.release.mac_arm64.released_at, releasedAt);
    assert.equal(posted.gate_receipt.git_commit, gitCommit);

    peakDownloads = 0;
    result = await runPublisherAsync(["--verify-remote", "--verify-concurrency", "2"], {
      publicBaseUrl: `${base}/public`,
      updaterBaseUrl: `${base}/updater`,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Verified all remote release files/);
    assert.equal(peakDownloads, 2, "remote verification must overlap downloads up to the configured limit");

    corruptFeed = true;
    posted = undefined;
    result = await runPublisherAsync(["--register-url", `${base}/releases`], {
      publicBaseUrl: `${base}/public`,
      updaterBaseUrl: `${base}/updater`,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /remote updater feed does not match/);
    assert.equal(posted, undefined);

    corruptFeed = false;
    corruptPayload = true;
    result = await runPublisherAsync(["--register-url", `${base}/releases`], {
      publicBaseUrl: `${base}/public`,
      updaterBaseUrl: `${base}/updater`,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /remote release file does not match/);
    assert.equal(posted, undefined, "same-sized corrupt payloads must block latest-version publication");
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

async function testPublishPipeline() {
  const ossRoot = join(tempRoot, "oss-root");
  const candidatePackagePath = join(tempRoot, "publish-candidate-package.json");
  writeFileSync(
    candidatePackagePath,
    `${JSON.stringify({
      version: packageJson.version,
      clientReleaseNumber: packageJson.clientReleaseNumber,
    })}\n`,
  );
  const publishEnv = (overrides = {}) => {
    const env = { ...process.env, ...overrides };
    for (const key of [
      "OPENGROVE_CLIENT_RELEASES_URL",
      "OPENGROVE_DESKTOP_RELEASE_PUBLIC_BASE_URL",
      "OPENGROVE_DESKTOP_RELEASE_BASE_URL",
      "OPENGROVE_DESKTOP_RELEASE_UPDATER_BASE_URL",
      "OPENGROVE_DESKTOP_RELEASE_UPDATER_DIR",
      "OPENGROVE_RELEASE_OSS_BUCKET",
      "OPENGROVE_RELEASE_OSS_ENDPOINT",
      "OPENGROVE_RELEASE_OSS_KEY_PREFIX",
      "OPENGROVE_RELEASE_UPLOAD_TOKEN",
      "OPENGROVE_OSSUTIL_BIN",
      "OPENGROVE_RELEASE_R2_BUCKET",
      "OPENGROVE_RELEASE_R2_ACCOUNT_ID",
      "OPENGROVE_RELEASE_R2_ACCESS_KEY_ID",
      "OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY",
      "OPENGROVE_RELEASE_R2_ATTEMPTS",
      "OPENGROVE_RELEASE_R2_KEYCHAIN_SERVICE",
      "OPENGROVE_RELEASE_R2_ACCESS_KEY_KEYCHAIN_ACCOUNT",
      "OPENGROVE_RELEASE_R2_SECRET_KEY_KEYCHAIN_ACCOUNT",
      "OPENGROVE_RELEASE_R2_KEYCHAIN",
    ]) {
      if (!(key in overrides)) delete env[key];
    }
    if (!("OPENGROVE_RELEASE_R2_KEYCHAIN_SERVICE" in overrides)) {
      env.OPENGROVE_RELEASE_R2_KEYCHAIN_SERVICE = `OpenGrove R2 Release Upload Missing Test ${process.pid}`;
    }
    return env;
  };
  const runPublish = (extra, env) =>
    new Promise((resolveRun) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/publish-desktop-release.mjs",
          "--release-package-json",
          candidatePackagePath,
          "--release-dir",
          releaseDir,
          "--updater-output-dir",
          updaterDir,
          "--timing-file",
          timingPath,
          ...extra,
        ],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    });

  // Bucket and endpoint derive from a native OSS updater base URL; nothing is uploaded in a dry run.
  let result = await runPublish(
    [
      "--public-base-url",
      "https://downloads.example.test/opengrove",
      "--updater-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/v-test",
      "--dry-run",
    ],
    publishEnv({
      OPENGROVE_RELEASE_CANDIDATE_COMMIT: "c".repeat(40),
      OPENGROVE_RELEASE_DEPLOYMENT_COMMIT: "d".repeat(40),
    }),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const trustedDeploymentTiming = JSON.parse(readFileSync(timingPath, "utf8"));
  assert.equal(trustedDeploymentTiming.configuration.candidateCommit, "c".repeat(40));
  assert.equal(trustedDeploymentTiming.configuration.deploymentCommit, "d".repeat(40));
  assert.match(
    result.stdout,
    /would run ossutil cp .* oss:\/\/fake-bucket\/opengrove\/v-test\/mac-arm64\/.* --ignore-existing/,
  );
  assert.match(result.stdout, /--acl public-read/);
  assert.match(result.stdout, /--endpoint oss-cn-test\.aliyuncs\.com/);
  assert.match(result.stdout, /--checkpoint-dir/);
  assert.match(result.stdout, /--retry-times 10/);
  assert.match(result.stdout, /oss:\/\/fake-bucket\/opengrove\/v-test\/SHA256SUMS\.txt/);
  assert.match(result.stdout, /would verify all remote files without registering/);
  assert.equal(existsSync(ossRoot), false);

  // R2 mirror planning derives the same immutable public path and never needs
  // credentials during a dry run.
  result = await runPublish(
    [
      "--public-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/releases/v-test",
      "--updater-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/releases/v-test",
      "--upload-installers",
      "--r2-bucket",
      "opengrove-releases",
      "--r2-account-id",
      "sample-release-account",
      "--dry-run",
    ],
    publishEnv(),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /would mirror .*OpenGrove-.*-mac-arm64\.dmg to r2:\/\/opengrove-releases\/opengrove\/releases\/v-test\/OpenGrove-/,
  );
  assert.doesNotMatch(
    result.stdout,
    /latest release pointer|latest\.json/,
    "publishing immutable mirrors must not change a user-visible release pointer",
  );

  result = await runPublish(
    [
      "--public-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/releases/v-test",
      "--updater-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/releases/v-test",
      "--upload-installers",
      "--r2-bucket",
      "opengrove-releases",
      "--r2-account-id",
      "sample-release-account",
    ],
    publishEnv(),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /R2 mirror requires both R2 credentials/);
  assert.equal(existsSync(ossRoot), false);

  // A requested registration without the Bearer credential must fail before anything is uploaded.
  result = await runPublish(
    [
      "--public-base-url",
      "https://downloads.example.test/opengrove",
      "--updater-base-url",
      "https://fake-bucket.oss-cn-test.aliyuncs.com/opengrove/v-test",
      "--register-url",
      "https://ww.example.test/v1/admin/client/releases",
    ],
    publishEnv({
      OPENGROVE_RELEASE_UPLOAD_KEYCHAIN_SERVICE: `OpenGrove Release Upload Missing Test ${process.pid}`,
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ww release upload token is required/);
  assert.equal(existsSync(ossRoot), false);
  const failedTiming = JSON.parse(readFileSync(timingPath, "utf8"));
  assert.equal(failedTiming.status, "failed");
  assert.match(failedTiming.error, /ww release upload token is required/);
  assert.ok(failedTiming.completedAt);

  if (process.platform === "win32") {
    console.log("desktop-release-pipeline: skipping the fake-ossutil publish flow on Windows");
    return;
  }

  const fakeOssutil = join(tempRoot, "fake-ossutil.mjs");
  writeFileSync(
    fakeOssutil,
    `#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const [command, source, destination, ...rest] = process.argv.slice(2);
const prefix = "oss://fake-bucket/";
if (rest[0] === "--ignore-existing") rest.splice(0, 1);
if (rest[0] === "--acl" && rest[1]) rest.splice(0, 2);
if (rest[0] === "--endpoint" && rest[1]) rest.splice(0, 2);
if (rest[0] === "--checkpoint-dir" && rest[1]) rest.splice(0, 2);
if (rest[0] === "--retry-times" && rest[1]) rest.splice(0, 2);
if (command !== "cp" || !destination?.startsWith(prefix) || rest.length > 0) {
  console.error("fake-ossutil: unexpected arguments: " + process.argv.slice(2).join(" "));
  process.exit(1);
}
const target = join(process.env.FAKE_OSS_ROOT, ...destination.slice(prefix.length).split("/"));
if (existsSync(target)) process.exit(0);
if (process.env.FAKE_OSS_FAIL_ONCE_OBJECT && destination.endsWith(process.env.FAKE_OSS_FAIL_ONCE_OBJECT)) {
  const marker = join(process.env.FAKE_OSS_ROOT, ".failed-once");
  if (!existsSync(marker)) {
    mkdirSync(dirname(marker), { recursive: true });
    copyFileSync(source, marker);
    process.exit(75);
  }
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
`,
  );
  chmodSync(fakeOssutil, 0o755);

  let posted;
  let postedAuthorization;
  let remoteHeadRequests = 0;
  let remoteGetRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/releases") {
        postedAuthorization = request.headers.authorization;
        let body = "";
        for await (const chunk of request) body += chunk;
        posted = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const publicPrefix = "/public/";
      const path = url.pathname.startsWith(publicPrefix)
        ? join(releaseDir, decodeURIComponent(url.pathname.slice(publicPrefix.length)))
        : join(ossRoot, ...url.pathname.split("/").filter(Boolean).map(decodeURIComponent));
      if (!existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const bytes = readFileSync(path);
      response.setHeader("content-length", String(bytes.length));
      response.setHeader("x-oss-hash-crc64ecma", crc64Xz(bytes));
      if (request.method === "HEAD") remoteHeadRequests += 1;
      else remoteGetRequests += 1;
      response.writeHead(200);
      response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    result = await runPublish(
      [
        "--public-base-url",
        `${base}/public`,
        "--updater-base-url",
        `${base}/updater-cdn/opengrove/v-test`,
        "--upload-concurrency",
        "2",
        "--verify-concurrency",
        "2",
      ],
      publishEnv({
        OPENGROVE_OSSUTIL_BIN: fakeOssutil,
        OPENGROVE_CLIENT_RELEASES_URL: `${base}/releases`,
        OPENGROVE_RELEASE_OSS_BUCKET: "fake-bucket",
        OPENGROVE_RELEASE_UPLOAD_TOKEN: "test-upload-token",
        FAKE_OSS_ROOT: ossRoot,
      }),
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(remoteHeadRequests > 0, "every uploaded object must be checked with HEAD metadata");
    assert.equal(remoteGetRequests, 1, "CRC64 verification must fully re-read only the one-file SHA-256 sample");
    const uploadedFeed = join(ossRoot, "updater-cdn", "opengrove", "v-test", "mac-arm64", "latest-mac.yml");
    assert.equal(
      readFileSync(uploadedFeed, "utf8"),
      readFileSync(join(updaterDir, "mac-arm64", "latest-mac.yml"), "utf8"),
    );
    assert.equal(
      existsSync(join(ossRoot, "updater-cdn", "opengrove", "v-test", "windows-x64", specs[2].updaterFile)),
      true,
    );
    assert.equal(existsSync(join(ossRoot, "updater-cdn", "opengrove", "v-test", "SHA256SUMS.txt")), true);
    assert.equal(postedAuthorization, "Bearer test-upload-token");
    assert.deepEqual(posted.release, JSON.parse(readFileSync(join(releaseDir, "client-latest-version.json"), "utf8")));
    assert.deepEqual(
      posted.release_notes_by_locale,
      JSON.parse(readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8")).releaseNotesByLocale,
    );
    assert.deepEqual(
      posted.gate_receipt,
      JSON.parse(readFileSync(join(releaseDir, "release-gate-receipt.json"), "utf8")),
    );
    assert.match(result.stdout, /gated candidate registered with ww; the active pointer was not changed/);
    assert.equal(
      (result.stdout.match(/prepare-desktop-update-payload: mac-arm64:/g) ?? []).length,
      1,
      "one publish command must generate updater metadata only once",
    );

    result = await runPublish(
      ["--public-base-url", `${base}/public`, "--updater-base-url", `${base}/retry`, "--oss-attempts", "2"],
      publishEnv({
        OPENGROVE_OSSUTIL_BIN: fakeOssutil,
        OPENGROVE_RELEASE_OSS_BUCKET: "fake-bucket",
        OPENGROVE_RELEASE_UPLOAD_TOKEN: "test-upload-token",
        FAKE_OSS_ROOT: ossRoot,
        FAKE_OSS_FAIL_ONCE_OBJECT: "/retry/mac-arm64/latest-mac.yml",
      }),
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /retrying .* after attempt 1\/2/);

    writeFileSync(uploadedFeed, "conflicting-existing-object");
    posted = undefined;
    result = await runPublish(
      [
        "--public-base-url",
        `${base}/public`,
        "--updater-base-url",
        `${base}/updater-cdn/opengrove/v-test`,
        "--upload-concurrency",
        "2",
        "--verify-concurrency",
        "2",
      ],
      publishEnv({
        OPENGROVE_OSSUTIL_BIN: fakeOssutil,
        OPENGROVE_CLIENT_RELEASES_URL: `${base}/releases`,
        OPENGROVE_RELEASE_OSS_BUCKET: "fake-bucket",
        OPENGROVE_RELEASE_UPLOAD_TOKEN: "test-upload-token",
        FAKE_OSS_ROOT: ossRoot,
      }),
    );
    assert.notEqual(result.status, 0, "an existing object with different bytes must block registration");
    assert.equal(
      readFileSync(uploadedFeed, "utf8"),
      "conflicting-existing-object",
      "publisher must never overwrite an immutable version object",
    );
    assert.equal(posted, undefined);
    assert.match(result.stdout, /OSS upload: starting .* with concurrency 2/);

    // Private-repo mode: installers ship from the same OSS prefix, so the
    // download_url never depends on GitHub Release visibility.
    remoteHeadRequests = 0;
    remoteGetRequests = 0;
    result = await runPublish(
      [
        "--public-base-url",
        `${base}/pub/opengrove/v-full`,
        "--updater-base-url",
        `${base}/pub/opengrove/v-full`,
        "--register-url",
        `${base}/releases`,
        "--upload-installers",
      ],
      publishEnv({
        OPENGROVE_OSSUTIL_BIN: fakeOssutil,
        OPENGROVE_RELEASE_OSS_BUCKET: "fake-bucket",
        OPENGROVE_RELEASE_UPLOAD_TOKEN: "test-upload-token",
        FAKE_OSS_ROOT: ossRoot,
      }),
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(remoteHeadRequests > 0);
    assert.equal(remoteGetRequests, 1);
    assert.equal(existsSync(join(ossRoot, "pub", "opengrove", "v-full", specs[0].installerFile)), true);
    const timing = JSON.parse(readFileSync(timingPath, "utf8"));
    assert.equal(timing.schemaVersion, 1);
    assert.equal(timing.command, "publish:desktop-release");
    assert.equal(timing.status, "success");
    assert.ok(timing.durationMs >= 0);
    assert.ok(timing.phases.some((phase) => phase.name === "prepare-release-metadata" && phase.status === "success"));
    assert.ok(timing.phases.some((phase) => phase.name === "oss-upload" && phase.status === "success"));
    assert.ok(timing.phases.some((phase) => phase.name === "remote-verification" && phase.status === "success"));
    assert.ok(timing.phases.some((phase) => phase.name === "ww-registration" && phase.status === "success"));
    const uploadTimings = timing.files.filter((file) => file.stage === "oss-upload");
    const verificationTimings = timing.files.filter((file) => file.stage === "remote-verification");
    assert.ok(uploadTimings.length > 0);
    assert.ok(verificationTimings.length > 0);
    assert.ok(uploadTimings.every((file) => file.status === "success" && file.bytesProcessed === file.totalBytes));
    assert.ok(
      verificationTimings.every(
        (file) =>
          file.status === "success" &&
          file.bytesProcessed === file.totalBytes &&
          file.completed === true &&
          file.averageBytesPerSecond > 0 &&
          typeof file.proxyApplied === "boolean" &&
          ["head-crc64", "head-crc64+sha256-sample"].includes(file.mode),
      ),
    );
    assert.ok(verificationTimings.every((file) => Number.isSafeInteger(file.networkBytes)));
    assert.equal(verificationTimings.filter((file) => file.mode === "head-crc64+sha256-sample").length, 1);
    assert.match(posted.release.mac_arm64.download_url, /\/pub\/opengrove\/v-full\//);
    assert.deepEqual(posted.release, JSON.parse(readFileSync(join(releaseDir, "client-latest-version.json"), "utf8")));
    assert.deepEqual(
      posted.release_notes_by_locale,
      JSON.parse(readFileSync(join(releaseDir, "desktop-release-manifest.json"), "utf8")).releaseNotesByLocale,
    );
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

async function testReleaseControl() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const releasesUrl = `http://127.0.0.1:${server.address().port}/v1/admin/client/releases`;
    const run = (commandArgs) =>
      new Promise((resolveRun) => {
        const child = spawn(
          process.execPath,
          ["scripts/control-desktop-release.mjs", ...commandArgs, "--releases-url", releasesUrl],
          {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, OPENGROVE_RELEASE_UPLOAD_TOKEN: "control-token" },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolveRun({ status, stdout, stderr }));
      });

    const refused = await run(["promote", String(packageJson.clientReleaseNumber)]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /without --yes/);

    for (const commandArgs of [
      ["promote", String(packageJson.clientReleaseNumber), "--yes"],
      ["rollback", String(packageJson.clientReleaseNumber - 1), "--yes"],
      ["withdraw", "--yes"],
    ]) {
      const result = await run(commandArgs);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    assert.deepEqual(requests, [
      {
        method: "POST",
        url: `/v1/admin/client/releases/${packageJson.clientReleaseNumber}/promote`,
        authorization: "Bearer control-token",
      },
      {
        method: "POST",
        url: `/v1/admin/client/releases/${packageJson.clientReleaseNumber - 1}/promote`,
        authorization: "Bearer control-token",
      },
      {
        method: "DELETE",
        url: "/v1/admin/client/releases/active",
        authorization: "Bearer control-token",
      },
    ]);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

function runPublisherAsync(extra, bases) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, publisherArgs(extra, bases), {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}
