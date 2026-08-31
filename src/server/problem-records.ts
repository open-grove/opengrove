import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAppEnv } from "../identity.js";
import {
  redactDiagnosticText,
  safeDiagnosticErrorCode,
  safeDiagnosticIdentifier,
  truncateDiagnosticText,
} from "../diagnostics/redaction.js";
import {
  sanitizeDiagnosticFacts,
  sanitizeProblemLevel,
  type DiagnosticFacts,
  type DiagnosticProblemRef,
  type ProblemCategory,
  type ProblemLevel,
} from "../diagnostics/problem-schema.js";
import type { BridgeState } from "./bridge-types.js";
import { bridgeDataPath } from "./storage-paths.js";

export interface ProblemRecord {
  incidentId: string;
  traceId: string;
  at: string;
  category: ProblemCategory;
  phase: string;
  code: string;
  level: ProblemLevel;
  message: string;
  retryable: boolean;
  runId?: string;
  context?: Record<string, string | number | boolean | null>;
  facts?: DiagnosticFacts;
}

export interface RecordProblemInput {
  traceId?: string;
  category: ProblemCategory;
  phase: string;
  code?: string;
  level?: ProblemLevel;
  error: unknown;
  retryable?: boolean;
  runId?: string;
  context?: Record<string, string | number | boolean | null | undefined>;
  facts?: DiagnosticFacts;
  backgroundDedupe?: {
    key: string;
    windowMs: number;
  };
}

const MAX_PROBLEM_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PROBLEM_MESSAGE_BYTES = 4 * 1024;
const MAX_CONTEXT_ENTRIES = 32;
const MAX_BACKGROUND_DEDUPE_ENTRIES = 256;
const backgroundProblems = new Map<string, { at: number; record: ProblemRecord }>();

export function createTraceId(value: string | string[] | undefined): string {
  const requested = Array.isArray(value) ? value[0] : value;
  const normalized = requested?.trim();
  return normalized && /^[a-zA-Z0-9._:-]{8,128}$/.test(normalized) ? normalized : randomUUID();
}

export function recordProblem(state: BridgeState, input: RecordProblemInput): ProblemRecord {
  return recordProblemInDirectory(problemRecordsRoot(state), input);
}

export function recordProblemInDirectory(root: string, input: RecordProblemInput): ProblemRecord {
  const rawMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const runId = safeDiagnosticIdentifier(input.runId);
  const resolvedRoot = resolve(root);
  const phase = safeDiagnosticIdentifier(input.phase, 64) ?? "unknown";
  const code = safeDiagnosticErrorCode(input.code ?? rawMessage);
  const facts = sanitizeDiagnosticFacts(input.facts);
  const dedupeKey = backgroundProblemKey(resolvedRoot, input, phase, code);
  if (dedupeKey) {
    const recent = backgroundProblems.get(dedupeKey);
    if (recent && Date.now() - recent.at < input.backgroundDedupe!.windowMs) return recent.record;
  }
  const record: ProblemRecord = {
    incidentId: createIncidentId(),
    traceId: createTraceId(input.traceId),
    at: new Date().toISOString(),
    category: input.category,
    phase,
    code,
    level: sanitizeProblemLevel(input.level),
    message: truncateDiagnosticText(redactDiagnosticText(rawMessage), MAX_PROBLEM_MESSAGE_BYTES),
    retryable: input.retryable === true,
    ...(runId ? { runId } : {}),
    ...(input.context ? { context: sanitizeContext(input.context) } : {}),
    ...(facts ? { facts } : {}),
  };
  let persisted = false;
  try {
    mkdirSync(resolvedRoot, { recursive: true });
    const path = join(resolvedRoot, "problems.jsonl");
    const line = `${JSON.stringify(record)}\n`;
    rotateProblemLog(path, Buffer.byteLength(line));
    appendFileSync(path, line, "utf8");
    persisted = true;
  } catch {
    // Diagnostic persistence must never turn a recoverable failure into a product failure.
  }
  if (dedupeKey && persisted) rememberBackgroundProblem(dedupeKey, record);
  return record;
}

export function problemRef(problem: Pick<ProblemRecord, "incidentId" | "code">): DiagnosticProblemRef {
  return { incidentId: problem.incidentId, code: problem.code };
}

export function problemRecordsRoot(state: BridgeState): string {
  const configured = readAppEnv("DIAGNOSTICS_DIR")?.trim();
  return configured ? resolve(configured) : bridgeDataPath(state, "diagnostics");
}

function rotateProblemLog(path: string, nextLineBytes: number): void {
  if (!existsSync(path) || statSync(path).size + nextLineBytes <= MAX_PROBLEM_LOG_BYTES) return;
  const previous = `${path}.1`;
  try {
    rmSync(previous, { force: true });
    renameSync(path, previous);
  } catch {
    // non-critical-fallback: If another recorder wins rotation, append to the current file instead.
  }
}

function createIncidentId(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `OG-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function backgroundProblemKey(
  root: string,
  input: RecordProblemInput,
  phase: string,
  code: string,
): string | undefined {
  if (!input.backgroundDedupe) return undefined;
  const key = safeDiagnosticIdentifier(input.backgroundDedupe.key, 128);
  if (!key || !Number.isFinite(input.backgroundDedupe.windowMs) || input.backgroundDedupe.windowMs <= 0) {
    return undefined;
  }
  return `${root}:${input.category}:${phase}:${code}:${key}`;
}

function rememberBackgroundProblem(key: string, record: ProblemRecord): void {
  if (backgroundProblems.size >= MAX_BACKGROUND_DEDUPE_ENTRIES) {
    const oldestKey = backgroundProblems.keys().next().value;
    if (typeof oldestKey === "string") backgroundProblems.delete(oldestKey);
  }
  backgroundProblems.set(key, { at: Date.now(), record });
}

function sanitizeContext(
  context: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context).slice(0, MAX_CONTEXT_ENTRIES)) {
    if (value === undefined) continue;
    const safeKey = safeDiagnosticIdentifier(key, 64);
    if (!safeKey) continue;
    result[safeKey] = typeof value === "string" ? truncateDiagnosticText(redactDiagnosticText(value), 500) : value;
  }
  return result;
}
