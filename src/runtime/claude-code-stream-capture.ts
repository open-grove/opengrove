import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentEvent } from "../core.js";
import { appEnvName } from "../identity.js";

export interface ClaudeCodeStreamCaptureOptions {
  enabled?: boolean;
  dir?: string;
  maxInlineBytes?: number;
  includeStderr?: boolean;
  includeRawIO?: boolean;
}

export type ClaudeCodeStreamCaptureKind =
  | "lifecycle"
  | "turn_input"
  | "process_launch"
  | "stdout_event"
  | "mapped_event"
  | "stderr"
  | "parse_error";

type CapturePayloadRef = {
  path: string;
  bytes: number;
  sha256: string;
  encoding: "json";
};

type CaptureRecord = {
  schemaVersion: 1;
  seq: number;
  timestamp: string;
  kind: ClaudeCodeStreamCaptureKind;
  event?: string;
  summary?: Record<string, string>;
  payload?: unknown;
  payloadRef?: CapturePayloadRef;
};

const DEFAULT_MAX_INLINE_BYTES = 512 * 1024;
const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

export class ClaudeCodeStreamCaptureRecorder {
  private seq = 0;
  private readonly filePath: string;
  private readonly blobDir: string;
  private readonly includeStderr: boolean;
  private readonly includeRawIO: boolean;

  constructor(
    private readonly options: Required<
      Pick<ClaudeCodeStreamCaptureOptions, "dir" | "maxInlineBytes" | "includeStderr" | "includeRawIO">
    >,
  ) {
    const captureId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(options.dir, { recursive: true });
    this.blobDir = join(options.dir, "blobs", captureId);
    mkdirSync(this.blobDir, { recursive: true });
    this.filePath = join(options.dir, `${captureId}-pid-${process.pid}.jsonl`);
    this.includeStderr = options.includeStderr;
    this.includeRawIO = options.includeRawIO;
    this.recordLifecycle("capture.started", {
      filePath: this.filePath,
      blobDir: this.blobDir,
      maxInlineBytes: options.maxInlineBytes,
      includeRawIO: options.includeRawIO,
    });
  }

  get path(): string {
    return this.filePath;
  }

  recordLifecycle(event: string, payload?: unknown): void {
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "lifecycle",
      event,
      summary: extractSummaryIds(payload),
      payload: redactSensitivePayload(payload),
    });
  }

  recordTurnInput(payload: {
    runId: string;
    sessionId: string;
    model?: string;
    userInput: string;
    appendSystemPrompt: string;
  }): void {
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "turn_input",
      summary: {
        runId: payload.runId,
        sessionId: payload.sessionId,
        ...(payload.model ? { model: payload.model } : {}),
      },
      payload: this.includeRawIO
        ? payload
        : {
            runId: payload.runId,
            sessionId: payload.sessionId,
            model: payload.model,
            userInput: summarizeLargeArg(payload.userInput),
            appendSystemPrompt: summarizeLargeArg(payload.appendSystemPrompt),
          },
    });
  }

  recordProcessLaunch(payload: {
    executable: string;
    argv: string[];
    cwd: string;
    model?: string;
    sessionId: string;
    runId: string;
  }): void {
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "process_launch",
      summary: {
        runId: payload.runId,
        sessionId: payload.sessionId,
        ...(payload.model ? { model: payload.model } : {}),
      },
      payload: redactSensitivePayload({
        ...payload,
        argv: summarizeClaudeArgv(payload.argv),
      }),
    });
  }

  recordStdoutEvent(line: string, parsed: unknown): void {
    const redacted = redactSensitivePayload(parsed);
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "stdout_event",
      summary: extractClaudeEventSummary(redacted),
      payload: {
        byteLength: Buffer.byteLength(line, "utf8"),
        sha256: createHash("sha256").update(line).digest("hex"),
        ...(this.includeRawIO ? { rawLine: line } : {}),
        event: redacted,
      },
    });
  }

  recordMappedEvents(events: AgentEvent[]): void {
    for (const event of events) {
      this.append({
        schemaVersion: 1,
        seq: this.nextSeq(),
        timestamp: new Date().toISOString(),
        kind: "mapped_event",
        event: event.type,
        summary: extractSummaryIds(event),
        payload: redactSensitivePayload(event),
      });
    }
  }

  recordParseError(line: string): void {
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "parse_error",
      payload: {
        byteLength: Buffer.byteLength(line, "utf8"),
        sha256: createHash("sha256").update(line).digest("hex"),
      },
    });
  }

  recordStderr(chunk: string): void {
    if (!this.includeStderr) {
      return;
    }
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "stderr",
      payload: redactSensitivePayload({ text: chunk }),
    });
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private append(record: CaptureRecord): void {
    try {
      const packed = packLargePayload(record, this.options.maxInlineBytes, this.blobDir);
      appendFileSync(this.filePath, `${JSON.stringify(packed)}\n`, "utf8");
    } catch {
      // Capture must never break the kernel bridge.
    }
  }
}

export function createClaudeCodeStreamCaptureRecorder(
  options: ClaudeCodeStreamCaptureOptions | undefined,
  env: NodeJS.ProcessEnv | undefined = process.env,
): ClaudeCodeStreamCaptureRecorder | undefined {
  const enabled = options?.enabled ?? !isDisabledFlag(env?.[appEnvName("CLAUDE_CODE_CAPTURE")]);
  if (!enabled) {
    return undefined;
  }
  return new ClaudeCodeStreamCaptureRecorder({
    dir:
      options?.dir ??
      env?.[appEnvName("CLAUDE_CODE_CAPTURE_DIR")] ??
      resolve(process.cwd(), "data", "claude-code-captures"),
    maxInlineBytes:
      options?.maxInlineBytes ??
      parsePositiveInteger(env?.[appEnvName("CLAUDE_CODE_CAPTURE_MAX_INLINE_BYTES")]) ??
      DEFAULT_MAX_INLINE_BYTES,
    includeStderr: options?.includeStderr ?? isEnabledFlag(env?.[appEnvName("CLAUDE_CODE_CAPTURE_STDERR")]),
    includeRawIO: options?.includeRawIO ?? !isDisabledFlag(env?.[appEnvName("CLAUDE_CODE_CAPTURE_RAW_IO")]),
  });
}

function summarizeClaudeArgv(argv: string[]): Array<string | Record<string, string | number>> {
  const result: Array<string | Record<string, string | number>> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--append-system-prompt") {
      const value = argv[index + 1] ?? "";
      result.push(arg, summarizeLargeArg(value));
      index += 1;
      continue;
    }
    if (index === argv.length - 1 && !arg.startsWith("-")) {
      result.push({
        kind: "user-input",
        bytes: Buffer.byteLength(arg, "utf8"),
        sha256: createHash("sha256").update(arg).digest("hex"),
      });
      continue;
    }
    result.push(arg);
  }
  return result;
}

function summarizeLargeArg(value: string): Record<string, string | number> {
  return {
    kind: "summarized-argument",
    bytes: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function packLargePayload(record: CaptureRecord, maxInlineBytes: number, blobDir: string): CaptureRecord {
  if (record.payload === undefined) {
    return record;
  }
  const json = JSON.stringify(record.payload);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxInlineBytes) {
    return record;
  }
  const sha256 = createHash("sha256").update(json).digest("hex");
  const name = `${String(record.seq).padStart(6, "0")}-${sha256.slice(0, 16)}.json`;
  writeFileSync(join(blobDir, name), `${json}\n`, "utf8");
  const { payload: _payload, ...rest } = record;
  return {
    ...rest,
    payloadRef: {
      path: join("blobs", basename(blobDir), name),
      bytes,
      sha256,
      encoding: "json",
    },
  };
}

function redactSensitivePayload(value: unknown, key = "", depth = 0): unknown {
  if (depth > 80) {
    return "[MAX_DEPTH]";
  }
  if (isSensitiveKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(object)) {
      redacted[entryKey] = redactSensitivePayload(entryValue, entryKey, depth + 1);
    }
    return redacted;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const compact = lower.replace(/[-_]/g, "");
  return (
    compact === "auth" ||
    compact === "authorization" ||
    compact === "proxyauthorization" ||
    compact === "apikey" ||
    compact === "xapikey" ||
    compact.endsWith("apikey") ||
    compact === "password" ||
    compact.endsWith("password") ||
    compact === "credential" ||
    compact === "credentials" ||
    compact.includes("credential") ||
    compact === "secret" ||
    compact.endsWith("secret") ||
    compact === "clientsecret" ||
    compact === "awssecretkey" ||
    compact === "awsaccesskey" ||
    compact === "awsaccesskeyid" ||
    compact === "awsbearertokenbedrock" ||
    compact === "accesstoken" ||
    compact === "refreshtoken" ||
    compact === "idtoken" ||
    compact === "sessiontoken" ||
    compact.endsWith("token") ||
    lower === "set-cookie" ||
    lower === "cookie"
  );
}

function redactSensitiveString(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function extractClaudeEventSummary(value: unknown): Record<string, string> | undefined {
  const object =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const summary = extractSummaryIds(value) ?? {};
  if (object && typeof object.type === "string") {
    summary.type = object.type;
  }
  const message =
    object?.message && typeof object.message === "object" && !Array.isArray(object.message)
      ? (object.message as Record<string, unknown>)
      : undefined;
  if (message && typeof message.id === "string") {
    summary.messageId = message.id;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function extractSummaryIds(value: unknown): Record<string, string> | undefined {
  const summary: Record<string, string> = {};
  visitForSummaryIds(value, summary, 0);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function visitForSummaryIds(value: unknown, summary: Record<string, string>, depth: number): void {
  if (depth > 12 || !value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      visitForSummaryIds(item, summary, depth + 1);
    }
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of ["runId", "sessionId", "messageId", "tool_use_id", "id"]) {
    if (summary[key] === undefined && typeof object[key] === "string") {
      summary[key] = object[key];
    }
  }
  for (const entry of Object.values(object).slice(0, 40)) {
    visitForSummaryIds(entry, summary, depth + 1);
  }
}

function isDisabledFlag(value: string | undefined): boolean {
  return value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase());
}

function isEnabledFlag(value: string | undefined): boolean {
  return value !== undefined && !isDisabledFlag(value);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
