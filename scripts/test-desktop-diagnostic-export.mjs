import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readZipArchiveForTest } from "../dist/diagnostics/zip.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-diagnostic-export-"));
const bundledModule = join(tempRoot, "diagnostic-bundle.mjs");
const dataDir = join(tempRoot, "data");
const logDir = join(tempRoot, "logs");
const diagnosticsDir = join(tempRoot, "diagnostics");
mkdirSync(dataDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
mkdirSync(diagnosticsDir, { recursive: true });

try {
  await build({
    entryPoints: [fileURLToPath(new URL("../desktop/diagnostic-bundle.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundledModule,
  });
  const { exportDesktopDiagnosticBundle } = await import(`${pathToFileURL(bundledModule).href}?v=${Date.now()}`);
  const secret = "sk-desktop-export-secret-value";
  const bridgeToken = "opaque-bridge-token-private-0123456789";
  const wwSecret = "ww_sk_DESKTOP_EXPORT_SECRET_0123456789";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXNrdG9wLXByaXZhdGUifQ.signature0123456789";
  const conversation = "CLIENT-CONVERSATION-BODY-DO-NOT-EXPORT";
  const externalPath = "/Volumes/Client-X/private-userdata";
  const email = "private@example.com";
  const paths = {
    userDataDir: tempRoot,
    dataDir,
    programsDir: join(tempRoot, "programs"),
    workspacesDir: join(tempRoot, "workspaces"),
    logDir,
    cacheDir: join(tempRoot, "cache"),
    diagnosticsDir,
    statePath: join(dataDir, "local-state.sqlite"),
    settingsPath: join(dataDir, "bridge-settings.json"),
    mainLogPath: join(logDir, "desktop-main.log"),
    bridgeLogPath: join(logDir, "bridge.log"),
    bridgeCrashLogPath: join(logDir, "bridge-crash.log"),
  };
  writeFileSync(paths.mainLogPath, `renderer failed email=${email} ${conversation}\n`, "utf8");
  writeFileSync(paths.bridgeLogPath, `authorization: Bearer ${secret} ${wwSecret} ${jwt}\n`, "utf8");
  writeFileSync(paths.bridgeCrashLogPath, `Error: room_not_found ${externalPath}\n`, "utf8");
  writeFileSync(paths.statePath, `STATE_MUST_NOT_BE_EXPORTED ${secret}\n`, "utf8");
  mkdirSync(join(dataDir, "state-blobs"), { recursive: true });
  writeFileSync(
    join(dataDir, "state-blobs", "private-result.gz"),
    `BLOB_MUST_NOT_BE_EXPORTED ${conversation}\n`,
    "utf8",
  );
  writeFileSync(
    join(diagnosticsDir, "problems.jsonl"),
    `${JSON.stringify({
      incidentId: "OG-20260710-ABC123",
      traceId: bridgeToken,
      category: "employee-run",
      phase: "timeout",
      code: "ww_request_timeout",
      level: "error",
      message: `apiKey=${secret} ${conversation}`,
      context: { path: externalPath, authorization: `Bearer ${wwSecret}` },
      facts: { runKind: "room", kernelKind: "codex", privateValue: conversation },
    })}\n${JSON.stringify({
      incidentId: "OG-20260711-DEF456",
      traceId: "desktop-startup-trace",
      category: "desktop",
      phase: "startup",
      code: "desktop_startup_timeout",
      message: "desktop_startup_timeout",
      retryable: true,
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(diagnosticsDir, "problems.jsonl.1"),
    `${JSON.stringify({
      incidentId: "OG-20260709-ROTATE1",
      code: "bridge_request_failed",
      bridgeToken,
      authorization: `Basic ${secret}`,
    })}\n`,
    "utf8",
  );

  const outputPath = join(tempRoot, "OpenGrove-errors.zip");
  const result = await exportDesktopDiagnosticBundle({
    outputPath,
    diagnostics: {
      status: "running",
      pid: 123,
      apiBase: "http://127.0.0.1:37371/api",
      port: 37371,
      mode: "owned",
      restartCount: 0,
      crashCount: 1,
      paths,
      recentMainLog: "",
      recentBridgeLog: "",
      recentCrashLog: "",
    },
    versions: { app: "test", electron: "test", chrome: "test", node: process.version },
    isPackaged: true,
    runDiagnostics: {
      generatedAt: "2026-07-10T00:00:00.000Z",
      window: "recent-100",
      counts: { total: 100, succeeded: 99, failed: 1, running: 0, waiting: 0, stalled: 0 },
      failures: [
        {
          runId: bridgeToken,
          sessionId: "private-session-id",
          status: "failed",
          error: conversation,
          eventCount: 2,
          problem: { incidentId: "OG-20260710-ABC123", code: "ww_request_timeout" },
        },
      ],
    },
    secrets: [secret, bridgeToken],
  });
  assert.equal(result.status, "saved");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.evidenceComplete, true);
  const archive = readFileSync(outputPath);
  const entries = readZipArchiveForTest(archive);
  assert.ok(entries.has("manifest.json"));
  assert.ok(entries.has("problems.jsonl"));
  assert.ok(entries.has("problems.jsonl.1"));
  assert.ok(entries.has("recent-run-errors.json"));
  assert.ok(entries.has("store-app-layout.json"));
  assert.ok(entries.has("logs/desktop-main.log"));
  assert.ok(entries.has("logs/bridge.log"));
  assert.ok(entries.has("logs/bridge-crash.log"));
  assert.ok(entries.has("file-index.json"));
  assert.equal(entries.has("local-state.sqlite"), false);
  const archiveText = [...entries.values()].map((value) => value.toString("utf8")).join("\n");
  assert.doesNotMatch(
    archiveText,
    /desktop-export-secret|DESKTOP_EXPORT_SECRET|eyJhbGci|STATE_MUST_NOT_BE_EXPORTED|BLOB_MUST_NOT_BE_EXPORTED/,
  );
  assert.match(archiveText, /private@example\.com/);
  assert.match(archiveText, /CLIENT-CONVERSATION-BODY-DO-NOT-EXPORT/);
  assert.match(archiveText, /private-userdata/);
  assert.match(archiveText, /private-session-id/);
  assert.equal(archiveText.includes(bridgeToken), false);
  assert.match(archiveText, /OG-20260710-ABC123/);
  const exportedProblems = entries
    .get("problems.jsonl")
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    exportedProblems.some((problem) => problem.code === "unknown_error"),
    false,
  );
  const exportedProblem = exportedProblems.find((problem) => problem.code === "ww_request_timeout");
  assert.equal(exportedProblem.traceId, "[REDACTED:KNOWN_SECRET]");
  assert.match(exportedProblem.message, /CLIENT-CONVERSATION-BODY-DO-NOT-EXPORT/);
  assert.equal(exportedProblem.context.path, externalPath);
  assert.doesNotMatch(exportedProblem.context.authorization, /DESKTOP_EXPORT_SECRET/);
  assert.deepEqual(exportedProblem.facts, {
    runKind: "room",
    kernelKind: "codex",
    privateValue: conversation,
  });
  assert.equal(exportedProblems.find((problem) => problem.code === "desktop_startup_timeout")?.category, "desktop");
  const rotatedProblem = JSON.parse(entries.get("problems.jsonl.1").toString("utf8").trim());
  assert.equal(rotatedProblem.bridgeToken, "[REDACTED:KNOWN_SECRET]");
  assert.equal(rotatedProblem.authorization, "[REDACTED]");
  const runSummary = JSON.parse(entries.get("recent-run-errors.json").toString("utf8"));
  assert.equal(runSummary.window, "recent-100");
  assert.equal(runSummary.counts.succeeded, 99);
  assert.equal(runSummary.failures.length, 1);
  assert.deepEqual(runSummary.failures[0].problem, {
    incidentId: "OG-20260710-ABC123",
    code: "ww_request_timeout",
  });
  assert.equal("recordedProblems" in runSummary, false);
  assert.equal("runs" in runSummary, false);
  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  assert.equal(manifest.formatVersion, 5);
  assert.equal(manifest.kind, "opengrove-system-forensic-bundle");
  assert.equal(manifest.privacy.includesLogContent, true);
  assert.equal(manifest.privacy.includesProblemMessages, true);
  assert.equal(manifest.privacy.structuredCoreMetadataAllowlistApplied, true);
  assert.equal(manifest.privacy.evidenceContentAllowlistApplied, false);
  assert.equal(manifest.credentials.stateStoreIncluded, false);
  assert.equal(manifest.credentials.credentialFilesIncluded, false);
  assert.equal(manifest.credentials.unstructuredEvidenceMayContainSensitiveContent, true);
  const storeAppLayout = JSON.parse(entries.get("store-app-layout.json").toString("utf8"));
  assert.equal(storeAppLayout.migration.id, "store-app-layout-v2");
  assert.equal(storeAppLayout.migration.introducedIn, "0.6.5");
  assert.equal(storeAppLayout.roots.programs.path, paths.programsDir);
  assert.equal(storeAppLayout.roots.workspaces.path, paths.workspacesDir);
  assert.equal(storeAppLayout.roots.legacyPrograms.path, join(dataDir, "app-store", "programs"));
  assert.equal(storeAppLayout.roots.legacyWorkspaces.path, join(tempRoot, "apps"));
  assert.equal(storeAppLayout.mountedAppsAvailable, false);
  console.log("desktop-diagnostic-export test passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
