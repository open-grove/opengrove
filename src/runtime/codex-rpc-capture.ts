import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appEnvName } from "../identity.js";

export interface CodexRpcCaptureOptions {
  enabled?: boolean;
  dir?: string;
  maxInlineBytes?: number;
  includeStderr?: boolean;
}

export type CodexRpcCaptureDirection = "host_to_codex" | "codex_to_host";

export type CodexRpcCaptureKind = "request" | "response" | "notification" | "lifecycle" | "stderr" | "parse_error";

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
  kind: CodexRpcCaptureKind;
  direction?: CodexRpcCaptureDirection;
  id?: string | number;
  method?: string;
  event?: string;
  summary?: Record<string, string>;
  payload?: unknown;
  payloadRef?: CapturePayloadRef;
};

type RpcCaptureMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const DEFAULT_MAX_INLINE_BYTES = 512 * 1024;
const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

export class CodexRpcCaptureRecorder {
  private seq = 0;
  private readonly filePath: string;
  private readonly blobDir: string;
  private readonly includeStderr: boolean;

  constructor(
    private readonly options: Required<Pick<CodexRpcCaptureOptions, "dir" | "maxInlineBytes" | "includeStderr">>,
  ) {
    const captureId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(options.dir, { recursive: true });
    this.blobDir = join(options.dir, "blobs", captureId);
    mkdirSync(this.blobDir, { recursive: true });
    this.filePath = join(options.dir, `${captureId}-pid-${process.pid}.jsonl`);
    this.includeStderr = options.includeStderr;
    this.recordLifecycle("capture.started", {
      filePath: this.filePath,
      blobDir: this.blobDir,
      maxInlineBytes: options.maxInlineBytes,
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
      payload: redactSensitivePayload(payload),
    });
  }

  recordMessage(direction: CodexRpcCaptureDirection, message: RpcCaptureMessage, meta: { method?: string } = {}): void {
    const method = typeof message.method === "string" ? message.method : meta.method;
    const redacted = redactSensitivePayload(message);
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: rpcMessageKind(message),
      direction,
      id: message.id,
      method,
      summary: extractSummaryIds(redacted),
      payload: redacted,
    });
  }

  recordParseError(byteLength: number): void {
    this.append({
      schemaVersion: 1,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
      kind: "parse_error",
      payload: { byteLength },
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

export function createCodexRpcCaptureRecorder(
  options: CodexRpcCaptureOptions | undefined,
  env: NodeJS.ProcessEnv | undefined = process.env,
): CodexRpcCaptureRecorder | undefined {
  const enabled = options?.enabled ?? !isDisabledFlag(env?.[appEnvName("CODEX_RPC_CAPTURE")]);
  if (!enabled) {
    return undefined;
  }
  return new CodexRpcCaptureRecorder({
    dir:
      options?.dir ??
      env?.[appEnvName("CODEX_RPC_CAPTURE_DIR")] ??
      resolve(process.cwd(), "data", "codex-rpc-captures"),
    maxInlineBytes:
      options?.maxInlineBytes ??
      parsePositiveInteger(env?.[appEnvName("CODEX_RPC_CAPTURE_MAX_INLINE_BYTES")]) ??
      DEFAULT_MAX_INLINE_BYTES,
    includeStderr: options?.includeStderr ?? isEnabledFlag(env?.[appEnvName("CODEX_RPC_CAPTURE_STDERR")]),
  });
}

function rpcMessageKind(message: RpcCaptureMessage): CodexRpcCaptureKind {
  if (typeof message.method === "string") {
    return message.id === undefined ? "notification" : "request";
  }
  return "response";
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
      path: join("blobs", blobDir.split("/").at(-1) ?? "", name),
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
  for (const key of ["threadId", "turnId", "itemId", "callId", "approvalId", "sessionId"]) {
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
