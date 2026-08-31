import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZipArchiveForTest } from "../diagnostics/zip.js";
import { readClientReleaseNumber, readPackageVersion } from "../server/client-release.js";
import { startLocalBridgeServer } from "../server/local-bridge.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-diagnostic-bundle-server-"));
const token = "diagnostic-bundle-server-token";
const diagnosticsDir = join(root, "desktop-diagnostics");
mkdirSync(diagnosticsDir, { recursive: true });
const claudeConfigDir = join(root, "claude-config");
const nativeSessionId = "54b20c4c-b8e4-4f16-8ad8-f21123b07a54";
const rotatedNativeSessionId = "39f12727-8eaa-4592-bca3-74514242bf0a";
const transcriptDir = join(claudeConfigDir, "projects", "-test-workspace");
const exploredFile = join(root, "workspace", "story-outline.md");
const credentialFile = join(root, "workspace", ".env");
const outsideWorkspaceFile = join(root, "outside-private.txt");
const oversizedRuntimeExecutable = join(root, "claude-runtime");
const oversizedWorkspaceFile = join(root, "workspace", "oversized-evidence.log");
const mountedAppRoot = join(root, "diagnostic-app");
mkdirSync(transcriptDir, { recursive: true });
mkdirSync(join(root, "workspace"), { recursive: true });
mkdirSync(join(root, "logs"), { recursive: true });
mkdirSync(mountedAppRoot, { recursive: true });
mkdirSync(join(mountedAppRoot, "bin"), { recursive: true });
writeFileSync(
  join(mountedAppRoot, "opengrove.app.json"),
  `${JSON.stringify({
    id: "diagnostic-app",
    title: "Diagnostic App",
    employees: [
      { id: "worker-a", name: "Worker A", kernel: "claude-code", role: "First worker" },
      { id: "worker-b", name: "Worker B", kernel: "claude-code", role: "Second worker" },
    ],
  })}\n`,
  "utf8",
);
writeFileSync(
  join(mountedAppRoot, "bin", "diagnostic-evidence.ts"),
  [
    "const token = args[i];",
    "const accessToken = process.env.OPENGROVE_WW_ACCESS_TOKEN;",
    "const contact = 'private@example.com';",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  join(root, "bridge-settings.json"),
  `${JSON.stringify({
    kernel: "claude-code",
    mountedApps: [{ id: "diagnostic-app", path: mountedAppRoot, enabled: true }],
  })}\n`,
  "utf8",
);
writeFileSync(exploredFile, "# exact explored file\nThis evidence must not be truncated.\n", "utf8");
writeFileSync(credentialFile, "ANTHROPIC_API_KEY=sk-testcredential123456789\n", "utf8");
writeFileSync(outsideWorkspaceFile, "outside workspace secret evidence\n", "utf8");
writeFileSync(oversizedRuntimeExecutable, "", "utf8");
truncateSync(oversizedRuntimeExecutable, 129 * 1024 * 1024);
chmodSync(oversizedRuntimeExecutable, 0o755);
writeFileSync(
  join(transcriptDir, `${nativeSessionId}.jsonl`),
  `${JSON.stringify({ type: "user", message: "native transcript first turn" })}\n${JSON.stringify({ type: "assistant", message: "native transcript wrong answer" })}\n`,
  "utf8",
);
writeFileSync(
  join(transcriptDir, `${rotatedNativeSessionId}.jsonl`),
  `${JSON.stringify({ type: "assistant", message: "rotated native session evidence" })}\n`,
  "utf8",
);
writeFileSync(
  join(root, "logs", "bridge.log"),
  [
    "complete bridge log evidence",
    "sk-testsecret123456789",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature0123456789",
    "authorization: Bearer opaque-credential-value",
    "private@example.com",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(join(root, "logs", "desktop-main.log"), "complete desktop log evidence\n", "utf8");
writeFileSync(
  join(root, "state.json"),
  `${JSON.stringify(
    {
      version: 9,
      savedAt: "2026-07-28T12:00:10.000Z",
      sessions: [
        {
          id: "session-run-diagnostic",
          title: "Story Seed room session",
          status: "idle",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:08.000Z",
          latestRunId: "run-diagnostic-target",
          runIds: ["run-diagnostic-prior", "run-diagnostic-target"],
          metadata: {
            claudeCodeSessionIds: {
              "room-worker": nativeSessionId,
              "room-worker-rotated": rotatedNativeSessionId,
            },
          },
        },
        {
          id: "session-incomplete",
          title: "Incomplete retained event session",
          status: "idle",
          createdAt: "2026-07-28T12:00:09.000Z",
          updatedAt: "2026-07-28T12:00:10.000Z",
          latestRunId: "run-unrelated",
          runIds: ["run-unrelated"],
        },
      ],
      runs: [
        {
          id: "run-diagnostic-prior",
          sessionId: "session-run-diagnostic",
          activity: "chat",
          status: "succeeded",
          input: "remember the actual story constraints",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:02.000Z",
          startedAt: "2026-07-28T12:00:00.000Z",
          endedAt: "2026-07-28T12:00:02.000Z",
          resumeCount: 0,
          approvalIds: [],
          questionIds: [],
          toolIds: [],
          eventCount: 1,
        },
        {
          id: "run-diagnostic-target",
          sessionId: "session-run-diagnostic",
          activity: "chat",
          status: "succeeded",
          input: "write the outline",
          createdAt: "2026-07-28T12:00:03.000Z",
          updatedAt: "2026-07-28T12:00:08.000Z",
          startedAt: "2026-07-28T12:00:03.000Z",
          endedAt: "2026-07-28T12:00:08.000Z",
          modelId: "claude-sonnet-4-5",
          summary: "plausible but incorrect output",
          resumeCount: 0,
          approvalIds: [],
          questionIds: [],
          toolIds: ["native.read"],
          eventCount: 5_003,
        },
        {
          id: "run-unrelated",
          sessionId: "session-incomplete",
          activity: "chat",
          status: "succeeded",
          input: "unrelated private room evidence",
          createdAt: "2026-07-28T12:00:09.000Z",
          updatedAt: "2026-07-28T12:00:10.000Z",
          startedAt: "2026-07-28T12:00:09.000Z",
          endedAt: "2026-07-28T12:00:10.000Z",
          resumeCount: 0,
          approvalIds: [],
          questionIds: [],
          toolIds: [],
          eventCount: 100,
        },
      ],
      events: [
        {
          type: "assistant.final",
          runId: "run-diagnostic-prior",
          text: "prior answer that should remain in the context chain",
        },
        {
          type: "assistant.final",
          runId: "run-diagnostic-prior",
          text: "prior answer that should remain in the context chain",
        },
        ...Array.from({ length: 5_001 }, (_, index) => ({
          type: "assistant.status",
          runId: "run-diagnostic-target",
          at: new Date(Date.UTC(2026, 6, 28, 12, 0, 3) + index).toISOString(),
          text: `cold archived event ${index}`,
        })),
        {
          type: "model.requested",
          runId: "run-diagnostic-target",
          request: {
            systemPrompt: "full system prompt evidence",
            userInput: "write the outline",
            messages: [{ role: "user", content: "complete assembled model history" }],
            tools: [],
            skills: [],
            packs: [],
            capabilities: [],
            session: {
              provider: "claude-code",
              sessionId: nativeSessionId,
              persistent: true,
              priorMessageCount: 1,
              priorMessages: [{ role: "assistant", content: "native prior message" }],
            },
          },
        },
        {
          type: "tool.started",
          runId: "run-diagnostic-target",
          toolId: "native.read",
          callId: "call-read-story",
          input: {
            file_path: exploredFile,
            credential_path: credentialFile,
            outside_path: outsideWorkspaceFile,
            runtime_path: oversizedRuntimeExecutable,
            large_path: oversizedWorkspaceFile,
          },
        },
        {
          type: "assistant.final",
          runId: "run-diagnostic-target",
          text: "wrong generated outline",
        },
        {
          type: "assistant.final",
          runId: "run-unrelated",
          text: "unrelated private room evidence",
        },
      ],
      executions: [
        {
          id: "execution-run-diagnostic",
          runId: "run-diagnostic-target",
          sessionId: "session-run-diagnostic",
          kind: "tool_call",
          eventType: "tool.finished",
          title: "Read story outline",
          at: "2026-07-28T12:00:05.000Z",
          status: "completed",
          toolId: "native.read",
          data: { output: "exact execution output" },
        },
      ],
      memory: [
        {
          id: "memory-run-reference",
          scope: "session",
          kind: "diagnostic-evidence",
          text: "memory linked through an embedded run locator",
          confidence: "observed",
          source: {
            kind: "agent",
            ref: { title: "Run evidence", locator: "run:run-diagnostic-target" },
          },
          tags: ["diagnostic"],
          createdAt: "2026-07-28T12:00:06.000Z",
          updatedAt: "2026-07-28T12:00:06.000Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-run-reference",
          type: "diagnostic-evidence",
          tags: ["diagnostic"],
          data: { source: "runs/run-diagnostic-target/output.txt" },
          provenance: { "run-diagnostic-target": { relation: "produced-by" } },
          createdAt: "2026-07-28T12:00:07.000Z",
          updatedAt: "2026-07-28T12:00:07.000Z",
        },
      ],
      rooms: {
        version: 1,
        currentEventSeq: 2,
        rooms: [
          {
            id: "room-run-diagnostic",
            kind: "group",
            title: "Story Seed",
            badge: "SS",
            memberIds: ["room-worker", "room-worker-peer"],
            adminMemberIds: [],
            updatedAt: "2026-07-28T12:00:08.000Z",
            unread: 0,
          },
          {
            id: "room-unrelated",
            kind: "direct",
            title: "Unrelated private room",
            badge: "UP",
            memberIds: [],
            adminMemberIds: [],
            updatedAt: "2026-07-28T12:00:09.000Z",
            unread: 0,
          },
        ],
        members: [
          {
            id: "room-worker",
            name: "Story Worker",
            kernel: "claude-code",
            model: "claude-sonnet-4-5",
            role: "Write story outlines",
            status: "idle",
            color: "#2563eb",
            lastActive: "online",
            source: "local",
            workspaceRoot: join(root, "workspace"),
            appId: "diagnostic-app",
          },
          {
            id: "room-worker-peer",
            name: "Story Worker Peer",
            kernel: "claude-code",
            model: "claude-sonnet-4-5",
            role: "Review story outlines",
            status: "idle",
            color: "#7c3aed",
            lastActive: "online",
            source: "local",
            workspaceRoot: join(root, "workspace"),
            appId: "diagnostic-app",
          },
        ],
        messages: [
          {
            id: "message-diagnostic-user",
            roomId: "room-run-diagnostic",
            channelSeq: 1,
            senderId: "user",
            senderName: "You",
            senderType: "user",
            text: "write the outline with these exact constraints",
            targetIds: ["room-worker"],
            status: "sent",
            createdAt: "2026-07-28T12:00:03.000Z",
            updatedAt: "2026-07-28T12:00:03.000Z",
          },
          {
            id: "message-diagnostic-agent",
            roomId: "room-run-diagnostic",
            channelSeq: 2,
            senderId: "room-worker",
            senderName: "Story Worker",
            senderType: "agent",
            text: "wrong generated outline",
            targetIds: [],
            status: "done",
            runId: "run-diagnostic-target",
            createdAt: "2026-07-28T12:00:04.000Z",
            updatedAt: "2026-07-28T12:00:08.000Z",
          },
          {
            id: "message-without-run",
            roomId: "room-run-diagnostic",
            channelSeq: 3,
            senderId: "room-worker",
            senderName: "Story Worker",
            senderType: "agent",
            text: "legacy response without a run",
            targetIds: [],
            status: "done",
            createdAt: "2026-07-28T12:00:08.000Z",
            updatedAt: "2026-07-28T12:00:08.000Z",
          },
          {
            id: "message-unrelated",
            roomId: "room-unrelated",
            channelSeq: 1,
            senderId: "room-worker",
            senderName: "Story Worker",
            senderType: "agent",
            text: "unrelated private room evidence",
            targetIds: [],
            status: "done",
            runId: "run-unrelated",
            createdAt: "2026-07-28T12:00:09.000Z",
            updatedAt: "2026-07-28T12:00:09.000Z",
          },
        ],
        events: [
          {
            schemaVersion: 2,
            eventSeq: 1,
            type: "room.message.created",
            roomId: "room-run-diagnostic",
            messageId: "message-diagnostic-user",
            createdAt: "2026-07-28T12:00:03.000Z",
            payload: { text: "write the outline with these exact constraints" },
          },
        ],
        deletedMemberIds: [],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const diagnosticProblem = {
  incidentId: "OG-20260728-ABC123",
  traceId: "trace-diagnostic-bundle",
  at: "2026-07-28T12:00:00.000Z",
  category: "bridge",
  phase: "request",
  code: "bridge_request_failed",
  level: "error",
  retryable: true,
  message: `raw log and secret ${token} must not be exported`,
  runId: "run-diagnostic-target",
  context: { roomId: "room-run-diagnostic", memberId: "room-worker" },
  facts: {
    providerKind: "ww",
    selectedModelId: "claude-sonnet-4-5",
    requestedModelId: "claude-sonnet-4-5",
    runtimeModelId: "claude-sonnet-4-5-20250929",
    upstreamRequestId: "req-diagnostic-bundle",
    durationMs: 120,
  },
};
writeFileSync(join(diagnosticsDir, "problems.jsonl"), `${JSON.stringify(diagnosticProblem)}\n`, "utf8");

const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousDiagnosticsDir = process.env.OPENGROVE_DIAGNOSTICS_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
process.env.OPENGROVE_DIAGNOSTICS_DIR = diagnosticsDir;
const server = startLocalBridgeServer({
  host: "127.0.0.1",
  port: 0,
  statePath: join(root, "state.json"),
  bridgeToken: token,
});

try {
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/diagnostics/bundle`;

  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(url, { headers: { "x-opengrove-token": token } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="OpenGrove-system-forensics-.+\.zip"$/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const archiveBuffer = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("x-opengrove-sha256"), createHash("sha256").update(archiveBuffer).digest("hex"));
  assert.equal(response.headers.get("x-opengrove-size"), String(archiveBuffer.length));
  assert.equal(response.headers.get("x-opengrove-evidence-complete"), "true");
  const archive = readZipArchiveForTest(archiveBuffer);
  for (const path of [
    "README.txt",
    "bridge-status.json",
    "file-index.json",
    "logs/bridge.log",
    "logs/desktop-main.log",
    "manifest.json",
    "problems.jsonl",
    "recent-run-errors.json",
    "redaction-report.json",
    "store-app-layout.json",
  ])
    assert.ok(archive.has(path), `missing system diagnostic evidence: ${path}`);
  const text = Buffer.concat([...archive.values()]).toString("utf8");
  assert.equal(text.includes(token), false, "the raw bridge token must not appear anywhere in the archive");
  assert.match(text, /raw log and secret/, "free-form error text must remain available for trusted troubleshooting");
  assert.match(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(archive.get("problems.jsonl")?.toString("utf8") ?? "", /OG-20260728-ABC123/);
  const storeAppLayout = JSON.parse(archive.get("store-app-layout.json")?.toString("utf8") ?? "{}") as Record<
    string,
    any
  >;
  assert.equal(storeAppLayout.migration?.id, "store-app-layout-v2");
  assert.equal(storeAppLayout.migration?.introducedIn, "0.6.5");
  assert.equal(storeAppLayout.activationPointer, "bridge-settings.json");
  assert.ok(Array.isArray(storeAppLayout.mountedApps));
  assert.equal(storeAppLayout.mountedAppsAvailable, true);
  const manifest = JSON.parse(archive.get("manifest.json")?.toString("utf8") ?? "{}") as Record<string, any>;
  assert.equal(manifest.formatVersion, 5);
  assert.equal(manifest.kind, "opengrove-system-forensic-bundle");
  assert.equal(manifest.privacy?.includesLogContent, true);
  assert.equal(manifest.privacy?.includesProblemMessages, true);
  assert.equal(manifest.credentials?.credentialFilesIncluded, false);
  assert.equal(manifest.credentials?.stateStoreIncluded, false);
  assert.equal(manifest.versions?.app, readPackageVersion());
  assert.equal(manifest.versions?.clientReleaseNumber, readClientReleaseNumber());
  assert.equal(manifest.versions?.claudeAgentSdk, "0.3.231");
  assert.equal("electron" in (manifest.versions ?? {}), false);
  assert.equal("chrome" in (manifest.versions ?? {}), false);
  assert.equal("packaged" in (manifest.system ?? {}), false);
  const bridgeStatus = JSON.parse(archive.get("bridge-status.json")?.toString("utf8") ?? "{}") as Record<
    string,
    unknown
  >;
  assert.equal("restartCount" in bridgeStatus, false);
  assert.equal("crashCount" in bridgeStatus, false);

  rmSync(join(diagnosticsDir, "problems.jsonl"));
  const emptyResponse = await fetch(url, { headers: { "x-opengrove-token": token } });
  assert.equal(emptyResponse.status, 200, "a missing problem log must still produce a usable bundle");
  const emptyArchive = readZipArchiveForTest(Buffer.from(await emptyResponse.arrayBuffer()));
  assert.equal(emptyArchive.has("problems.jsonl"), false);
  assert.ok(
    Buffer.concat([...emptyArchive.values()]).length <= 128 * 1024 * 1024,
    "the uncompressed diagnostic payload must stay within its documented bound",
  );
  writeFileSync(join(diagnosticsDir, "problems.jsonl"), `${JSON.stringify(diagnosticProblem)}\n`, "utf8");

  truncateSync(join(root, "logs", "desktop-main.log"), 129 * 1024 * 1024);
  appendFileSync(join(root, "logs", "desktop-main.log"), "\nlatest desktop tail evidence\n", "utf8");
  const incompleteSystemResponse = await fetch(url, { headers: { "x-opengrove-token": token } });
  assert.equal(incompleteSystemResponse.status, 200, "oversized optional system evidence must not block export");
  assert.equal(incompleteSystemResponse.headers.get("x-opengrove-evidence-complete"), "false");
  const incompleteSystemArchive = readZipArchiveForTest(Buffer.from(await incompleteSystemResponse.arrayBuffer()));
  const incompleteSystemManifest = JSON.parse(
    incompleteSystemArchive.get("manifest.json")?.toString("utf8") ?? "{}",
  ) as Record<string, any>;
  assert.equal(incompleteSystemManifest.completeness?.evidenceComplete, false);
  assert.ok(
    (incompleteSystemManifest.completeness?.missingEvidence as string[] | undefined)?.some((item) =>
      item.startsWith("evidence-truncated-tail:"),
    ),
  );
  assert.match(
    incompleteSystemArchive.get("logs/desktop-main.log")?.toString("utf8") ?? "",
    /latest desktop tail evidence/,
  );
  const incompleteSystemFileIndex = JSON.parse(
    incompleteSystemArchive.get("file-index.json")?.toString("utf8") ?? "{}",
  ) as Record<string, any>;
  assert.equal(
    incompleteSystemFileIndex.included?.find(
      (file: Record<string, any>) => file.archivePath === "logs/desktop-main.log",
    )?.truncation?.reason,
    "evidence-truncated-tail",
  );
  writeFileSync(join(root, "logs", "desktop-main.log"), "complete desktop log evidence\n", "utf8");

  truncateSync(join(diagnosticsDir, "problems.jsonl"), 129 * 1024 * 1024);
  const oversizedProblemResponse = await fetch(url, { headers: { "x-opengrove-token": token } });
  assert.equal(oversizedProblemResponse.status, 200, "oversized problem evidence must be rejected before inclusion");
  const oversizedProblemArchive = readZipArchiveForTest(Buffer.from(await oversizedProblemResponse.arrayBuffer()));
  assert.equal(oversizedProblemArchive.has("problems.jsonl"), false);
  const oversizedProblemManifest = JSON.parse(
    oversizedProblemArchive.get("manifest.json")?.toString("utf8") ?? "{}",
  ) as Record<string, any>;
  assert.ok(
    (oversizedProblemManifest.completeness?.missingEvidence as string[] | undefined)?.some((item) =>
      item.startsWith("evidence-size-limit:"),
    ),
  );
  writeFileSync(join(diagnosticsDir, "problems.jsonl"), `${JSON.stringify(diagnosticProblem)}\n`, "utf8");

  const runBundleUrl = `http://127.0.0.1:${address.port}/api/diagnostics/run-bundle?roomId=room-run-diagnostic&messageId=message-diagnostic-agent`;
  const missingScopeResponse = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/run-bundle`, {
    headers: { "x-opengrove-token": token },
  });
  assert.equal(missingScopeResponse.status, 400);
  assert.equal(((await missingScopeResponse.json()) as { error?: string }).error, "run_diagnostic_scope_required");
  const missingRoomResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/diagnostics/run-bundle?roomId=missing&messageId=missing`,
    { headers: { "x-opengrove-token": token } },
  );
  assert.equal(missingRoomResponse.status, 404);
  assert.equal(((await missingRoomResponse.json()) as { error?: string }).error, "run_diagnostic_room_not_found");
  const noRunResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/diagnostics/run-bundle?roomId=room-run-diagnostic&messageId=message-without-run`,
    { headers: { "x-opengrove-token": token } },
  );
  assert.equal(noRunResponse.status, 409);
  assert.equal(((await noRunResponse.json()) as { error?: string }).error, "run_diagnostic_message_has_no_run");
  const runBundleResponse = await fetch(runBundleUrl, { headers: { "x-opengrove-token": token } });
  assert.equal(runBundleResponse.status, 200);
  assert.equal(runBundleResponse.headers.get("content-type"), "application/zip");
  assert.match(
    runBundleResponse.headers.get("content-disposition") ?? "",
    /^attachment; filename="OpenGrove-run-run-diagnostic-target-.+\.zip"$/,
  );
  const runArchiveBuffer = Buffer.from(await runBundleResponse.arrayBuffer());
  assert.equal(
    runBundleResponse.headers.get("x-opengrove-sha256"),
    createHash("sha256").update(runArchiveBuffer).digest("hex"),
  );
  assert.equal(runBundleResponse.headers.get("x-opengrove-size"), String(runArchiveBuffer.length));
  assert.equal(runBundleResponse.headers.get("x-opengrove-evidence-complete"), "true");
  const runArchive = readZipArchiveForTest(runArchiveBuffer);
  assert.ok(runArchive.has("manifest.json"));
  assert.ok(runArchive.has("room/room.json"));
  assert.ok(runArchive.has("room/messages.json"));
  assert.ok(runArchive.has("room/events.json"));
  assert.ok(runArchive.has("room/members.json"));
  assert.ok(runArchive.has("session/session.json"));
  assert.ok(runArchive.has("session/runs.json"));
  assert.ok(runArchive.has("session/events.jsonl"));
  assert.ok(runArchive.has("session/executions.json"));
  assert.ok(runArchive.has(`native/claude-transcripts/${nativeSessionId}.jsonl`));
  assert.ok(runArchive.has(`native/claude-transcripts/${rotatedNativeSessionId}.jsonl`));
  assert.ok(runArchive.has("app/diagnostic-app/opengrove.app.json"));
  assert.ok(runArchive.has("app/diagnostic-app/bin/diagnostic-evidence.ts"));
  assert.equal(
    [...runArchive.keys()].filter((path) => path === "app/diagnostic-app/opengrove.app.json").length,
    1,
    "members from the same mounted App must share one evidence copy",
  );
  assert.ok(runArchive.has("logs/bridge.log"));
  assert.ok(runArchive.has("logs/desktop-main.log"));
  assert.ok(runArchive.has("diagnostics/problems.jsonl"));
  assert.ok(runArchive.has("diagnostics/incidents.json"));
  assert.ok(runArchive.has("diagnostics/summary.json"));
  const runArchiveText = Buffer.concat([...runArchive.values()]).toString("utf8");
  assert.match(runArchiveText, /prior answer that should remain in the context chain/);
  assert.equal(
    (
      runArchive
        .get("session/events.jsonl")
        ?.toString("utf8")
        .match(/prior answer that should remain in the context chain/g) ?? []
    ).length,
    1,
    "only content-identical complete event copies may be removed",
  );
  assert.match(
    runArchiveText,
    /cold archived event 0/,
    "the bundle must read events older than the 5,000-event hot window from SQLite",
  );
  assert.match(runArchiveText, /full system prompt evidence/);
  assert.match(runArchiveText, /complete assembled model history/);
  assert.match(runArchiveText, /exact execution output/);
  assert.match(runArchiveText, /native transcript first turn/);
  assert.match(runArchiveText, /rotated native session evidence/);
  assert.match(runArchiveText, /memory linked through an embedded run locator/);
  assert.match(runArchiveText, /runs\/run-diagnostic-target\/output\.txt/);
  assert.match(runArchiveText, /complete bridge log evidence/);
  assert.match(runArchiveText, /complete desktop log evidence/);
  assert.match(runArchiveText, /This evidence must not be truncated/);
  assert.match(runArchiveText, /const token = args\[i\];/);
  assert.match(runArchiveText, /const accessToken = process\.env\.OPENGROVE_WW_ACCESS_TOKEN;/);
  assert.doesNotMatch(runArchiveText, /unrelated private room evidence/);
  assert.equal(runArchiveText.includes(token), false, "reusable bridge credentials must still be redacted");
  assert.doesNotMatch(runArchiveText, /sk-testsecret123456789/);
  assert.doesNotMatch(runArchiveText, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(runArchiveText, /opaque-credential-value/);
  assert.match(runArchiveText, /private@example\.com/);
  assert.match(runArchiveText, /outside workspace secret evidence/);
  assert.doesNotMatch(runArchiveText, /ANTHROPIC_API_KEY=sk-testcredential123456789/);
  const incidents = JSON.parse(runArchive.get("diagnostics/incidents.json")?.toString("utf8") ?? "[]") as Array<
    Record<string, any>
  >;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.incidentId, "OG-20260728-ABC123");
  assert.equal(incidents[0]?.facts?.upstreamRequestId, "req-diagnostic-bundle");
  const diagnosticSummary = JSON.parse(runArchive.get("diagnostics/summary.json")?.toString("utf8") ?? "{}") as Record<
    string,
    any
  >;
  assert.equal(diagnosticSummary.target?.runId, "run-diagnostic-target");
  assert.equal(diagnosticSummary.route?.targetMember?.providerId, undefined);
  assert.equal(diagnosticSummary.capture?.logicalModelRequests, 1);
  assert.equal(diagnosticSummary.capture?.wireRequestBodyCaptured, false);
  assert.equal(diagnosticSummary.capture?.wireResponseBodyCaptured, false);
  const runManifest = JSON.parse(runArchive.get("manifest.json")?.toString("utf8") ?? "{}") as Record<string, any>;
  assert.equal(runManifest.completeness?.silentlyTruncated, false);
  assert.equal(runManifest.scope?.runId, "run-diagnostic-target");
  assert.equal(runManifest.scope?.sessionId, "session-run-diagnostic");
  assert.equal(runManifest.scope?.roomId, "room-run-diagnostic");
  assert.equal(runManifest.credentials?.valueShapeCredentialRedactionApplied, true);
  assert.deepEqual(runManifest.credentials?.valueShapeCredentialRedactionScope, [
    "well-known-api-key",
    "jwt",
    "bearer-token",
    "credential-field-assignment",
    "environment-secret-assignment",
    "json-secret-field",
  ]);
  assert.equal(runManifest.credentials?.assignmentNameRedactionApplied, true);
  assert.equal(runManifest.credentials?.identityTextRedactionApplied, false);
  assert.equal(runManifest.completeness?.maximumUncompressedBytes, 128 * 1024 * 1024);
  assert.equal(
    runManifest.counts?.duplicateAgentEventsRemoved,
    1,
    "the exact duplicate must be removed without treating the target run eventCount mismatch as duplication",
  );
  const fileIndex = JSON.parse(runArchive.get("file-index.json")?.toString("utf8") ?? "{}") as {
    excluded?: Array<{ sourcePath?: string; reason?: string; metadataCaptured?: boolean }>;
  };
  assert.ok(fileIndex.excluded?.some((file) => file.reason === "credential-or-state-store"));
  assert.equal(
    fileIndex.excluded?.some((file) => file.reason === "outside-workspace-roots"),
    false,
  );
  assert.ok(
    fileIndex.excluded?.some(
      (file) =>
        file.sourcePath?.endsWith("/claude-runtime") &&
        file.reason === "runtime-executable-metadata-only" &&
        file.metadataCaptured === true,
    ),
  );
  assert.equal(runManifest.counts?.metadataOnlyFiles, 1);
  assert.equal(runManifest.completeness?.missingEvidence.length, 0);

  writeFileSync(oversizedWorkspaceFile, "", "utf8");
  truncateSync(oversizedWorkspaceFile, 129 * 1024 * 1024);
  const oversizedResponse = await fetch(runBundleUrl, { headers: { "x-opengrove-token": token } });
  assert.equal(oversizedResponse.status, 200, "an oversized optional evidence file must not block export");
  const oversizedArchive = readZipArchiveForTest(Buffer.from(await oversizedResponse.arrayBuffer()));
  const oversizedManifest = JSON.parse(oversizedArchive.get("manifest.json")?.toString("utf8") ?? "{}") as Record<
    string,
    any
  >;
  assert.equal(oversizedManifest.completeness?.evidenceComplete, false);
  assert.ok(
    (oversizedManifest.completeness?.missingEvidence as string[] | undefined)?.some((item) =>
      item.startsWith("evidence-size-limit:"),
    ),
  );
  rmSync(oversizedWorkspaceFile);

  rmSync(join(transcriptDir, `${nativeSessionId}.jsonl`));
  const missingTranscriptResponse = await fetch(runBundleUrl, { headers: { "x-opengrove-token": token } });
  assert.equal(
    missingTranscriptResponse.status,
    200,
    "a missing native transcript must not block the rest of the evidence",
  );
  const missingTranscriptArchive = readZipArchiveForTest(Buffer.from(await missingTranscriptResponse.arrayBuffer()));
  const missingTranscriptManifest = JSON.parse(
    missingTranscriptArchive.get("manifest.json")?.toString("utf8") ?? "{}",
  ) as Record<string, any>;
  assert.equal(missingTranscriptManifest.completeness?.evidenceComplete, false);
  assert.deepEqual(missingTranscriptManifest.completeness?.missingNativeTranscripts, [
    {
      provider: "claude-code",
      sessionId: nativeSessionId,
    },
  ]);

  const incompleteResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/diagnostics/run-bundle?roomId=room-unrelated&messageId=message-unrelated`,
    { headers: { "x-opengrove-token": token } },
  );
  assert.equal(
    incompleteResponse.status,
    200,
    "an incomplete retained event chain must export the evidence that remains",
  );
  const incompleteArchive = readZipArchiveForTest(Buffer.from(await incompleteResponse.arrayBuffer()));
  const incompleteManifest = JSON.parse(incompleteArchive.get("manifest.json")?.toString("utf8") ?? "{}") as Record<
    string,
    any
  >;
  assert.equal(incompleteManifest.completeness?.evidenceComplete, false);
  assert.ok(
    (incompleteManifest.completeness?.missingEvidence as string[] | undefined)?.includes("event-count:run-unrelated"),
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (previousDiagnosticsDir === undefined) delete process.env.OPENGROVE_DIAGNOSTICS_DIR;
  else process.env.OPENGROVE_DIAGNOSTICS_DIR = previousDiagnosticsDir;
  rmSync(root, { recursive: true, force: true });
}

console.log("Diagnostic bundle server harness passed.");
