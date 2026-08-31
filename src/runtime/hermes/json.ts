import type { JsonObject, JsonValue } from "../../core.js";
import { toSafeJsonValue } from "../../core/safe-json.js";

export function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function toJsonObject(value: Record<string, unknown>): JsonObject {
  return toJsonValue(value) as JsonObject;
}

export function toJsonValue(value: unknown): JsonValue {
  return toSafeJsonValue(value, {
    omitUndefinedProperties: true,
    stringifyUnsupported: true,
  });
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Read streamed text without discarding whitespace-only token deltas. */
export function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
