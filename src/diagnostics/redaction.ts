import { homedir } from "node:os";

const SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:authorization|cookie|set-cookie|x-opengrove-token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\b["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?([^\s,;"']+)/gi;
const ENV_SECRET_PATTERN = /(\b[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\b\s*=\s*)([^\s]+)/g;
const JSON_SECRET_PATTERN =
  /("(?:authorization|cookie|set-cookie|x-opengrove-token|registry[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|key)"\s*:\s*")([^"]+)(")/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const WELL_KNOWN_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ww_sk_[A-Za-z0-9_-]{8,}|gh[opurs]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi;
const GENERIC_ERROR_CODES = new Set([
  "aborted",
  "cancelled",
  "error",
  "failed",
  "forbidden",
  "not_found",
  "timeout",
  "unauthorized",
]);
const SAFE_ERROR_CODE_PREFIXES = [
  "app_",
  "archive_",
  "auth_",
  "bridge_",
  "cloud_",
  "default_",
  "diagnostic_",
  "desktop_",
  "employee_",
  "invalid_",
  "kernel_",
  "manifest_",
  "provider_",
  "request_",
  "room_",
  "server_",
  "ww_",
];

export function redactDiagnosticText(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  const home = homedir();
  if (home) {
    output = output.replace(new RegExp(escapeRegExp(home), "g"), "~");
  }
  return output
    .replace(JSON_SECRET_PATTERN, "$1[REDACTED]$3")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(ENV_SECRET_PATTERN, "$1[REDACTED]")
    .replace(WELL_KNOWN_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(EMAIL_PATTERN, "[EMAIL REDACTED]");
}

// Run evidence keeps source and paths intact, but reusable credential values must never survive export.
export function redactDiagnosticCredentialValues(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length < 4) continue;
    output = output.split(secret).join("[REDACTED:KNOWN_SECRET]");
  }
  return output
    .replace(JSON_SECRET_PATTERN, "$1[REDACTED]$3")
    .replace(SECRET_ASSIGNMENT_PATTERN, (match, prefix: string, value: string) =>
      /^(?:args|process|options|input|request|response|config|env)(?:[.[(]|$)/i.test(value)
        ? match
        : `${prefix}[REDACTED]`,
    )
    .replace(ENV_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(WELL_KNOWN_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]");
}

export function safeDiagnosticErrorCode(value: unknown): string {
  const candidate = String(value ?? "")
    .trim()
    .match(/^([a-z0-9][a-z0-9_.-]{0,63})(?=$|[:\s])/i)?.[1];
  if (!candidate || candidate !== candidate.toLowerCase()) return "unknown_error";
  if (/^(?:ww_sk_|sk_|xox|akia|asia)/.test(candidate)) return "unknown_error";
  if (
    !/^\d{1,6}$/.test(candidate) &&
    !GENERIC_ERROR_CODES.has(candidate) &&
    !SAFE_ERROR_CODE_PREFIXES.some((prefix) => candidate.startsWith(prefix))
  )
    return "unknown_error";
  return candidate;
}

export function safeDiagnosticIdentifier(value: unknown, maxBytes = 128): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, "_");
  return truncateDiagnosticText(normalized, maxBytes) || undefined;
}

export function truncateDiagnosticText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
