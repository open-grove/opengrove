import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform, arch, release } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEvent, JsonValue } from "../core.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import type { BridgeState } from "../server/bridge-types.js";
import { readClientReleaseNumber, readInstalledPackageVersion, readPackageVersion } from "../server/client-release.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { problemRecordsRoot } from "../server/problem-records.js";
import { bridgeDataDirectory } from "../server/storage-paths.js";
import type { AgentDiagnosticArchive } from "../storage/json-state-store.js";
import {
  DIAGNOSTIC_CREDENTIAL_FILE_NAMES,
  DIAGNOSTIC_SYSTEM_LOG_FILE_NAMES,
  diagnosticFileUrlToPath,
  isDiagnosticCredentialPath,
  isRuntimeExecutableFile,
} from "./evidence-files.js";
import { redactDiagnosticCredentialValues } from "./redaction.js";
import { createZipArchiveAsync, type ZipEntry } from "./zip.js";

export interface RunDiagnosticBundleResult {
  archive: Buffer;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  evidenceComplete: boolean;
}

export class RunDiagnosticBundleError extends Error {
  constructor(
    readonly code:
      | "run_diagnostic_room_not_found"
      | "run_diagnostic_message_not_found"
      | "run_diagnostic_message_has_no_run"
      | "run_diagnostic_run_not_found"
      | "run_diagnostic_session_not_found"
      | "run_diagnostic_bundle_too_large",
    readonly status: number,
    message: string = code,
  ) {
    super(message);
    this.name = "RunDiagnosticBundleError";
  }
}

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const APP_RUNTIME_ROOT_FILES = new Set([
  "opengrove.app.json",
  "opengrove.app.jsonc",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
]);
const APP_RUNTIME_ROOT_DIRS = new Set(["skills", "bin", "commands", "hooks", "mcp"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", "workspace"]);

class RunDiagnosticBundleBudget {
  bytes = 0;
  files = 0;

  reserve(sizeBytes: number): void {
    this.ensureCanReserve(sizeBytes);
    this.bytes += sizeBytes;
    this.files += 1;
  }

  ensureCanReserve(sizeBytes: number): void {
    if (!this.canReserve(sizeBytes)) {
      throw new RunDiagnosticBundleError("run_diagnostic_bundle_too_large", 413);
    }
  }

  canReserve(sizeBytes: number): boolean {
    return this.bytes + sizeBytes <= MAX_INPUT_BYTES && this.files + 1 <= MAX_FILES;
  }
}

interface ArchiveEvidenceEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface IndexedEvidenceFile {
  archivePath: string;
  sourcePath: string;
  sizeBytes: number;
  kind: string;
  sha256: string;
}

interface ExcludedEvidenceFile {
  sourcePath: string;
  reason: string;
  sizeBytes?: number;
  modifiedAt?: string;
  mode?: number;
  metadataCaptured?: boolean;
}

export async function createRunDiagnosticBundle(options: {
  state: BridgeState;
  roomId: string;
  messageId: string;
  secrets?: string[];
  now?: Date;
}): Promise<RunDiagnosticBundleResult> {
  const generatedAt = options.now ?? new Date();
  const secrets = (options.secrets ?? []).map((secret) => secret.trim()).filter(Boolean);
  const snapshot = options.state.app.rooms.snapshot();
  const room = options.state.app.rooms.getRoom(options.roomId);
  if (!room) throw new RunDiagnosticBundleError("run_diagnostic_room_not_found", 404);
  const message = options.state.app.rooms.getMessage(options.roomId, options.messageId);
  if (!message) throw new RunDiagnosticBundleError("run_diagnostic_message_not_found", 404);
  if (!message.runId) throw new RunDiagnosticBundleError("run_diagnostic_message_has_no_run", 409);

  const targetRun = options.state.app.sessions.getRun(message.runId);
  if (!targetRun) throw new RunDiagnosticBundleError("run_diagnostic_run_not_found", 409);
  const session = options.state.app.sessions.get(targetRun.sessionId);
  if (!session) throw new RunDiagnosticBundleError("run_diagnostic_session_not_found", 409);

  const runs = options.state.app.sessions.listRuns({ sessionId: session.id });
  const runIds = new Set(runs.map((run) => run.id));
  const retainedEvents = options.state.app.events.list((event) => runIds.has(event.runId));
  const retainedExecutions = options.state.app.executions.list({ sessionId: session.id });
  const retainedRoomEvents = snapshot.events.filter((event) => event.roomId === room.id);
  let durableArchive: AgentDiagnosticArchive | undefined;
  let durableArchiveReadFailed = false;
  try {
    durableArchive = options.state.store.readDiagnosticArchive?.({
      runIds: [...runIds],
      roomId: room.id,
    });
  } catch {
    durableArchiveReadFailed = true;
  }
  const normalizedArchive = durableArchive
    ? normalizeArchivedEvents(
        durableArchive.events,
        runs.map((run) => ({ id: run.id, eventCount: run.eventCount })),
      )
    : { events: [] as AgentEvent[], duplicatesRemoved: 0 };
  const events = durableArchive ? mergeRetainedTail(normalizedArchive.events, retainedEvents) : retainedEvents;
  const eventCountsByRun = new Map<string, number>();
  for (const event of events) eventCountsByRun.set(event.runId, (eventCountsByRun.get(event.runId) ?? 0) + 1);
  const incompleteRuns = runs.filter((run) => run.eventCount > (eventCountsByRun.get(run.id) ?? 0));

  const executions = durableArchive
    ? mergeRecordsByKey(durableArchive.executions, retainedExecutions, (record) => record.id)
    : retainedExecutions;
  const roomMessages = snapshot.messages.filter((candidate) => candidate.roomId === room.id);
  const roomEvents = durableArchive
    ? mergeRecordsByKey(durableArchive.roomEvents, retainedRoomEvents, (event) => String(event.eventSeq))
    : retainedRoomEvents;
  const roomMembers = snapshot.members.filter((member) => room.memberIds.includes(member.id));
  const approvalIds = new Set(runs.flatMap((run) => run.approvalIds));
  const questionIds = new Set(runs.flatMap((run) => run.questionIds));
  const approvals = options.state.app.approvals.list().filter((request) => approvalIds.has(request.id));
  const questions = options.state.app.questions.list().filter((request) => questionIds.has(request.id));
  const artifacts = options.state.app.artifacts.list().filter((artifact) => containsAnyRunId(artifact, runIds));
  const memory = options.state.app.memory.list().filter((record) => containsAnyRunId(record, runIds));

  const entries: ZipEntry[] = [];
  const evidenceEntries: ArchiveEvidenceEntry[] = [];
  const includedFiles: IndexedEvidenceFile[] = [];
  const excludedFiles: ExcludedEvidenceFile[] = [];
  const missingNativeTranscripts: Array<{ provider: string; sessionId: string }> = [];
  const seenArchivePaths = new Set<string>();
  const seenSourceFiles = new Set<string>();
  const budget = new RunDiagnosticBundleBudget();

  const appendEntry = (entry: ZipEntry, sha256?: string) =>
    addEntry(entries, seenArchivePaths, budget, evidenceEntries, entry, sha256);
  const addJson = (name: string, value: unknown) =>
    appendEntry({
      name,
      data: redactKnownSecrets(`${JSON.stringify(value, null, 2)}\n`, secrets),
      modifiedAt: generatedAt,
    });
  appendEntry({
    name: "README.txt",
    data: [
      "OpenGrove 运行错误包（完整取证模式）",
      "",
      "本包由某条员工回复导出，用于排查错误输出、上下文串线、原生 Session 恢复和工具调用问题。",
      "它包含该 OpenGrove Session 的完整运行事件、模型请求、房间上下文、执行记录、可找到的原生 transcript、相关本地文件与桌面日志。",
      "缺失或超限的辅助证据会明确写入 manifest.json 和 file-index.json；已收集的核心运行证据仍会正常导出。",
      "超过取证上限的 Kernel 可执行文件只记录路径、大小、时间和权限元数据，不会把数百 MB 的二进制本体塞进包里，也不算核心证据缺失。",
      "本包采用证据优先策略：源码、日志、错误原文、邮箱和本机路径不做基于变量名或身份信息的模糊改写。",
      "文本证据中的常见 API Key、JWT 和 Bearer Token 会按值形状脱敏；Bridge 已知的可复用密钥值会做精确替换。",
      "明确的凭证存储（例如 auth.json、.env、bridge-settings.json 和整个状态库）不会打包。",
      "结构化房间与运行记录只包含目标 Session；桌面日志和问题日志是全局诊断文件，可能含有其他运行的系统级上下文。",
      "包内可能包含敏感业务内容，仅应交给可信的排障人员；对外分享前请自行检查。",
      "",
    ].join("\n"),
    modifiedAt: generatedAt,
  });
  addJson("room/room.json", room);
  addJson("room/messages.json", roomMessages);
  addJson("room/events.json", roomEvents);
  addJson("room/members.json", roomMembers);
  addJson("session/session.json", session);
  addJson("session/runs.json", runs);
  appendEntry({
    name: "session/events.jsonl",
    data: redactKnownSecrets(
      events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
      secrets,
    ),
    modifiedAt: generatedAt,
  });
  addJson("session/executions.json", executions);
  addJson("session/approvals.json", approvals);
  addJson("session/questions.json", questions);
  addJson("session/artifacts.json", artifacts);
  addJson("session/memory.json", memory);
  if (options.state.app.workingState.get().sessionId === session.id) {
    addJson("session/working-state.json", options.state.app.workingState.get());
  }

  const seenAppIds = new Set<string>();
  for (const member of roomMembers) {
    if (!member.appId || seenAppIds.has(member.appId)) continue;
    seenAppIds.add(member.appId);
    const mountedFiles: Array<{ sourcePath: string; appRoot: string }> = [];
    const mountedAppFound = collectMountedAppFiles(options.state, member, (sourcePath, appRoot) => {
      mountedFiles.push({ sourcePath, appRoot });
    });
    if (!mountedAppFound) {
      excludedFiles.push({ sourcePath: `app:${member.appId}`, reason: "mounted-app-unavailable" });
      continue;
    }
    for (const { sourcePath, appRoot } of mountedFiles) {
      const archivePath = `app/${safeSegment(member.appId)}/${relative(appRoot, sourcePath).replaceAll("\\", "/")}`;
      await addSourceFile({
        sourcePath,
        kind: "mounted-app-runtime",
        archivePath,
        entries,
        includedFiles,
        excludedFiles,
        seenArchivePaths,
        seenSourceFiles,
        evidenceEntries,
        budget,
        generatedAt,
        secrets,
      });
    }
  }

  const workspaceRoots = roomMembers
    .map((member) => member.workspaceRoot)
    .filter((path): path is string => Boolean(path));
  const referencedPaths = collectReferencedPaths([...events, ...executions, ...roomMessages], workspaceRoots);
  excludedFiles.push(...referencedPaths.excluded);
  for (const sourcePath of referencedPaths.included) {
    await addSourceFile({
      sourcePath,
      kind: "referenced-run-file",
      archiveRoot: "files/referenced",
      entries,
      includedFiles,
      excludedFiles,
      seenArchivePaths,
      seenSourceFiles,
      evidenceEntries,
      budget,
      generatedAt,
      secrets,
    });
  }

  const nativeSessions = collectNativeSessionRefs(events, session.metadata);
  const transcriptSearchCache = new Map<string, string[]>();
  for (const nativeSession of nativeSessions) {
    const transcriptFiles = findNativeTranscriptFiles(
      nativeSession.provider,
      nativeSession.sessionId,
      transcriptSearchCache,
    );
    if (
      (nativeSession.provider === "claude-code" || nativeSession.provider === "codex") &&
      transcriptFiles.length === 0
    ) {
      missingNativeTranscripts.push(nativeSession);
      excludedFiles.push({
        sourcePath: `${nativeSession.provider}:${nativeSession.sessionId}`,
        reason: "native-transcript-missing",
      });
    }
    for (const sourcePath of transcriptFiles) {
      const extension = extname(sourcePath) || ".jsonl";
      const baseArchivePath =
        nativeSession.provider === "claude-code"
          ? `native/claude-transcripts/${safeSegment(nativeSession.sessionId)}${extension}`
          : `native/${safeSegment(nativeSession.provider)}-transcripts/${safeSegment(nativeSession.sessionId)}${extension}`;
      await addSourceFile({
        sourcePath,
        kind: `${nativeSession.provider}-native-transcript`,
        archivePath: baseArchivePath,
        entries,
        includedFiles,
        excludedFiles,
        seenArchivePaths,
        seenSourceFiles,
        evidenceEntries,
        budget,
        generatedAt,
        secrets,
      });
    }
  }

  for (const sourcePath of collectDesktopLogFiles(options.state)) {
    await addSourceFile({
      sourcePath,
      kind: "desktop-log",
      archivePath: `logs/${basename(sourcePath)}`,
      entries,
      includedFiles,
      excludedFiles,
      seenArchivePaths,
      seenSourceFiles,
      evidenceEntries,
      budget,
      generatedAt,
      secrets,
    });
  }
  const problemLogFiles = collectProblemLogFiles(options.state);
  const incidentIds = new Set(runs.flatMap((run) => (run.problem ? [run.problem.incidentId] : [])));
  const scopedProblemRecords = await collectScopedProblemRecords({
    paths: problemLogFiles,
    runIds,
    incidentIds,
    roomId: room.id,
  });
  for (const sourcePath of problemLogFiles) {
    await addSourceFile({
      sourcePath,
      kind: "problem-log",
      archivePath: `diagnostics/${basename(sourcePath)}`,
      entries,
      includedFiles,
      excludedFiles,
      seenArchivePaths,
      seenSourceFiles,
      evidenceEntries,
      budget,
      generatedAt,
      secrets,
    });
  }
  addJson("diagnostics/incidents.json", scopedProblemRecords);
  addJson(
    "diagnostics/summary.json",
    buildRunDiagnosticSummary({
      roomId: room.id,
      messageId: message.id,
      targetRun,
      runs,
      targetMember: roomMembers.find((member) => member.id === message.senderId),
      roomMembers,
      events,
      scopedProblemRecords,
    }),
  );

  const missingArchiveRecords = durableArchive?.missingRecords ?? [];
  const foundIncidentIds = new Set(
    scopedProblemRecords.flatMap((record) => (typeof record.incidentId === "string" ? [record.incidentId] : [])),
  );
  const missingProblemRecords = [...incidentIds].filter((incidentId) => !foundIncidentIds.has(incidentId));
  const metadataOnlyEvidence = excludedFiles.filter((file) => file.metadataCaptured === true);
  const missingEvidence = [
    ...incompleteRuns.map((run) => `event-count:${run.id}`),
    ...missingArchiveRecords.map((record) => `${record.collection}:${record.recordKey}:${record.reason}`),
    ...missingNativeTranscripts.map((item) => `native-transcript:${item.provider}:${item.sessionId}`),
    ...missingProblemRecords.map((incidentId) => `problem-record:${incidentId}`),
    ...(durableArchiveReadFailed ? ["durable-archive-read-failed"] : []),
    ...excludedFiles
      .filter(
        (file) =>
          file.reason !== "credential-or-state-store" &&
          file.reason !== "native-transcript-missing" &&
          file.metadataCaptured !== true,
      )
      .map((file) => `${file.reason}:${file.sourcePath}`),
  ].filter((value, index, values) => values.indexOf(value) === index);
  addJson("file-index.json", { included: includedFiles, excluded: excludedFiles });
  addJson("manifest.json", {
    formatVersion: 2,
    kind: "opengrove-run-forensic-bundle",
    generatedAt: generatedAt.toISOString(),
    product: "OpenGrove",
    scope: {
      roomId: room.id,
      messageId: message.id,
      runId: targetRun.id,
      sessionId: session.id,
      sessionRunIds: runs.map((run) => run.id),
    },
    versions: {
      app: readPackageVersion() ?? "unknown",
      clientReleaseNumber: readClientReleaseNumber() ?? undefined,
      claudeAgentSdk: readInstalledPackageVersion("@anthropic-ai/claude-agent-sdk") ?? undefined,
      node: process.versions.node,
    },
    system: { platform: platform(), arch: arch(), release: release() },
    counts: {
      roomMessages: roomMessages.length,
      roomEvents: roomEvents.length,
      sessionRuns: runs.length,
      agentEvents: events.length,
      executions: executions.length,
      nativeSessions: nativeSessions.length,
      duplicateAgentEventsRemoved: normalizedArchive.duplicatesRemoved,
      missingArchiveRecords: missingArchiveRecords.length,
      missingNativeTranscripts: missingNativeTranscripts.length,
      scopedProblemRecords: scopedProblemRecords.length,
      missingProblemRecords: missingProblemRecords.length,
      metadataOnlyFiles: metadataOnlyEvidence.length,
      includedFiles: includedFiles.length,
      excludedFiles: excludedFiles.length,
      excludedCredentialFiles: excludedFiles.filter((file) => file.reason === "credential-or-state-store").length,
    },
    completeness: {
      evidenceComplete: missingEvidence.length === 0,
      silentlyTruncated: false,
      eventCountValidated: incompleteRuns.length === 0,
      eventSource: durableArchive?.source ?? "in-memory",
      maximumUncompressedBytes: MAX_INPUT_BYTES,
      failurePolicy: "export-available-evidence-and-report-missing-items",
      missingEvidence,
      missingArchiveRecords,
      missingNativeTranscripts,
      missingProblemRecords,
      metadataOnlyEvidence,
    },
    credentials: {
      evidencePolicy: "preserve-original-content-except-credential-values",
      valueShapeCredentialRedactionApplied: true,
      valueShapeCredentialRedactionScope: [
        "well-known-api-key",
        "jwt",
        "bearer-token",
        "credential-field-assignment",
        "environment-secret-assignment",
        "json-secret-field",
      ],
      assignmentNameRedactionApplied: true,
      identityTextRedactionApplied: false,
      exactKnownSecretRedactionApplied: true,
      credentialFilesIncluded: false,
      unstructuredEvidenceMayContainSensitiveContent: true,
      excludedFileNames: [...DIAGNOSTIC_CREDENTIAL_FILE_NAMES].sort(),
    },
    evidenceEntries,
  });

  const archive = await createZipArchiveAsync(entries);
  if (archive.length > MAX_INPUT_BYTES) {
    throw new RunDiagnosticBundleError("run_diagnostic_bundle_too_large", 413);
  }
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return {
    archive,
    fileName: `OpenGrove-run-${safeSegment(targetRun.id)}-${generatedAt.toISOString().replace(/[:.]/g, "-")}.zip`,
    sizeBytes: archive.length,
    sha256,
    evidenceComplete: missingEvidence.length === 0,
  };
}

function addEntry(
  entries: ZipEntry[],
  seen: Set<string>,
  budget: RunDiagnosticBundleBudget,
  evidenceEntries: ArchiveEvidenceEntry[],
  entry: ZipEntry,
  sha256?: string,
): ArchiveEvidenceEntry {
  const entryHash = sha256 ?? createHash("sha256").update(entry.data).digest("hex");
  const archivePath = uniqueArchivePath(entry.name, `archive-entry:${entryHash}`, seen);
  const storedEntry = archivePath === entry.name ? entry : { ...entry, name: archivePath };
  budget.reserve(entrySize(storedEntry));
  seen.add(archivePath);
  entries.push(storedEntry);
  const evidence = {
    path: archivePath,
    sizeBytes: entrySize(storedEntry),
    sha256: entryHash,
  };
  evidenceEntries.push(evidence);
  return evidence;
}

function entrySize(entry: ZipEntry): number {
  return Buffer.isBuffer(entry.data) ? entry.data.length : Buffer.byteLength(entry.data);
}

async function addSourceFile(options: {
  sourcePath: string;
  kind: string;
  archivePath?: string;
  archiveRoot?: string;
  entries: ZipEntry[];
  includedFiles: Array<{ archivePath: string; sourcePath: string; sizeBytes: number; kind: string; sha256: string }>;
  excludedFiles: ExcludedEvidenceFile[];
  seenArchivePaths: Set<string>;
  seenSourceFiles: Set<string>;
  evidenceEntries: ArchiveEvidenceEntry[];
  budget: RunDiagnosticBundleBudget;
  generatedAt: Date;
  secrets: string[];
}): Promise<void> {
  let sourcePath: string;
  let sourceStat: Stats;
  try {
    sourcePath = realpathSync(options.sourcePath);
    sourceStat = statSync(sourcePath);
  } catch (error) {
    options.excludedFiles.push({
      sourcePath: options.sourcePath,
      reason: `evidence-unreadable-${fsErrorCode(error)}`,
    });
    return;
  }
  if (!sourceStat.isFile()) {
    options.excludedFiles.push({ sourcePath, reason: "evidence-not-file" });
    return;
  }
  if (options.seenSourceFiles.has(sourcePath)) return;
  if (isDiagnosticCredentialPath(sourcePath)) {
    options.excludedFiles.push({ sourcePath, reason: "credential-or-state-store" });
    return;
  }
  if (!options.budget.canReserve(sourceStat.size)) {
    options.excludedFiles.push(
      isRuntimeExecutableFile(sourcePath, sourceStat.mode)
        ? {
            sourcePath,
            reason: "runtime-executable-metadata-only",
            sizeBytes: sourceStat.size,
            modifiedAt: sourceStat.mtime.toISOString(),
            mode: sourceStat.mode,
            metadataCaptured: true,
          }
        : { sourcePath, reason: "evidence-size-limit" },
    );
    return;
  }
  let rawData: Buffer;
  try {
    rawData = await readFile(sourcePath);
  } catch (error) {
    options.excludedFiles.push({
      sourcePath,
      reason: `evidence-read-failed-${fsErrorCode(error)}`,
    });
    return;
  }
  const data = redactKnownSecretsInFile(rawData, sourcePath, options.secrets);
  const hash = createHash("sha256").update(data).digest("hex");
  const desiredArchivePath =
    options.archivePath ??
    `${options.archiveRoot ?? "files"}/${hash.slice(0, 12)}-${safeSegment(basename(sourcePath))}`;
  if (!options.budget.canReserve(data.length)) {
    options.excludedFiles.push({ sourcePath, reason: "evidence-size-limit" });
    return;
  }
  const archivePath = uniqueArchivePath(desiredArchivePath, sourcePath, options.seenArchivePaths);
  const evidence = addEntry(
    options.entries,
    options.seenArchivePaths,
    options.budget,
    options.evidenceEntries,
    {
      name: archivePath,
      data,
      modifiedAt: options.generatedAt,
    },
    hash,
  );
  options.seenSourceFiles.add(sourcePath);
  options.includedFiles.push({
    archivePath: evidence.path,
    sourcePath,
    sizeBytes: data.length,
    kind: options.kind,
    sha256: hash,
  });
}

function fsErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? safeSegment(code) : "unknown";
}

function collectReferencedPaths(
  values: unknown[],
  roots: string[],
): {
  included: string[];
  excluded: Array<{ sourcePath: string; reason: string }>;
} {
  const candidates = new Set<string>();
  const excluded = new Map<string, { sourcePath: string; reason: string }>();
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (depth > 30 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const pathLikeKey =
        /(?:^|_)(?:path|paths|file|files|cwd|root|uri)$/i.test(key) || /(?:Path|File|Cwd|Root|Uri)$/.test(key);
      if (!pathLikeKey && !isAbsolute(value)) return;
      for (const candidate of resolvePathCandidates(value, roots)) {
        if (!isRegularFile(candidate)) continue;
        let realPath: string;
        try {
          realPath = realpathSync(candidate);
        } catch (error) {
          excluded.set(candidate, { sourcePath: candidate, reason: `evidence-unreadable-${fsErrorCode(error)}` });
          continue;
        }
        if (isDiagnosticCredentialPath(realPath)) {
          excluded.set(realPath, { sourcePath: realPath, reason: "credential-or-state-store" });
          continue;
        }
        candidates.add(realPath);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, childKey, depth + 1);
      }
    }
  };
  for (const value of values) visit(value);
  return {
    included: [...candidates].sort(),
    excluded: [...excluded.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
  };
}

function resolvePathCandidates(value: string, roots: string[]): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:"))
    return [];
  if (trimmed.startsWith("file://")) {
    try {
      return [diagnosticFileUrlToPath(trimmed)];
    } catch {
      return [];
    }
  }
  if (isAbsolute(trimmed)) return [resolve(trimmed)];
  return roots.map((root) => resolve(root, trimmed));
}

function collectMountedAppFiles(
  state: BridgeState,
  member: RoomChannelMember,
  onFile: (sourcePath: string, appRoot: string) => void,
): boolean {
  if (!member.appId) return false;
  const target = resolveMountedAppTarget(state, member.appId);
  if (!target) return false;
  for (const fileName of APP_RUNTIME_ROOT_FILES) {
    const path = join(target.appRoot, fileName);
    if (isRegularFile(path)) onFile(path, target.appRoot);
  }
  for (const directory of APP_RUNTIME_ROOT_DIRS) {
    walkFiles(join(target.appRoot, directory), (path) => onFile(path, target.appRoot));
  }
  return true;
}

function collectNativeSessionRefs(
  events: AgentEvent[],
  metadata: JsonValue | undefined,
): Array<{ provider: string; sessionId: string }> {
  const refs = new Map<string, { provider: string; sessionId: string }>();
  for (const event of events) {
    if (event.type !== "model.requested" || !event.request.session) continue;
    const provider = event.request.session.provider.trim() || "unknown";
    const sessionId = (event.request.session.nativeSessionId || event.request.session.sessionId).trim();
    if (sessionId) refs.set(`${provider}:${sessionId}`, { provider, sessionId });
  }
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const [key, value] of Object.entries(metadata)) {
      if (!/claude.*session/i.test(key)) continue;
      collectStringLeaves(value, (sessionId) => {
        refs.set(`claude-code:${sessionId}`, { provider: "claude-code", sessionId });
      });
    }
  }
  return [...refs.values()];
}

function findNativeTranscriptFiles(provider: string, sessionId: string, searchCache: Map<string, string[]>): string[] {
  const roots =
    provider === "claude-code"
      ? [process.env.CLAUDE_CONFIG_DIR?.trim(), join(homedir(), ".claude")]
      : provider === "codex"
        ? [process.env.CODEX_HOME?.trim(), join(homedir(), ".codex")]
        : [];
  const found = new Set<string>();
  for (const root of roots.filter((value): value is string => Boolean(value))) {
    const searchRoot = provider === "claude-code" ? join(root, "projects") : join(root, "sessions");
    const cacheKey = `${provider}:${searchRoot}`;
    let files = searchCache.get(cacheKey);
    if (!files) {
      files = [];
      walkFiles(searchRoot, (path) => {
        if (path.endsWith(".jsonl")) files?.push(path);
      });
      searchCache.set(cacheKey, files);
    }
    for (const path of files) {
      const name = basename(path);
      if (
        provider === "claude-code" ? name === `${sessionId}.jsonl` : name.includes(sessionId) && name.endsWith(".jsonl")
      ) {
        found.add(path);
      }
    }
  }
  return [...found].sort();
}

function collectDesktopLogFiles(state: BridgeState): string[] {
  const dataDir = bridgeDataDirectory(state);
  const roots = [join(dataDir, "logs"), join(dirname(dataDir), "logs")];
  return roots
    .flatMap((root) => DIAGNOSTIC_SYSTEM_LOG_FILE_NAMES.map((name) => join(root, name)))
    .filter(isRegularFile);
}

function collectProblemLogFiles(state: BridgeState): string[] {
  const root = problemRecordsRoot(state);
  return [join(root, "problems.jsonl.1"), join(root, "problems.jsonl")].filter(isRegularFile);
}

async function collectScopedProblemRecords(options: {
  paths: string[];
  runIds: Set<string>;
  incidentIds: Set<string>;
  roomId: string;
}): Promise<Array<Record<string, unknown>>> {
  const records = new Map<string, Record<string, unknown>>();
  for (const path of options.paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      // non-critical-fallback: Skip a problem log that disappears or becomes unreadable while diagnostic evidence is collected.
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // non-critical-fallback: Skip a malformed JSONL entry while preserving every other valid problem record in the bundle.
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const context =
        record.context && typeof record.context === "object" && !Array.isArray(record.context)
          ? (record.context as Record<string, unknown>)
          : undefined;
      const belongsToScope =
        (typeof record.runId === "string" && options.runIds.has(record.runId)) ||
        (typeof record.incidentId === "string" && options.incidentIds.has(record.incidentId)) ||
        context?.roomId === options.roomId;
      if (belongsToScope) records.set(stableRecordKey(record), record);
    }
  }
  return [...records.values()];
}

function buildRunDiagnosticSummary(input: {
  roomId: string;
  messageId: string;
  targetRun: {
    id: string;
    sessionId: string;
    status: string;
    error?: string;
    problem?: { incidentId: string; code: string };
  };
  runs: Array<{
    id: string;
    status: string;
    modelId?: string;
    error?: string;
    problem?: { incidentId: string; code: string };
    startedAt: string;
    endedAt?: string;
    eventCount: number;
  }>;
  targetMember?: RoomChannelMember;
  roomMembers: RoomChannelMember[];
  events: AgentEvent[];
  scopedProblemRecords: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const modelRequests = input.events.filter(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  const runtimeDiagnostics = input.events.filter(
    (event): event is Extract<AgentEvent, { type: "runtime.diagnostic" }> => event.type === "runtime.diagnostic",
  );
  const errors = input.events.filter(
    (event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error",
  );
  const wireRequestEvents = runtimeDiagnostics.filter((event) => /(?:^|\.)wire_request$/i.test(event.name));
  const wireResponseEvents = runtimeDiagnostics.filter((event) => /(?:^|\.)wire_response$/i.test(event.name));
  const upstreamRequestIds = new Set<string>();
  for (const error of errors) {
    if (error.diagnostics?.upstreamRequestId) upstreamRequestIds.add(error.diagnostics.upstreamRequestId);
  }
  for (const event of runtimeDiagnostics) {
    for (const key of ["upstreamRequestId", "requestId", "request_id"] as const) {
      const value = event.data[key];
      if (typeof value === "string" && value.trim()) upstreamRequestIds.add(value.trim());
    }
  }
  for (const record of input.scopedProblemRecords) {
    const facts =
      record.facts && typeof record.facts === "object" && !Array.isArray(record.facts)
        ? (record.facts as Record<string, unknown>)
        : undefined;
    if (typeof facts?.upstreamRequestId === "string") upstreamRequestIds.add(facts.upstreamRequestId);
  }
  const summarizeMember = (member: RoomChannelMember) => ({
    id: member.id,
    employeeDefinitionId: member.employeeDefinitionId,
    name: member.name,
    kernel: member.kernel,
    model: member.model,
    providerId: member.providerId,
    appId: member.appId,
    workspaceRoot: member.workspaceRoot,
    accessMode: member.accessMode,
    reasoningEffort: member.reasoningEffort,
    contextTokenBudget: member.contextTokenBudget,
  });
  return {
    schemaVersion: 1,
    target: {
      roomId: input.roomId,
      messageId: input.messageId,
      runId: input.targetRun.id,
      sessionId: input.targetRun.sessionId,
      status: input.targetRun.status,
      error: input.targetRun.error,
      problem: input.targetRun.problem,
    },
    route: {
      targetMember: input.targetMember ? summarizeMember(input.targetMember) : undefined,
      roomMembers: input.roomMembers.map(summarizeMember),
    },
    runs: input.runs.map((run) => ({
      id: run.id,
      status: run.status,
      modelId: run.modelId,
      error: run.error,
      problem: run.problem,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      eventCount: run.eventCount,
    })),
    capture: {
      logicalModelRequests: modelRequests.length,
      runtimeDiagnosticEvents: runtimeDiagnostics.length,
      errorEvents: errors.length,
      scopedProblemRecords: input.scopedProblemRecords.length,
      upstreamRequestIds: [...upstreamRequestIds],
      wireRequestBodyCaptured: wireRequestEvents.length > 0,
      wireResponseBodyCaptured: wireResponseEvents.length > 0,
      limitation:
        wireRequestEvents.length > 0 && wireResponseEvents.length > 0
          ? undefined
          : "当前 Kernel/SDK 未向 Host 暴露完整线上请求体或响应体；下列逻辑请求、运行时诊断、错误事件和关联 ID 是当前可取得的原始证据。",
    },
    modelRequests,
    runtimeDiagnostics,
    errors,
    incidents: input.scopedProblemRecords,
  };
}

function walkFiles(root: string, onFile: (path: string) => void): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkFiles(path, onFile);
    } else if (entry.isFile()) {
      onFile(path);
    }
  }
}

function uniqueArchivePath(basePath: string, sourcePath: string, seen: Set<string>): string {
  if (!seen.has(basePath)) return basePath;
  const extension = extname(basePath);
  const stem = extension ? basePath.slice(0, -extension.length) : basePath;
  const suffix = createHash("sha256").update(sourcePath).digest("hex").slice(0, 10);
  let candidate = `${stem}-${suffix}${extension}`;
  for (let index = 2; seen.has(candidate); index += 1) {
    candidate = `${stem}-${suffix}-${index}${extension}`;
  }
  return candidate;
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}

const RUN_REFERENCE_FIELDS = new Set(["locator", "path", "source", "uri"]);

function containsAnyRunId(value: unknown, runIds: Set<string>, field?: string): boolean {
  if (typeof value === "string") {
    return (
      runIds.has(value) || Boolean(field && RUN_REFERENCE_FIELDS.has(field) && containsRunIdReference(value, runIds))
    );
  }
  if (Array.isArray(value)) return value.some((item) => containsAnyRunId(item, runIds, field));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => runIds.has(key) || containsRunIdReference(key, runIds) || containsAnyRunId(item, runIds, key),
  );
}

function containsRunIdReference(value: string, runIds: Set<string>): boolean {
  for (const runId of runIds) {
    let offset = value.indexOf(runId);
    while (offset >= 0) {
      const before = offset > 0 ? value[offset - 1] : undefined;
      const afterIndex = offset + runId.length;
      const after = afterIndex < value.length ? value[afterIndex] : undefined;
      if (!isRunIdCharacter(before) && !isRunIdCharacter(after)) return true;
      offset = value.indexOf(runId, offset + 1);
    }
  }
  return false;
}

function isRunIdCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-zA-Z0-9._-]/.test(value);
}

function collectStringLeaves(value: unknown, onValue: (value: string) => void): void {
  if (typeof value === "string" && value.trim()) {
    onValue(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, onValue);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringLeaves(item, onValue);
  }
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 120) || "unknown";
}

function mergeRetainedTail<T>(archive: T[], retained: T[]): T[] {
  if (archive.length === 0) return [...retained];
  if (retained.length === 0) return [...archive];
  const archivedOccurrences = new Map<string, number>();
  for (const value of archive) {
    const key = stableRecordKey(value);
    archivedOccurrences.set(key, (archivedOccurrences.get(key) ?? 0) + 1);
  }
  const retainedOccurrences = new Map<string, number>();
  const appended = retained.filter((value) => {
    const key = stableRecordKey(value);
    const occurrence = (retainedOccurrences.get(key) ?? 0) + 1;
    retainedOccurrences.set(key, occurrence);
    return occurrence > (archivedOccurrences.get(key) ?? 0);
  });
  return [...archive, ...appended];
}

function mergeRecordsByKey<T>(archive: T[], retained: T[], keyFor: (value: T) => string): T[] {
  const merged = new Map(archive.map((value) => [keyFor(value), value]));
  for (const value of retained) merged.set(keyFor(value), value);
  return [...merged.values()];
}

function stableRecordKey(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function normalizeArchivedEvents(
  events: AgentEvent[],
  runs: Array<{ id: string; eventCount: number }>,
): { events: AgentEvent[]; duplicatesRemoved: number } {
  const expectedByRun = new Map(runs.map((run) => [run.id, run.eventCount]));
  const indexesByRun = new Map<string, number[]>();
  for (let index = 0; index < events.length; index += 1) {
    const runId = events[index]?.runId;
    if (!runId) continue;
    const indexes = indexesByRun.get(runId) ?? [];
    indexes.push(index);
    indexesByRun.set(runId, indexes);
  }
  const keep = new Set<number>();
  let duplicatesRemoved = 0;
  for (const [runId, indexes] of indexesByRun) {
    const expected = expectedByRun.get(runId);
    const retained =
      expected !== undefined &&
      expected > 0 &&
      indexes.length > expected &&
      indexes.length % expected === 0 &&
      repeatedEventCopiesMatch(events, indexes, expected)
        ? indexes.slice(0, expected)
        : indexes;
    duplicatesRemoved += indexes.length - retained.length;
    for (const index of retained) keep.add(index);
  }
  return {
    events: events.filter((_event, index) => keep.has(index)),
    duplicatesRemoved,
  };
}

function repeatedEventCopiesMatch(events: AgentEvent[], indexes: number[], copyLength: number): boolean {
  const firstCopy = indexes.slice(0, copyLength).map((index) => stableRecordKey(events[index]));
  for (let offset = copyLength; offset < indexes.length; offset += copyLength) {
    for (let index = 0; index < copyLength; index += 1) {
      const eventIndex = indexes[offset + index];
      if (eventIndex === undefined || stableRecordKey(events[eventIndex]) !== firstCopy[index]) return false;
    }
  }
  return true;
}

function redactKnownSecrets(value: string, secrets: string[]): string {
  return redactDiagnosticCredentialValues(value, secrets);
}

function redactKnownSecretsInFile(data: Buffer, path: string, secrets: string[]): Buffer {
  if (!isTextEvidenceFile(path)) return data;
  const text = data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(data)) return data;
  return Buffer.from(redactKnownSecrets(text, secrets), "utf8");
}

function isTextEvidenceFile(path: string): boolean {
  return new Set([
    "",
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".jsonl",
    ".log",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ]).has(extname(path).toLowerCase());
}
