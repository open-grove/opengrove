import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "../core.js";

export async function readJsonBody(request: IncomingMessage, maxBytes = 25_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const declaredSize = Number(request.headers["content-length"]);
  if (Number.isSafeInteger(declaredSize) && declaredSize > maxBytes) {
    throw new Error("body_too_large");
  }

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

export function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data) ?? "null";
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function jsonObjectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function sourceRefArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => {
          const object = record(item);
          const ref = {
            title: stringValue(object.title) || undefined,
            url: stringValue(object.url) || undefined,
            locator: stringValue(object.locator) || undefined,
            quote: stringValue(object.quote) || undefined,
          };
          return Object.values(ref).some(Boolean) ? ref : undefined;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;
}

export function dedupeIds(values: string[]): string[] {
  return [...new Set(values.filter((item) => typeof item === "string" && item.length > 0))];
}

export function splitList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
