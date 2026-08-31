import { redactDiagnosticText, safeDiagnosticErrorCode, safeDiagnosticIdentifier } from "./redaction.js";

export const PROBLEM_CATEGORIES = ["bridge", "app-install", "ww", "employee-run", "desktop"] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

export const PROBLEM_LEVELS = ["warning", "error"] as const;
export type ProblemLevel = (typeof PROBLEM_LEVELS)[number];

export const DIAGNOSTIC_RUN_WINDOW = "recent-100" as const;

export interface DiagnosticProblemRef {
  incidentId: string;
  code: string;
}

export interface RuntimeErrorDiagnostics {
  runtimeModelId?: string;
  runtimeVersion?: string;
  /** Provider/API correlation id only; never use host- or runtime-local transport ids. */
  upstreamRequestId?: string;
}

export type DiagnosticJsonKind =
  | "array"
  | "boolean"
  | "invalid-json"
  | "missing"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unavailable";

export interface DiagnosticHttpResponseAttempt {
  attempt: number;
  method: string;
  endpoint: string;
  httpStatus?: number;
  upstreamRequestId?: string;
  contentType?: string;
  envelopeKind: DiagnosticJsonKind;
  envelopeFields?: Record<string, DiagnosticJsonKind>;
  dataKind: DiagnosticJsonKind;
  dataFields?: Record<string, DiagnosticJsonKind>;
  dataItemCount?: number;
  dataItemKinds?: DiagnosticJsonKind[];
  dataItemFields?: Record<string, string>;
  validationCode?: string;
  missingFields?: string[];
}

export interface DiagnosticFacts {
  runKind?: "room" | "routine";
  stepKind?: "tool" | "member" | "skill" | "approval";
  stepIndex?: number;
  attemptCount?: number;
  durationMs?: number;
  httpStatus?: number;
  providerKind?: string;
  kernelKind?: string;
  /** Model selected on the employee/member configuration. */
  selectedModelId?: string;
  /** Model identifier passed from OpenGrove to the kernel runtime. */
  requestedModelId?: string;
  /** Model identifier reported by the running kernel. */
  runtimeModelId?: string;
  runtimeVersion?: string;
  upstreamRequestId?: string;
  httpResponses?: DiagnosticHttpResponseAttempt[];
}

const PROBLEM_CATEGORY_SET = new Set<string>(PROBLEM_CATEGORIES);
const PROBLEM_LEVEL_SET = new Set<string>(PROBLEM_LEVELS);
const RUN_KINDS = new Set<DiagnosticFacts["runKind"]>(["room", "routine"]);
const STEP_KINDS = new Set<DiagnosticFacts["stepKind"]>(["tool", "member", "skill", "approval"]);
const JSON_KINDS = new Set<DiagnosticJsonKind>([
  "array",
  "boolean",
  "invalid-json",
  "missing",
  "null",
  "number",
  "object",
  "string",
  "unavailable",
]);

export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === "string" && PROBLEM_CATEGORY_SET.has(value);
}

export function sanitizeProblemLevel(value: unknown): ProblemLevel {
  return typeof value === "string" && PROBLEM_LEVEL_SET.has(value) ? (value as ProblemLevel) : "error";
}

export function isRetryableDiagnosticError(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /timed out|timeout|connect|gateway|fetch failed|network|rate.limit|unavailable|overloaded/i.test(value)
  );
}

export function sanitizeDiagnosticProblemRef(value: unknown, secrets: string[] = []): DiagnosticProblemRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const incidentId = safeSecretFreeIdentifier(input.incidentId, secrets, 64);
  if (!incidentId || !/^OG-\d{8}-[A-F0-9]{6}$/.test(incidentId)) return undefined;
  return {
    incidentId,
    code: safeDiagnosticErrorCode(input.code),
  };
}

export function sanitizeDiagnosticFacts(value: unknown, secrets: string[] = []): DiagnosticFacts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const facts: DiagnosticFacts = {};
  if (RUN_KINDS.has(input.runKind as DiagnosticFacts["runKind"])) {
    facts.runKind = input.runKind as DiagnosticFacts["runKind"];
  }
  if (STEP_KINDS.has(input.stepKind as DiagnosticFacts["stepKind"])) {
    facts.stepKind = input.stepKind as DiagnosticFacts["stepKind"];
  }
  const stepIndex = safeInteger(input.stepIndex, 1);
  if (stepIndex !== undefined) facts.stepIndex = stepIndex;
  const attemptCount = safeInteger(input.attemptCount, 0);
  if (attemptCount !== undefined) facts.attemptCount = attemptCount;
  const durationMs = safeInteger(input.durationMs, 0);
  if (durationMs !== undefined) facts.durationMs = durationMs;
  const httpStatus = safeInteger(input.httpStatus, 100, 599);
  if (httpStatus !== undefined) facts.httpStatus = httpStatus;
  const providerKind = safeSecretFreeIdentifier(input.providerKind, secrets, 64);
  if (providerKind) facts.providerKind = providerKind;
  const kernelKind = safeSecretFreeIdentifier(input.kernelKind, secrets, 64);
  if (kernelKind) facts.kernelKind = kernelKind;
  const selectedModelId = safeSecretFreeIdentifier(input.selectedModelId, secrets, 128);
  if (selectedModelId) facts.selectedModelId = selectedModelId;
  const requestedModelId = safeSecretFreeIdentifier(input.requestedModelId, secrets, 128);
  if (requestedModelId) facts.requestedModelId = requestedModelId;
  const runtimeModelId = safeSecretFreeIdentifier(input.runtimeModelId, secrets, 128);
  if (runtimeModelId) facts.runtimeModelId = runtimeModelId;
  const runtimeVersion = safeSecretFreeIdentifier(input.runtimeVersion, secrets, 64);
  if (runtimeVersion) facts.runtimeVersion = runtimeVersion;
  const upstreamRequestId = safeSecretFreeIdentifier(input.upstreamRequestId, secrets, 128);
  if (upstreamRequestId) facts.upstreamRequestId = upstreamRequestId;
  const httpResponses = sanitizeHttpResponses(input.httpResponses, secrets);
  if (httpResponses.length > 0) facts.httpResponses = httpResponses;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function sanitizeHttpResponses(value: unknown, secrets: string[]): DiagnosticHttpResponseAttempt[] {
  if (!Array.isArray(value)) return [];
  const responses: DiagnosticHttpResponseAttempt[] = [];
  for (const item of value.slice(0, 10)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const input = item as Record<string, unknown>;
    const attempt = safeInteger(input.attempt, 1, 100);
    const method = safeSecretFreeIdentifier(input.method, secrets, 16)?.toUpperCase();
    const endpoint = safeHttpEndpoint(input.endpoint);
    const envelopeKind = safeJsonKind(input.envelopeKind);
    const dataKind = safeJsonKind(input.dataKind);
    if (attempt === undefined || !method || !endpoint || !envelopeKind || !dataKind) continue;
    const response: DiagnosticHttpResponseAttempt = { attempt, method, endpoint, envelopeKind, dataKind };
    const httpStatus = safeInteger(input.httpStatus, 100, 599);
    if (httpStatus !== undefined) response.httpStatus = httpStatus;
    const upstreamRequestId = safeSecretFreeIdentifier(input.upstreamRequestId, secrets, 128);
    if (upstreamRequestId) response.upstreamRequestId = upstreamRequestId;
    const contentType = safeContentType(input.contentType);
    if (contentType) response.contentType = contentType;
    const envelopeFields = sanitizeJsonFieldKinds(input.envelopeFields, secrets);
    if (envelopeFields) response.envelopeFields = envelopeFields;
    const dataFields = sanitizeJsonFieldKinds(input.dataFields, secrets);
    if (dataFields) response.dataFields = dataFields;
    const dataItemCount = safeInteger(input.dataItemCount, 0, 1_000_000);
    if (dataItemCount !== undefined) response.dataItemCount = dataItemCount;
    const dataItemKinds = sanitizeJsonKinds(input.dataItemKinds);
    if (dataItemKinds.length > 0) response.dataItemKinds = dataItemKinds;
    const dataItemFields = sanitizeAggregateFieldKinds(input.dataItemFields, secrets);
    if (dataItemFields) response.dataItemFields = dataItemFields;
    const validationCode = safeSecretFreeIdentifier(input.validationCode, secrets, 64);
    if (validationCode) response.validationCode = validationCode;
    const missingFields = sanitizeFieldNames(input.missingFields, secrets);
    if (missingFields.length > 0) response.missingFields = missingFields;
    responses.push(response);
  }
  return responses;
}

function safeHttpEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  return /^\/[a-zA-Z0-9._~/-]+$/.test(value) ? value : undefined;
}

function safeContentType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100) return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : undefined;
}

function safeJsonKind(value: unknown): DiagnosticJsonKind | undefined {
  return typeof value === "string" && JSON_KINDS.has(value as DiagnosticJsonKind)
    ? (value as DiagnosticJsonKind)
    : undefined;
}

function sanitizeJsonKinds(value: unknown): DiagnosticJsonKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(safeJsonKind).filter((item): item is DiagnosticJsonKind => Boolean(item)))].slice(0, 9);
}

function sanitizeJsonFieldKinds(value: unknown, secrets: string[]): Record<string, DiagnosticJsonKind> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, DiagnosticJsonKind> = {};
  for (const [key, kindValue] of Object.entries(value).slice(0, 64)) {
    const safeKey = safeFieldName(key, secrets);
    const kind = safeJsonKind(kindValue);
    if (safeKey && kind) output[safeKey] = kind;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeAggregateFieldKinds(value: unknown, secrets: string[]): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, kindsValue] of Object.entries(value).slice(0, 64)) {
    const safeKey = safeFieldName(key, secrets);
    if (!safeKey || typeof kindsValue !== "string") continue;
    const kinds = kindsValue
      .split("|")
      .map(safeJsonKind)
      .filter((item): item is DiagnosticJsonKind => Boolean(item));
    if (kinds.length > 0) output[safeKey] = [...new Set(kinds)].sort().join("|");
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeFieldNames(value: unknown, secrets: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((item) => safeFieldName(item, secrets)).filter((item): item is string => Boolean(item))),
  ].slice(0, 64);
}

function safeFieldName(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.\[\]-]{1,128}$/.test(value)) return undefined;
  return redactDiagnosticText(value, secrets) === value ? value : undefined;
}

function safeInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function safeSecretFreeIdentifier(value: unknown, secrets: string[], maxLength: number): string | undefined {
  if (typeof value !== "string" || redactDiagnosticText(value, secrets) !== value) return undefined;
  const identifier = safeDiagnosticIdentifier(value, maxLength);
  if (!identifier) return undefined;
  return redactDiagnosticText(identifier, secrets) === identifier ? identifier : undefined;
}
