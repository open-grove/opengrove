import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import { createDiagnosticBundle } from "../diagnostics/diagnostic-bundle.js";
import {
  diagnosticFileUrlToPath,
  isDiagnosticCredentialPath,
  isRuntimeExecutableFile,
} from "../diagnostics/evidence-files.js";
import { sanitizeDiagnosticFacts } from "../diagnostics/problem-schema.js";
import {
  redactDiagnosticCredentialValues,
  redactDiagnosticText,
  safeDiagnosticErrorCode,
} from "../diagnostics/redaction.js";
import { createZipArchive, readZipArchiveForTest } from "../diagnostics/zip.js";
import type { BridgeState } from "../server/bridge-types.js";
import { recordProblem, recordProblemInDirectory } from "../server/problem-records.js";

const secret = "sk-opengrove-secret-value";
const wwSecret = "ww_sk_SUPERSECRET0123456789";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature0123456789";
const awsAccessKey = ["AKIA", "1234567890ABCDEF"].join("");
const redacted = redactDiagnosticText(
  [
    `authorization: Bearer ${secret}`,
    "authorization: Bearer opaque-credential-without-known-prefix",
    `apiKey=${secret}`,
    `Bearer ${wwSecret}`,
    wwSecret,
    jwt,
    `{"authorization":"Bearer opaque-private-credential"}`,
    `{"access_token":"opaque-access-token"}`,
    `aws=${awsAccessKey}`,
    "email=person@example.com",
  ].join("\n"),
  [secret],
);
assert.doesNotMatch(
  redacted,
  /opengrove-secret|opaque-credential|opaque-access-token|SUPERSECRET|eyJhbGci|person@example\.com/,
);
assert.equal(redacted.includes(awsAccessKey), false);
assert.match(redacted, /\[REDACTED\]/);
assert.match(redacted, /\[EMAIL REDACTED\]/);

// Problem records use broad write-time redaction; exported raw evidence only removes credential values.
const evidenceRedacted = redactDiagnosticCredentialValues(
  [
    "const token = args[i];",
    "contact=person@example.com",
    `known=${secret}`,
    "provider=sk-ant-api03-1234567890abcdef",
    `session=${jwt}`,
    "authorization: Bearer opaque-credential-value",
    "authorization: Basic opaque-basic-credential",
    "refresh_token=opaque-refresh-credential",
    "PROVIDER_API_KEY=opaque-env-credential",
    '{"password":"opaque-json-credential"}',
  ].join("\n"),
  [secret],
);
assert.match(evidenceRedacted, /const token = args\[i\];/);
assert.match(evidenceRedacted, /person@example\.com/);
assert.doesNotMatch(
  evidenceRedacted,
  /opengrove-secret|sk-ant-api03|eyJhbGci|opaque-(?:credential-value|basic-credential|refresh-credential|env-credential|json-credential)/,
);
assert.match(evidenceRedacted, /refresh_token=\[REDACTED\]/);
assert.match(evidenceRedacted, /PROVIDER_API_KEY=\[REDACTED\]/);
assert.match(evidenceRedacted, /"password":"\[REDACTED\]"/);
assert.equal(
  diagnosticFileUrlToPath("file:///C:/Program%20Files/OpenGrove/runtime.exe", "win32"),
  "C:\\Program Files\\OpenGrove\\runtime.exe",
);
assert.equal(
  diagnosticFileUrlToPath("file://diagnostics-host/share/runtime.exe", "win32"),
  "\\\\diagnostics-host\\share\\runtime.exe",
);
assert.equal(isRuntimeExecutableFile("C:\\OpenGrove\\runtime.EXE", 0, "win32"), true);
assert.equal(isRuntimeExecutableFile("C:\\OpenGrove\\runtime.txt", 0o755, "win32"), false);
assert.equal(isRuntimeExecutableFile("/usr/local/bin/runtime", 0o755, "linux"), true);
assert.equal(isRuntimeExecutableFile("/usr/local/bin/runtime", 0o644, "linux"), false);
assert.equal(isDiagnosticCredentialPath("/tmp/opengrove/bridge-settings.json"), true);
assert.equal(isDiagnosticCredentialPath("/tmp/opengrove/local-state.sqlite-wal"), true);
assert.equal(isDiagnosticCredentialPath("/tmp/opengrove/state-blobs/result.gz"), true);
assert.equal(isDiagnosticCredentialPath("/tmp/opengrove/logs/bridge.log"), false);
assert.equal(safeDiagnosticErrorCode("creative_draft_private_text follows"), "unknown_error");
assert.equal(safeDiagnosticErrorCode("ww_sk_lowercasesecret follows"), "unknown_error");
assert.equal(safeDiagnosticErrorCode("ww_request_timeout details"), "ww_request_timeout");
assert.equal(safeDiagnosticErrorCode("desktop_startup_timeout"), "desktop_startup_timeout");
assert.equal(safeDiagnosticErrorCode("default_app_sync_failed"), "default_app_sync_failed");
assert.equal(safeDiagnosticErrorCode("employee_routine_step_failed"), "employee_routine_step_failed");
assert.equal(safeDiagnosticErrorCode("member_step_executor_unavailable"), "unknown_error");
assert.deepEqual(
  sanitizeDiagnosticFacts(
    {
      runKind: "routine",
      stepKind: "tool",
      stepIndex: 2,
      durationMs: 1500,
      providerKind: "openai-compatible",
      selectedModelId: "MiniMax-M2.5",
      requestedModelId: "claude-opus-4-6",
      runtimeModelId: "claude-opus-4-6-20260101",
      runtimeVersion: "2.1.215",
      privateValue: secret,
    },
    [secret],
  ),
  {
    runKind: "routine",
    stepKind: "tool",
    stepIndex: 2,
    durationMs: 1500,
    providerKind: "openai-compatible",
    selectedModelId: "MiniMax-M2.5",
    requestedModelId: "claude-opus-4-6",
    runtimeModelId: "claude-opus-4-6-20260101",
    runtimeVersion: "2.1.215",
  },
);
assert.equal(
  sanitizeDiagnosticFacts(
    {
      selectedModelId: secret,
      requestedModelId: wwSecret,
      runtimeModelId: jwt,
    },
    [secret, wwSecret],
  ),
  undefined,
);
const opaqueModelSecret = "opaque+credential/value=without-known-prefix";
assert.deepEqual(
  sanitizeDiagnosticFacts(
    {
      selectedModelId: opaqueModelSecret,
    },
    [],
  ),
  {
    selectedModelId: "opaque_credential_value_without-known-prefix",
  },
);
assert.equal(
  sanitizeDiagnosticFacts(
    {
      selectedModelId: opaqueModelSecret,
    },
    [opaqueModelSecret],
  ),
  undefined,
);
const longOpaqueModelSecret = `opaque-${"x".repeat(180)}`;
assert.equal(
  sanitizeDiagnosticFacts(
    {
      runtimeModelId: longOpaqueModelSecret,
    },
    [longOpaqueModelSecret],
  ),
  undefined,
);
assert.deepEqual(
  sanitizeDiagnosticFacts(
    {
      attemptCount: 1,
      httpStatus: 200,
      upstreamRequestId: "req-shape-safe",
      httpResponses: [
        {
          attempt: 1,
          method: "POST",
          endpoint: "/v1/api-keys",
          httpStatus: 200,
          upstreamRequestId: "req-shape-safe",
          contentType: "application/json",
          envelopeKind: "object",
          envelopeFields: { data: "object", request_id: "string" },
          dataKind: "object",
          dataFields: { api_key: "missing", id: "string", [wwSecret]: "string" },
          validationCode: "missing_required_fields",
          missingFields: ["api_key", wwSecret],
        },
      ],
    },
    [wwSecret],
  ),
  {
    attemptCount: 1,
    httpStatus: 200,
    upstreamRequestId: "req-shape-safe",
    httpResponses: [
      {
        attempt: 1,
        method: "POST",
        endpoint: "/v1/api-keys",
        httpStatus: 200,
        upstreamRequestId: "req-shape-safe",
        contentType: "application/json",
        envelopeKind: "object",
        envelopeFields: { data: "object", request_id: "string" },
        dataKind: "object",
        dataFields: { api_key: "missing", id: "string" },
        validationCode: "missing_required_fields",
        missingFields: ["api_key"],
      },
    ],
  },
);

const archive = createZipArchive([
  { name: "manifest.json", data: JSON.stringify({ ok: true }) },
  { name: "logs/bridge.log", data: redacted },
]);
assert.equal(archive.readUInt32LE(0), 0x04034b50);
const entries = readZipArchiveForTest(archive);
assert.deepEqual(JSON.parse(entries.get("manifest.json")?.toString("utf8") ?? "{}"), { ok: true });
assert.equal(entries.get("logs/bridge.log")?.toString("utf8"), redacted);
assert.throws(() => createZipArchive([{ name: "../secret", data: "no" }]), /diagnostic_zip_entry_invalid/);

const pathBoundaryRoot = mkdtempSync(join(tmpdir(), "opengrove-diagnostic-path-boundary-"));
try {
  const customDiagnosticsDir = join(pathBoundaryRoot, "nested", "diagnostics");
  const approvedLogDir = join(pathBoundaryRoot, "approved-logs");
  const guessedLogDir = join(pathBoundaryRoot, "logs");
  mkdirSync(customDiagnosticsDir, { recursive: true });
  mkdirSync(approvedLogDir, { recursive: true });
  mkdirSync(guessedLogDir, { recursive: true });
  writeFileSync(join(approvedLogDir, "bridge.log"), "approved explicit log\n", "utf8");
  writeFileSync(join(guessedLogDir, "desktop-main.log"), "must not be discovered by ancestor traversal\n", "utf8");
  const boundaryBundle = await createDiagnosticBundle({
    diagnosticsDir: customDiagnosticsDir,
    logDirs: [approvedLogDir],
    bridgeStatus: { status: "running" },
    versions: { app: "test", node: process.version },
    storeAppLayout: { migration: { id: "store-app-layout-v2", introducedIn: "0.6.6" } },
  });
  const boundaryEntries = readZipArchiveForTest(boundaryBundle.archive);
  assert.match(boundaryEntries.get("logs/bridge.log")?.toString("utf8") ?? "", /approved explicit log/);
  assert.deepEqual(JSON.parse(boundaryEntries.get("store-app-layout.json")?.toString("utf8") ?? "{}"), {
    migration: { id: "store-app-layout-v2", introducedIn: "0.6.6" },
  });
  assert.doesNotMatch(
    Buffer.concat([...boundaryEntries.values()]).toString("utf8"),
    /must not be discovered by ancestor traversal/,
  );
} finally {
  rmSync(pathBoundaryRoot, { recursive: true, force: true });
}

const diagnosticRoot = mkdtempSync(join(tmpdir(), "opengrove-diagnostics-"));
process.env[appEnvName("DIAGNOSTICS_DIR")] = diagnosticRoot;
try {
  const problem = recordProblem({} as BridgeState, {
    traceId: "trace-diagnostic-harness",
    category: "ww",
    phase: "login",
    error: new Error(`ww_request_timeout apiKey=${secret}`),
    retryable: true,
    facts: { attemptCount: 2, durationMs: 10_000 },
  });
  assert.match(problem.incidentId, /^OG-\d{8}-[A-F0-9]{6}$/);
  const problemLog = readFileSync(join(diagnosticRoot, "problems.jsonl"), "utf8");
  assert.match(problemLog, /trace-diagnostic-harness/);
  assert.doesNotMatch(problemLog, /opengrove-secret/);
  assert.equal(problem.level, "error");
  assert.deepEqual(problem.facts, { attemptCount: 2, durationMs: 10_000 });

  const firstBackgroundProblem = recordProblem({} as BridgeState, {
    category: "ww",
    phase: "session-verify",
    code: "auth_unavailable",
    level: "warning",
    error: new Error("auth_unavailable"),
    backgroundDedupe: { key: "session-verify-degraded", windowMs: 60_000 },
  });
  const repeatedBackgroundProblem = recordProblem({} as BridgeState, {
    category: "ww",
    phase: "session-verify",
    code: "auth_unavailable",
    level: "warning",
    error: new Error("auth_unavailable"),
    backgroundDedupe: { key: "session-verify-degraded", windowMs: 60_000 },
  });
  assert.equal(repeatedBackgroundProblem.incidentId, firstBackgroundProblem.incidentId);
  assert.equal(readFileSync(join(diagnosticRoot, "problems.jsonl"), "utf8").trim().split("\n").length, 2);

  const blockedRoot = join(diagnosticRoot, "not-a-directory");
  writeFileSync(blockedRoot, "blocked", "utf8");
  const unpersistedBackgroundProblem = recordProblemInDirectory(blockedRoot, {
    category: "ww",
    phase: "session-verify",
    code: "auth_unavailable",
    error: new Error("auth_unavailable"),
    backgroundDedupe: { key: "unpersisted", windowMs: 60_000 },
  });
  const retriedUnpersistedBackgroundProblem = recordProblemInDirectory(blockedRoot, {
    category: "ww",
    phase: "session-verify",
    code: "auth_unavailable",
    error: new Error("auth_unavailable"),
    backgroundDedupe: { key: "unpersisted", windowMs: 60_000 },
  });
  assert.notEqual(
    retriedUnpersistedBackgroundProblem.incidentId,
    unpersistedBackgroundProblem.incidentId,
    "failed persistence must not seed background dedupe",
  );

  const path = join(diagnosticRoot, "problems.jsonl");
  writeFileSync(path, "x".repeat(2 * 1024 * 1024 - 100), "utf8");
  const oversized = recordProblem({} as BridgeState, {
    traceId: "trace-oversized-diagnostic",
    category: "ww",
    phase: "provision",
    error: new Error(`apiKey=TOP-SECRET-VALUE ${"X".repeat(3 * 1024 * 1024)}`),
  });
  assert.equal(oversized.code, "unknown_error");
  assert.ok(Buffer.byteLength(oversized.message) <= 4 * 1024);
  assert.ok(statSync(path).size < 2 * 1024 * 1024);
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.at(-1)?.incidentId, oversized.incidentId);
  assert.doesNotMatch(JSON.stringify(records), /TOP-SECRET-VALUE/);
} finally {
  delete process.env[appEnvName("DIAGNOSTICS_DIR")];
  rmSync(diagnosticRoot, { recursive: true, force: true });
}

console.log("diagnostic-bundle-harness passed");
