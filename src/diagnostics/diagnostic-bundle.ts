import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { extname, join, resolve } from "node:path";
import {
  DIAGNOSTIC_CREDENTIAL_FILE_NAMES,
  DIAGNOSTIC_SYSTEM_LOG_FILE_NAMES,
  isDiagnosticCredentialPath,
} from "./evidence-files.js";
import { redactDiagnosticCredentialValues, safeDiagnosticIdentifier } from "./redaction.js";
import { createZipArchiveAsync, type ZipEntry } from "./zip.js";

export interface DiagnosticBundleVersions {
  app: string;
  clientReleaseNumber?: number;
  electron?: string;
  chrome?: string;
  claudeAgentSdk?: string;
  node: string;
}

export interface DiagnosticBundleBridgeStatus {
  status: unknown;
  pid?: unknown;
  port?: unknown;
  mode?: unknown;
  restartCount?: unknown;
  crashCount?: unknown;
}

export interface DiagnosticBundleResult {
  archive: Buffer;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  evidenceComplete: boolean;
}

interface DiagnosticEvidenceFile {
  archivePath: string;
  sourcePath: string;
  sizeBytes: number;
  kind: "problem-log" | "desktop-log";
  sha256: string;
  modifiedAt: string;
  truncation?: {
    reason: "evidence-truncated-tail";
    sourceSizeBytes: number;
    includedSizeBytes: number;
  };
}

interface ExcludedDiagnosticEvidenceFile {
  sourcePath: string;
  reason: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

interface DiagnosticEvidenceCandidate {
  sourcePath: string;
  archivePath: string;
  kind: DiagnosticEvidenceFile["kind"];
}

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const CORE_ENTRY_RESERVE_BYTES = 1024 * 1024;
const MAX_SYSTEM_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const TAIL_LINE_READ_AHEAD_BYTES = 64 * 1024;

export async function createDiagnosticBundle(options: {
  diagnosticsDir: string;
  logDirs: string[];
  bridgeStatus: DiagnosticBundleBridgeStatus;
  versions: DiagnosticBundleVersions;
  isPackaged?: boolean;
  runDiagnostics?: unknown;
  storeAppLayout?: unknown;
  secrets?: string[];
  now?: Date;
}): Promise<DiagnosticBundleResult> {
  const generatedAt = options.now ?? new Date();
  const secrets = (options.secrets ?? []).map((secret) => secret.trim()).filter(Boolean);
  const entries: ZipEntry[] = [];
  const includedFiles: DiagnosticEvidenceFile[] = [];
  const excludedFiles: ExcludedDiagnosticEvidenceFile[] = [];
  const seenSourcePaths = new Set<string>();
  const seenArchivePaths = new Set<string>();
  let evidenceBytes = 0;

  for (const candidate of systemEvidenceCandidates(options.diagnosticsDir, options.logDirs)) {
    evidenceBytes = await addSystemEvidenceFile({
      candidate,
      entries,
      includedFiles,
      excludedFiles,
      seenSourcePaths,
      seenArchivePaths,
      evidenceBytes,
      secrets,
    });
  }

  const missingEvidence = incompleteEvidenceItems(includedFiles, excludedFiles);
  const evidenceComplete = missingEvidence.length === 0;
  const coreEntries: ZipEntry[] = [
    {
      name: "README.txt",
      data: [
        "OpenGrove 完整系统取证包",
        "",
        "本包仅用于错误排查，请仅提交给可信人员。",
        "它保留系统问题记录、错误原文、结构化上下文、Bridge 与桌面日志和本机路径，不做模糊脱敏或内容改写。",
        "常见 API Key、JWT、Bearer Token 和 Bridge 已知可复用密钥值会被脱敏。",
        "凭证文件、认证 Cookie、Bridge 设置、SQLite/WAL/SHM 和 state-blobs 始终不会打包。",
        "日志中可能包含敏感业务内容、邮箱、本机路径或对话片段；对外分享前请自行检查。",
        "",
      ].join("\n"),
      modifiedAt: generatedAt,
    },
    {
      name: "bridge-status.json",
      data: evidenceJson(sanitizeBridgeStatus(options.bridgeStatus), secrets),
      modifiedAt: generatedAt,
    },
    {
      name: "recent-run-errors.json",
      data: evidenceJson(options.runDiagnostics ?? { unavailable: true, reason: "not_provided" }, secrets),
      modifiedAt: generatedAt,
    },
    {
      name: "store-app-layout.json",
      data: evidenceJson(options.storeAppLayout ?? { unavailable: true, reason: "not_provided" }, secrets),
      modifiedAt: generatedAt,
    },
    {
      name: "file-index.json",
      data: evidenceJson({ included: includedFiles, excluded: excludedFiles }, secrets),
      modifiedAt: generatedAt,
    },
    {
      name: "redaction-report.json",
      data: evidenceJson(
        {
          policy: "evidence-first",
          preserved: [
            "problem messages and structured context",
            "desktop and bridge logs",
            "local paths and source identifiers",
            "emails and business content found in evidence",
          ],
          redacted: ["known reusable secret values", "common API key shapes", "JWT values", "Bearer token values"],
          excluded: [
            "credential files and credential directories",
            "auth-cookies.json",
            "bridge-settings.json",
            "local-state SQLite/JSON files, WAL/SHM, and state-blobs",
          ],
        },
        secrets,
      ),
      modifiedAt: generatedAt,
    },
  ];

  coreEntries.push({
    name: "manifest.json",
    data: evidenceJson(
      {
        formatVersion: 5,
        kind: "opengrove-system-forensic-bundle",
        generatedAt: generatedAt.toISOString(),
        product: "OpenGrove",
        versions: sanitizeVersions(options.versions),
        system: {
          platform: safeDiagnosticIdentifier(platform(), 32) ?? "unknown",
          arch: safeDiagnosticIdentifier(arch(), 32) ?? "unknown",
          release: safeDiagnosticIdentifier(release(), 64) ?? "unknown",
          ...(typeof options.isPackaged === "boolean" ? { packaged: options.isPackaged } : {}),
        },
        privacy: {
          includesLogContent: true,
          includesProblemMessages: true,
          includesAbsolutePaths: true,
          includesConversationContent: true,
          includesStateFile: false,
          includesCredentials: false,
          structuredCoreMetadataAllowlistApplied: true,
          evidenceContentAllowlistApplied: false,
        },
        credentials: {
          evidencePolicy: "preserve-original-content",
          credentialValueRedactionApplied: true,
          credentialFilesIncluded: false,
          stateStoreIncluded: false,
          unstructuredEvidenceMayContainSensitiveContent: true,
          excludedFileNames: [...DIAGNOSTIC_CREDENTIAL_FILE_NAMES].sort(),
        },
        counts: {
          includedEvidenceFiles: includedFiles.length,
          excludedEvidenceFiles: excludedFiles.length,
          inputBytes: evidenceBytes,
        },
        completeness: {
          evidenceComplete,
          missingEvidence,
        },
        included: [
          "bridge-status.json",
          "recent-run-errors.json",
          "store-app-layout.json",
          "problems.jsonl and problems.jsonl.1 when present",
          "logs/",
          "file-index.json",
        ],
      },
      secrets,
    ),
    modifiedAt: generatedAt,
  });

  const allEntries = [...coreEntries, ...entries];
  const inputBytes = allEntries.reduce((total, entry) => total + entryBytes(entry), 0);
  if (inputBytes > MAX_INPUT_BYTES) throw new Error("diagnostic_bundle_too_large");
  const archive = await createZipArchiveAsync(allEntries);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("diagnostic_bundle_too_large");
  return {
    archive,
    fileName: defaultDiagnosticBundleFileName(generatedAt),
    sizeBytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
    evidenceComplete,
  };
}

export function defaultDiagnosticBundleFileName(now = new Date()): string {
  return `OpenGrove-system-forensics-${now.toISOString().replace(/[:.]/g, "-")}.zip`;
}

function systemEvidenceCandidates(diagnosticsDir: string, logDirs: string[]): DiagnosticEvidenceCandidate[] {
  const diagnosticsRoot = resolve(diagnosticsDir);
  const logRoots = [...new Set(logDirs.map((root) => resolve(root)))];
  return [
    {
      sourcePath: join(diagnosticsRoot, "problems.jsonl.1"),
      archivePath: "problems.jsonl.1",
      kind: "problem-log",
    },
    {
      sourcePath: join(diagnosticsRoot, "problems.jsonl"),
      archivePath: "problems.jsonl",
      kind: "problem-log",
    },
    ...logRoots.flatMap((root) =>
      DIAGNOSTIC_SYSTEM_LOG_FILE_NAMES.map((name) => ({
        sourcePath: join(root, name),
        archivePath: `logs/${name}`,
        kind: "desktop-log" as const,
      })),
    ),
  ];
}

async function addSystemEvidenceFile(options: {
  candidate: DiagnosticEvidenceCandidate;
  entries: ZipEntry[];
  includedFiles: DiagnosticEvidenceFile[];
  excludedFiles: ExcludedDiagnosticEvidenceFile[];
  seenSourcePaths: Set<string>;
  seenArchivePaths: Set<string>;
  evidenceBytes: number;
  secrets: string[];
}): Promise<number> {
  const requestedPath = options.candidate.sourcePath;
  if (!existsSync(requestedPath)) return options.evidenceBytes;
  let sourcePath: string;
  let sourceStat: Stats;
  try {
    if (lstatSync(requestedPath).isSymbolicLink()) {
      options.excludedFiles.push({ sourcePath: requestedPath, reason: "evidence-symlink" });
      return options.evidenceBytes;
    }
    sourcePath = realpathSync(requestedPath);
    sourceStat = statSync(sourcePath);
  } catch (error) {
    options.excludedFiles.push({ sourcePath: requestedPath, reason: `evidence-stat-failed-${fsErrorCode(error)}` });
    return options.evidenceBytes;
  }
  if (!sourceStat.isFile() || options.seenSourcePaths.has(sourcePath)) return options.evidenceBytes;
  if (isDiagnosticCredentialPath(sourcePath)) {
    options.excludedFiles.push({ sourcePath, reason: "credential-or-state-store" });
    return options.evidenceBytes;
  }
  const remainingBytes = MAX_INPUT_BYTES - CORE_ENTRY_RESERVE_BYTES - options.evidenceBytes;
  if (remainingBytes <= 0 || (options.candidate.kind !== "desktop-log" && sourceStat.size > remainingBytes)) {
    options.excludedFiles.push({
      sourcePath,
      reason: "evidence-size-limit",
      sizeBytes: sourceStat.size,
      modifiedAt: sourceStat.mtime.toISOString(),
    });
    return options.evidenceBytes;
  }
  const tailBytes = Math.min(remainingBytes, MAX_SYSTEM_LOG_TAIL_BYTES);
  let rawData: Buffer;
  let truncated = options.candidate.kind === "desktop-log" && sourceStat.size > tailBytes;
  try {
    rawData = truncated
      ? await readLineAlignedTail(sourcePath, sourceStat.size, tailBytes)
      : await readFile(sourcePath);
  } catch (error) {
    options.excludedFiles.push({ sourcePath, reason: `evidence-read-failed-${fsErrorCode(error)}` });
    return options.evidenceBytes;
  }
  let data = redactTextEvidence(rawData, options.secrets);
  if (data.length > remainingBytes && options.candidate.kind === "desktop-log") {
    data = lineAlignedTail(data, remainingBytes);
    truncated = true;
  }
  if (data.length > remainingBytes) {
    options.excludedFiles.push({
      sourcePath,
      reason: "evidence-size-limit",
      sizeBytes: sourceStat.size,
      modifiedAt: sourceStat.mtime.toISOString(),
    });
    return options.evidenceBytes;
  }
  const archivePath = uniqueArchivePath(options.candidate.archivePath, sourcePath, options.seenArchivePaths);
  const sha256 = createHash("sha256").update(data).digest("hex");
  options.entries.push({ name: archivePath, data, modifiedAt: sourceStat.mtime });
  options.includedFiles.push({
    archivePath,
    sourcePath,
    sizeBytes: data.length,
    kind: options.candidate.kind,
    sha256,
    modifiedAt: sourceStat.mtime.toISOString(),
    ...(truncated
      ? {
          truncation: {
            reason: "evidence-truncated-tail" as const,
            sourceSizeBytes: sourceStat.size,
            includedSizeBytes: data.length,
          },
        }
      : {}),
  });
  options.seenSourcePaths.add(sourcePath);
  options.seenArchivePaths.add(archivePath);
  return options.evidenceBytes + data.length;
}

function redactTextEvidence(data: Buffer, secrets: string[]): Buffer {
  return Buffer.from(redactDiagnosticCredentialValues(data.toString("utf8"), secrets), "utf8");
}

async function readLineAlignedTail(path: string, sourceSize: number, maxBytes: number): Promise<Buffer> {
  const bytesToRead = Math.min(sourceSize, maxBytes + TAIL_LINE_READ_AHEAD_BYTES);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, sourceSize - bytesToRead);
    return lineAlignedTail(buffer.subarray(0, bytesRead), maxBytes);
  } finally {
    await handle.close();
  }
}

function lineAlignedTail(data: Buffer, maxBytes: number): Buffer {
  if (data.length <= maxBytes) return data;
  const start = data.length - maxBytes;
  const nextLine = data.indexOf(0x0a, start);
  return nextLine >= 0 ? data.subarray(nextLine + 1) : data.subarray(start);
}

function incompleteEvidenceItems(
  includedFiles: DiagnosticEvidenceFile[],
  excludedFiles: ExcludedDiagnosticEvidenceFile[],
): string[] {
  return [
    ...includedFiles.flatMap((file) => (file.truncation ? [`${file.truncation.reason}:${file.sourcePath}`] : [])),
    ...excludedFiles
      .filter((file) => /^(?:evidence-stat-failed|evidence-read-failed|evidence-size-limit)/.test(file.reason))
      .map((file) => `${file.reason}:${file.sourcePath}`),
  ];
}

function uniqueArchivePath(desired: string, sourcePath: string, seen: Set<string>): string {
  if (!seen.has(desired)) return desired;
  const extension = extname(desired);
  const stem = extension ? desired.slice(0, -extension.length) : desired;
  const suffix = createHash("sha256").update(sourcePath).digest("hex").slice(0, 10);
  return `${stem}-${suffix}${extension}`;
}

function evidenceJson(value: unknown, secrets: string[]): string {
  return `${redactDiagnosticCredentialValues(JSON.stringify(value, null, 2), secrets)}\n`;
}

function sanitizeVersions(value: DiagnosticBundleVersions): DiagnosticBundleVersions {
  const clientReleaseNumber = safeNumber(value.clientReleaseNumber);
  const electron = safeDiagnosticIdentifier(value.electron, 64);
  const chrome = safeDiagnosticIdentifier(value.chrome, 64);
  const claudeAgentSdk = safeDiagnosticIdentifier(value.claudeAgentSdk, 64);
  return {
    app: safeDiagnosticIdentifier(value.app, 64) ?? "unknown",
    ...(clientReleaseNumber !== undefined ? { clientReleaseNumber } : {}),
    ...(electron ? { electron } : {}),
    ...(chrome ? { chrome } : {}),
    ...(claudeAgentSdk ? { claudeAgentSdk } : {}),
    node: safeDiagnosticIdentifier(value.node, 64) ?? "unknown",
  };
}

function sanitizeBridgeStatus(value: DiagnosticBundleBridgeStatus): Record<string, unknown> {
  const pid = safeNumber(value.pid);
  const port = safeNumber(value.port);
  const mode = safeDiagnosticIdentifier(value.mode, 32);
  const restartCount = safeNumber(value.restartCount);
  const crashCount = safeNumber(value.crashCount);
  return {
    status: safeDiagnosticIdentifier(value.status, 32) ?? "unknown",
    ...(pid !== undefined ? { pid } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(mode ? { mode } : {}),
    ...(restartCount !== undefined ? { restartCount } : {}),
    ...(crashCount !== undefined ? { crashCount } : {}),
  };
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function entryBytes(entry: ZipEntry): number {
  return Buffer.isBuffer(entry.data) ? entry.data.length : Buffer.byteLength(entry.data);
}

function fsErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code.toLowerCase() : "unknown";
}
