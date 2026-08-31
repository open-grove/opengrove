import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseControlIntentMatchesJournal,
  releaseControlStartMetadata,
  ReleaseControlClient,
  ReleaseControlClientError,
  type ReleaseControlIntent,
  type ReleaseControlStartMetadata,
} from "../server/app-release-client.js";
import { AppReleaseJournalStore } from "../server/app-release-journal.js";
import type { MountedAppReleaseDraft } from "../server/app-release.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-release-control-client-"));
try {
  const source = Buffer.from("fixed source snapshot bytes", "utf8");
  const sourceSha256 = sha256(source);
  const store = new AppReleaseJournalStore(join(root, "journals"));
  const legacyLocalAppId = "legacy-release-app";
  const legacyJournalRoot = join(root, "journals", sha256(Buffer.from(legacyLocalAppId, "utf8")));
  mkdirSync(legacyJournalRoot, { recursive: true });
  writeFileSync(
    join(legacyJournalRoot, "current.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 8,
        localAppId: legacyLocalAppId,
        appId: legacyLocalAppId,
        organization: "open-grove",
        packageKey: "opengrove.legacy-release-app",
        expectedMainSha: "1".repeat(40),
        publishBase: {
          packageKey: "opengrove.legacy-release-app",
          version: "0.1.1",
          releaseCommitSha: "1".repeat(40),
          archiveSha256: "2".repeat(64),
        },
        draftDigest: "3".repeat(64),
        sourceSnapshot: {
          sha256: "4".repeat(64),
          size: 10,
          files: [
            {
              path: "opengrove.app.json",
              sha256: "5".repeat(64),
              size: 128,
              mode: "100644",
            },
          ],
          archiveFile: `snapshots/${"4".repeat(64)}.tar.gz`,
        },
        release: {
          app: {
            title: "Legacy App",
            description: "Completed before packageId became required",
          },
          version: "0.1.2",
          releaseNotes: "Legacy terminal release",
          visibility: "restricted",
          employees: [],
        },
        applyToCurrentApp: false,
        idempotencyKey: "og-app-release-53db208fb2dce3aff8b22db67fdab86ad2c45da76a5411f6a75175ae18d9c546",
        intentDigest: "53db208fb2dce3aff8b22db67fdab86ad2c45da76a5411f6a75175ae18d9c546",
        phase: "local_finalized",
        remoteIntentId: "legacy-release-intent",
        remoteStatus: "registry_indexed",
        registryVersion: {
          packageKey: "opengrove.legacy-release-app",
          version: "0.1.2",
          releaseCommitSha: "6".repeat(40),
          archiveSha256: "7".repeat(64),
          archiveSize: 1024,
        },
        createdAt: "2026-07-31T10:25:33.205Z",
        updatedAt: "2026-07-31T10:30:57.843Z",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const compatibleLegacyRecord = store.read(legacyLocalAppId);
  assert.equal(compatibleLegacyRecord?.phase, "local_finalized");
  assert.equal(
    compatibleLegacyRecord?.remoteStatus,
    "published",
    "the old Host terminal status must normalize before entering the current release domain",
  );
  const legacyReplacementSource = Buffer.from("new release after legacy terminal journal", "utf8");
  const legacyReplacement = store.createOrResume({
    localAppId: legacyLocalAppId,
    appId: legacyLocalAppId,
    packageId: "registry-legacy-release-app",
    organization: "open-grove",
    packageKey: "opengrove.legacy-release-app",
    expectedMainSha: null,
    draftDigest: "8".repeat(64),
    sourceSnapshot: {
      sha256: sha256(legacyReplacementSource),
      size: legacyReplacementSource.byteLength,
      files: [
        {
          path: "opengrove.app.json",
          sha256: "9".repeat(64),
          size: 256,
          mode: "100644",
        },
      ],
      bytes: legacyReplacementSource,
    },
    release: releaseFixture(),
    applyToCurrentApp: false,
  });
  assert.equal(
    legacyReplacement.packageId,
    "registry-legacy-release-app",
    "a completed legacy journal must not block the next release",
  );

  const record = store.createOrResume({
    localAppId: "local-release-app",
    appId: "release-app",
    packageId: "registry-package-id",
    organization: "open-grove",
    packageKey: "opengrove.release-app",
    expectedMainSha: null,
    draftDigest: "a".repeat(64),
    sourceSnapshot: {
      sha256: sourceSha256,
      size: source.byteLength,
      files: [
        {
          path: "opengrove.app.json",
          sha256: "b".repeat(64),
          size: 128,
          mode: "100644",
        },
      ],
      bytes: source,
    },
    release: releaseFixture(),
    applyToCurrentApp: false,
  });
  assert.deepEqual(store.readSnapshot(record), source);
  assert.deepEqual(
    store.createOrResume({
      localAppId: record.localAppId,
      appId: record.appId,
      packageId: record.packageId!,
      organization: record.organization,
      packageKey: record.packageKey,
      expectedMainSha: record.expectedMainSha,
      publishBase: record.publishBase,
      draftDigest: record.draftDigest,
      sourceSnapshot: {
        sha256: record.sourceSnapshot.sha256,
        size: record.sourceSnapshot.size,
        files: record.sourceSnapshot.files,
        bytes: source,
      },
      release: releaseFixture(),
      applyToCurrentApp: false,
    }),
    record,
    "restart must resume the exact local release transaction",
  );
  const blockedRecord = store.recordBlocked({
    localAppId: record.localAppId,
    expectedRevision: record.revision,
    conflict: {
      id: "blocked-release-intent",
      status: "trusted_build_failed",
      packageKey: record.packageKey,
      version: record.release.version,
      sourceSha256: record.sourceSnapshot.sha256,
      createdAt: "2026-08-18T04:00:00.000Z",
      allowedActions: ["abandon"],
      matchesCurrentSource: true,
      matchesCurrentRequest: true,
      buildFailure: {
        stage: "artifact_gate",
        code: "package_manifest_invalid",
        retryable: false,
        workflowRunId: "32824193615",
      },
    },
  });
  const blockedJournalPath = join(root, "journals", sha256(Buffer.from(record.localAppId, "utf8")), "current.json");
  const wrongPackage = structuredClone(blockedRecord);
  wrongPackage.blockedRelease!.packageKey = "opengrove.attacker";
  writeFileSync(blockedJournalPath, `${JSON.stringify(wrongPackage, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => store.read(record.localAppId),
    /app_store_publish_journal_corrupted/,
    "a blocked task from another package must fail closed on disk reload",
  );
  const falseSourceMatch = structuredClone(blockedRecord);
  falseSourceMatch.blockedRelease!.matchesCurrentSource = false;
  writeFileSync(blockedJournalPath, `${JSON.stringify(falseSourceMatch, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => store.read(record.localAppId),
    /app_store_publish_journal_corrupted/,
    "the source-match flag must remain derived from the immutable journal source",
  );
  const legacySourceOnlyMatch = structuredClone(blockedRecord) as unknown as Record<string, unknown>;
  delete (legacySourceOnlyMatch.blockedRelease as Record<string, unknown>).matchesCurrentRequest;
  writeFileSync(blockedJournalPath, `${JSON.stringify(legacySourceOnlyMatch, null, 2)}\n`, { mode: 0o600 });
  const normalizedLegacyMatch = store.read(record.localAppId);
  assert.equal(normalizedLegacyMatch?.blockedRelease?.matchesCurrentSource, true);
  assert.equal(normalizedLegacyMatch?.blockedRelease?.matchesCurrentRequest, false);
  assert.deepEqual(normalizedLegacyMatch?.blockedRelease?.allowedActions, ["abandon"]);
  writeFileSync(blockedJournalPath, `${JSON.stringify(blockedRecord, null, 2)}\n`, { mode: 0o600 });
  assert.equal(store.read(record.localAppId)?.phase, "remote_blocked");
  const opaqueConflictRecord = store.recordOpaqueConflict({
    localAppId: record.localAppId,
    expectedRevision: blockedRecord.revision,
    requestId: "c".repeat(32),
  });
  assert.equal(opaqueConflictRecord.conflictRequestId, "c".repeat(32));
  const orphanedIntentId = {
    ...opaqueConflictRecord,
    remoteIntentId: "orphaned-release-intent",
  };
  writeFileSync(blockedJournalPath, `${JSON.stringify(orphanedIntentId, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => store.read(record.localAppId),
    /app_store_publish_journal_corrupted/,
    "an opaque conflict with an orphaned remote intent id must fail closed",
  );
  const orphanedStatus = {
    ...opaqueConflictRecord,
    remoteStatus: "building",
  };
  writeFileSync(blockedJournalPath, `${JSON.stringify(orphanedStatus, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => store.read(record.localAppId),
    /app_store_publish_journal_corrupted/,
    "an opaque conflict with an orphaned remote status must fail closed",
  );
  writeFileSync(blockedJournalPath, `${JSON.stringify(opaqueConflictRecord, null, 2)}\n`, { mode: 0o600 });
  const clearedOpaqueConflict = store.clearOpaqueConflict({
    localAppId: record.localAppId,
    expectedRevision: opaqueConflictRecord.revision,
  });
  assert.equal(clearedOpaqueConflict.phase, "draft_saved");
  assert.equal(clearedOpaqueConflict.remoteIntentId, undefined);
  assert.equal(clearedOpaqueConflict.remoteStatus, undefined);
  assert.equal(clearedOpaqueConflict.conflictRequestId, undefined);

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalAbortSignalTimeout = AbortSignal.timeout;
  let requestedTimeoutMs = 0;
  AbortSignal.timeout = ((milliseconds: number) => {
    requestedTimeoutMs = milliseconds;
    return originalAbortSignalTimeout(milliseconds);
  }) as typeof AbortSignal.timeout;
  let metadata: ReleaseControlStartMetadata | undefined;
  let status: ReleaseControlIntent["status"] = "building";
  const client = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test/",
    accessToken: "ww-session-token",
    fetch: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      assert.equal(headerValue(init.headers, "authorization"), "Bearer ww-session-token");
      if (url.endsWith("/v1/app-releases")) {
        assert.ok(init.body instanceof FormData);
        metadata = JSON.parse(String(init.body.get("metadata"))) as ReleaseControlStartMetadata;
        const uploaded = init.body.get("source");
        assert.ok(uploaded instanceof Blob);
        assert.equal(Buffer.from(await uploaded.arrayBuffer()).equals(source), true);
      } else if (url.endsWith("/candidate-retries") || url.endsWith("/build-retries")) {
        status = "building";
      } else if (url.endsWith("/finalize")) {
        status = "published";
      } else if (url.endsWith("/abandon")) {
        status = "abandoned";
      }
      assert.ok(metadata);
      return jsonResponse({ release: intentFixture(metadata, status) }, status === "published" ? 200 : 202);
    }) as typeof fetch,
  });

  let started: ReleaseControlIntent;
  try {
    started = await client.start(record, source);
  } finally {
    AbortSignal.timeout = originalAbortSignalTimeout;
  }
  assert.equal(
    requestedTimeoutMs,
    12 * 60_000,
    "the Host release request must outlive Release Control's 10-minute server and 11-minute ingress budgets",
  );
  assert.equal(started.status, "building");
  assert.equal(requests[0]?.url, "https://release-control.example.test/v1/app-releases");
  assert.match(
    headerValue(requests[0]?.init.headers, "x-request-id") ?? "",
    /^[a-f0-9]{32}$/,
    "Host must assign a safe request id that Release Control can echo in its logs",
  );
  assert.equal(
    headerValue(requests[0]?.init.headers, "content-type"),
    undefined,
    "fetch must own the multipart boundary",
  );
  assert.equal(metadata?.sourceSha256, sourceSha256);
  assert.equal(metadata?.sourceSize, source.byteLength);
  assert.equal(metadata?.sourceArchiveName, "release-app-0.1.0-source.tgz");
  assert.equal(metadata?.packageId, "registry-package-id");
  assert.equal(metadata?.minHostReleaseNumber, 42);
  assert.equal(metadata?.repositoryName, "release-app");
  assert.deepEqual(metadata?.publishBase, {
    releaseCommitSha: "",
    version: "",
    archiveSha256: "",
  });
  assert.doesNotThrow(() => assertReleaseControlIntentMatchesJournal(started, record));

  const recovered = await client.findByIdempotencyKey(record.idempotencyKey);
  assert.equal(recovered.id, started.id);
  assert.equal(
    requests[1]?.url,
    `https://release-control.example.test/v1/app-releases/by-idempotency-key/${record.idempotencyKey}`,
  );
  assert.equal(requests[1]?.init.method, "GET");
  assert.equal(requests[1]?.init.body, undefined);

  const recoveredById = await client.findById(started.id);
  assert.equal(recoveredById.id, started.id);
  assert.equal(requests[2]?.url, "https://release-control.example.test/v1/app-releases/release-intent-1");
  assert.equal(requests[2]?.init.method, "GET");

  status = "awaiting_candidate";
  const candidateRetried = await client.retryCandidate(started.id);
  assert.equal(candidateRetried.status, "building");

  status = "trusted_build_failed";
  const failed = await client.start(record, source);
  assert.equal(failed.status, "trusted_build_failed");
  assert.deepEqual(failed.buildFailure, {
    stage: "artifact_gate",
    code: "package_manifest_invalid",
    retryable: false,
    workflowRunId: "32824193615",
  });
  await client.retryBuild(started.id);
  const abandoned = await client.abandon(started.id);
  assert.equal(abandoned.status, "abandoned");
  status = "trusted_build_failed";
  const finalized = await client.finalize(started.id);
  assert.equal(finalized.status, "published");
  assert.equal(requests[3]?.url.endsWith("/v1/app-releases/release-intent-1/candidate-retries"), true);
  assert.equal(requests[5]?.url.endsWith("/v1/app-releases/release-intent-1/build-retries"), true);
  assert.equal(requests[6]?.url.endsWith("/v1/app-releases/release-intent-1/abandon"), true);
  assert.equal(requests[7]?.url.endsWith("/v1/app-releases/release-intent-1/finalize"), true);

  const identityMismatch = { ...finalized, packageKey: "attacker.app" };
  assert.throws(
    () => assertReleaseControlIntentMatchesJournal(identityMismatch, record),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "app_release_response_identity_mismatch" &&
      error.requestId === finalized.requestId,
    "a successful but mismatched response must retain its request id for cross-service diagnosis",
  );

  const errorClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () => jsonResponse({ error: "app_release_publish_base_stale" }, 409)) as typeof fetch,
  });
  await assert.rejects(
    () => errorClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.status === 409 &&
      error.message === "app_release_publish_base_stale",
  );

  const conflictClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      jsonResponse(
        {
          error: "app_release_in_progress",
          release: {
            id: "preserved-release-1",
            status: "trusted_build_failed",
            packageKey: record.packageKey,
            version: record.release.version,
            sourceSha256: record.sourceSnapshot.sha256,
            createdAt: "2026-08-18T04:00:00.000Z",
            allowedActions: ["abandon"],
            buildFailure: {
              stage: "artifact_gate",
              code: "package_manifest_invalid",
              retryable: false,
              workflowRunId: "32824193615",
            },
          },
        },
        409,
      )) as typeof fetch,
  });
  await assert.rejects(
    () => conflictClient.start(record, source),
    (error: unknown) => {
      const conflict =
        error instanceof ReleaseControlClientError
          ? (error as ReleaseControlClientError & { releaseConflict?: Record<string, unknown> }).releaseConflict
          : undefined;
      return (
        error instanceof ReleaseControlClientError &&
        error.status === 409 &&
        error.message === "app_release_in_progress" &&
        conflict?.id === "preserved-release-1" &&
        conflict.status === "trusted_build_failed" &&
        conflict.sourceSha256 === record.sourceSnapshot.sha256 &&
        Array.isArray(conflict.allowedActions) &&
        conflict.allowedActions.join(",") === "abandon" &&
        conflict.buildFailure?.retryable === false
      );
    },
    "an authenticated conflict must retain only the safe recovery projection",
  );

  const extraConflictFieldClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      jsonResponse(
        {
          error: "app_release_in_progress",
          release: {
            id: "preserved-release-1",
            status: "trusted_build_failed",
            packageKey: record.packageKey,
            version: record.release.version,
            sourceSha256: record.sourceSnapshot.sha256,
            createdAt: "2026-08-18T04:00:00.000Z",
            allowedActions: ["abandon"],
            unexpected: "must not be accepted as buildFailure",
          },
        },
        409,
      )) as typeof fetch,
  });
  await assert.rejects(
    () => extraConflictFieldClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.status === 409 &&
      error.message === "app_release_error_response_invalid",
    "a conflict without buildFailure must reject an unrelated eighth field",
  );

  const candidateDiagnosticClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: "release_control_dependency_unavailable",
        }),
        {
          status: 502,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-opengrove-candidate-stage": "candidate_ref_push",
          },
        },
      )) as typeof fetch,
  });
  await assert.rejects(
    () => candidateDiagnosticClient.retryCandidate("release-intent-1"),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "release_control_dependency_unavailable" &&
      error.candidateStage === "candidate_ref_push" &&
      /^[a-f0-9]{32}$/.test(error.requestId ?? ""),
    "safe candidate failure stages must survive the Release Control client boundary",
  );

  const rejectedIntent = intentFixture(releaseControlStartMetadata(record), "abandoned");
  const secretBlockedClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: "app_release_secret_blocked",
          release: rejectedIntent,
        }),
        {
          status: 422,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-opengrove-candidate-stage": "candidate_ref_push",
          },
        },
      )) as typeof fetch,
  });
  await assert.rejects(
    () => secretBlockedClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.status === 422 &&
      error.message === "app_release_secret_blocked" &&
      error.candidateStage === "candidate_ref_push" &&
      error.rejectedIntent?.id === rejectedIntent.id &&
      error.rejectedIntent.status === "abandoned" &&
      /^[a-f0-9]{32}$/.test(error.requestId ?? ""),
    "GitHub Push Protection must carry the safely closed intent across the client boundary",
  );

  const wrongStageSecretBlockedClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: "app_release_secret_blocked",
          release: rejectedIntent,
        }),
        {
          status: 422,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-opengrove-candidate-stage": "candidate_publish",
          },
        },
      )) as typeof fetch,
  });
  await assert.rejects(
    () => wrongStageSecretBlockedClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "app_release_error_response_invalid" &&
      error.rejectedIntent === undefined,
    "a secret-shaped error outside the exact Git push stage must not close the local release",
  );

  const unknownCandidateDiagnosticClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: "release_control_dependency_unavailable",
        }),
        {
          status: 502,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-opengrove-candidate-stage": "raw_dependency_failure",
          },
        },
      )) as typeof fetch,
  });
  await assert.rejects(
    () => unknownCandidateDiagnosticClient.retryCandidate("release-intent-1"),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "release_control_dependency_unavailable" &&
      error.candidateStage === undefined,
    "unknown upstream diagnostic stages must fail closed",
  );

  for (const stableIdentityError of ["release_control_unauthorized", "release_control_identity_unavailable"]) {
    const identityErrorClient = new ReleaseControlClient({
      baseUrl: "https://release-control.example.test",
      accessToken: "ww-session-token",
      fetch: (async () => jsonResponse({ error: stableIdentityError }, 503)) as typeof fetch,
    });
    await assert.rejects(
      () => identityErrorClient.start(record, source),
      (error: unknown) => error instanceof ReleaseControlClientError && error.message === stableIdentityError,
      `stable Release Control identity error ${stableIdentityError} must remain actionable`,
    );
  }

  const hostileErrorClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async () =>
      jsonResponse(
        {
          error: "remote_internal_fault_do_not_expose_1234567890",
        },
        502,
      )) as typeof fetch,
  });
  await assert.rejects(
    () => hostileErrorClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.status === 502 &&
      error.message === "app_release_error_response_invalid",
    "an upstream error string outside the stable Release Control vocabulary must fail closed",
  );

  let unavailableRequestId = "";
  const unavailableClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async (_input, init = {}) => {
      unavailableRequestId = headerValue(init.headers, "x-request-id") ?? "";
      throw new TypeError("socket failed with sensitive local detail");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => unavailableClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "app_release_request_unavailable" &&
      error.requestId === unavailableRequestId &&
      /^[a-f0-9]{32}$/.test(error.requestId),
    "transport failures must preserve the exact safe request id without exposing the network exception",
  );

  let interruptedBodyRequestId = "";
  const interruptedBodyClient = new ReleaseControlClient({
    baseUrl: "https://release-control.example.test",
    accessToken: "ww-session-token",
    fetch: (async (_input, init = {}) => {
      interruptedBodyRequestId = headerValue(init.headers, "x-request-id") ?? "";
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("body stream failed with sensitive proxy detail"));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    () => interruptedBodyClient.start(record, source),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.message === "app_release_request_unavailable" &&
      error.requestId === interruptedBodyRequestId &&
      /^[a-f0-9]{32}$/.test(error.requestId),
    "response-body transport failures must preserve the same safe request id and hide stream details",
  );

  process.stdout.write("app release journal and Release Control client harness passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function releaseFixture(): MountedAppReleaseDraft {
  return {
    identity: {
      appId: "release-app",
      source: "mounted",
      appRoot: "/local/path/must-not-enter-journal",
      workspaceRoot: "/local/workspace/must-not-enter-journal",
    },
    app: {
      title: "Release App",
      description: "Published through Release Control",
    },
    version: "0.1.0",
    releaseNotes: "First formal version",
    visibility: "restricted",
    minHostReleaseNumber: 42,
    employees: [
      {
        memberId: "member-app-release-app-writer",
        name: "Writer",
        role: "Writes.",
        kernel: "claude-code",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
        contextTokenBudget: 200_000,
        accessMode: "full-access",
        color: "#148a47",
        availableSkillIds: [],
        defaultSkillIds: [],
        visibility: "private",
        publicSkills: [],
      },
    ],
    checks: [],
  };
}

function intentFixture(
  input: ReleaseControlStartMetadata,
  status: ReleaseControlIntent["status"],
): ReleaseControlIntent {
  return {
    id: "release-intent-1",
    status,
    allowedActions: status === "trusted_build_failed" ? ["abandon"] : [],
    packageKey: input.packageKey,
    packageId: input.packageId,
    appId: input.appId,
    title: input.title,
    repositoryName: input.repositoryName,
    version: input.version,
    releaseNotes: input.releaseNotes,
    visibility: input.visibility,
    minHostReleaseNumber: input.minHostReleaseNumber,
    expectedMainSha: input.expectedMainSha,
    publishBase: input.publishBase,
    sourceSha256: input.sourceSha256,
    sourceSize: input.sourceSize,
    sourceArchiveName: input.sourceArchiveName,
    candidateSha: "c".repeat(40),
    gatedArchiveName: "release-app-0.1.0.tgz",
    gatedArchiveSize: 4096,
    gatedArchiveSha256: "d".repeat(64),
    publishedByUserId: 7,
    createdAt: "2026-08-04T00:00:00Z",
    ...(status === "trusted_build_failed"
      ? {
          buildFailure: {
            stage: "artifact_gate" as const,
            code: "package_manifest_invalid",
            retryable: false,
            workflowRunId: "32824193615",
          },
        }
      : {}),
    ...(status === "published" ? { publishedAt: "2026-08-04T00:01:00Z" } : {}),
  };
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  return new Headers(headers).get(name) ?? undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
