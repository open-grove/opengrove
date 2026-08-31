import {
  sanitizeDiagnosticFacts,
  type DiagnosticFacts,
  type DiagnosticHttpResponseAttempt,
  type DiagnosticJsonKind,
} from "../../diagnostics/problem-schema.js";
import { numberValue, record, stringValue } from "../http-utils.js";
import type { WwApiError, WwResponseDiagnostics, WwResponseMappingError } from "./types.js";

export const WW_API_REQUEST_TIMEOUT_MS = 10_000;
export const WW_API_REQUEST_MAX_ATTEMPTS = 3;

const WW_API_REQUEST_RETRY_DELAYS_MS = [1_000, 3_000] as const;

type WwRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface WwEnvelopeRequestOptions {
  method: WwRequestMethod;
  body?: unknown;
  accessToken?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  throwOnInvalidJson?: boolean;
}

interface WwRetryRequestOptions {
  method: "GET" | "POST";
  body?: unknown;
  accessToken: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface WwJsonRequestOptions {
  method: "GET";
  accessToken?: string;
  timeoutMs?: number;
}

export interface WwTransport {
  requestEnvelope<T>(path: string, options: WwEnvelopeRequestOptions): Promise<T>;
  requestEnvelopeWithRetry<T>(
    path: string,
    options: WwRetryRequestOptions,
    mapResponse: (input: unknown) => T,
  ): Promise<T>;
  requestJson<T>(path: string, options: WwJsonRequestOptions, mapResponse: (input: unknown) => T): Promise<T>;
}

interface WwEnvelopeResponse<T> {
  data: T;
  diagnostic: DiagnosticHttpResponseAttempt;
}

export function createWwTransport(baseUrl: string, requestTimeoutMs: number | undefined): WwTransport {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedRequestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
  return {
    requestEnvelope(path, options) {
      return requestWwEnvelope(normalizedBaseUrl, path, {
        ...options,
        timeoutMs: options.timeoutMs ?? normalizedRequestTimeoutMs,
      });
    },
    requestEnvelopeWithRetry(path, options, mapResponse) {
      return requestWwEnvelopeWithRetry(
        normalizedBaseUrl,
        path,
        {
          ...options,
          timeoutMs: options.timeoutMs ?? normalizedRequestTimeoutMs,
        },
        mapResponse,
      );
    },
    requestJson(path, options, mapResponse) {
      return requestWwJson(
        normalizedBaseUrl,
        path,
        {
          ...options,
          timeoutMs: options.timeoutMs ?? normalizedRequestTimeoutMs,
        },
        mapResponse,
      );
    },
  };
}

export function wwDiagnosticFacts(error: unknown): DiagnosticFacts | undefined {
  const attempts = responseDiagnosticsForError(error)?.attempts;
  if (!attempts?.length) return undefined;
  const latest = attempts[attempts.length - 1];
  return sanitizeDiagnosticFacts({
    attemptCount: attempts.length,
    ...(latest?.httpStatus !== undefined ? { httpStatus: latest.httpStatus } : {}),
    ...(latest?.upstreamRequestId ? { upstreamRequestId: latest.upstreamRequestId } : {}),
    httpResponses: attempts,
  });
}

async function requestWwEnvelope<T>(baseUrl: string, path: string, options: WwEnvelopeRequestOptions): Promise<T> {
  return (await requestWwEnvelopeResponse<T>(baseUrl, path, options)).data;
}

async function requestWwEnvelopeResponse<T>(
  baseUrl: string,
  path: string,
  options: WwEnvelopeRequestOptions,
): Promise<WwEnvelopeResponse<T>> {
  const request = {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  } satisfies RequestInit;
  const controller = options.timeoutMs === undefined ? undefined : new AbortController();
  const timeoutError = new Error("ww_request_timeout");
  const timeout = controller ? setTimeout(() => controller.abort(timeoutError), options.timeoutMs) : undefined;
  let responseReceived = false;
  try {
    const response = await fetch(withBasePath(baseUrl, path), {
      ...request,
      signal: controller?.signal,
    });
    responseReceived = true;
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (controller?.signal.aborted) throw error;
      if (!response.ok) {
        throw attachResponseDiagnostics(
          mapWwError(response.status, undefined, parseRetryAfter(response.headers.get("Retry-After"))),
          [buildHttpResponseDiagnostic(response, undefined, options.method, path, "invalid_json")],
        );
      }
      if (options.throwOnInvalidJson) {
        throw attachResponseDiagnostics(error, [
          buildHttpResponseDiagnostic(response, undefined, options.method, path, "invalid_json"),
        ]);
      }
      body = undefined;
    }
    if (response.ok) {
      return {
        data: record(body).data as T,
        diagnostic: buildHttpResponseDiagnostic(response, body, options.method, path),
      };
    }
    const envelope = record(body);
    throw attachResponseDiagnostics(
      mapWwError(
        response.status,
        envelope.error,
        parseRetryAfter(response.headers.get("Retry-After")),
        stringValue(envelope.request_id) || undefined,
      ),
      [buildHttpResponseDiagnostic(response, body, options.method, path, "http_error")],
    );
  } catch (error) {
    if (controller?.signal.aborted) {
      throw attachResponseDiagnostics(timeoutError, [
        {
          attempt: 1,
          method: options.method,
          endpoint: path,
          envelopeKind: "unavailable",
          dataKind: "unavailable",
          validationCode: "request_timeout",
        },
      ]);
    }
    if (responseDiagnosticsForError(error)) throw error;
    throw attachResponseDiagnostics(error, [
      {
        attempt: 1,
        method: options.method,
        endpoint: path,
        envelopeKind: "unavailable",
        dataKind: "unavailable",
        validationCode: responseReceived ? "response_read_failed" : "request_failed",
      },
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requestWwEnvelopeWithRetry<T>(
  baseUrl: string,
  path: string,
  options: WwRetryRequestOptions,
  mapResponse: (input: unknown) => T,
): Promise<T> {
  const timeoutMs = normalizeRequestTimeoutMs(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const timeoutError = new Error("ww_request_timeout");
  const responseAttempts: DiagnosticHttpResponseAttempt[] = [];
  for (let attempt = 0; attempt < WW_API_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw attachResponseDiagnostics(timeoutError, responseAttempts);
    const attemptsRemaining = WW_API_REQUEST_MAX_ATTEMPTS - attempt;
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining));
    try {
      const response = await requestWwEnvelopeResponse<unknown>(baseUrl, path, {
        ...options,
        timeoutMs: attemptTimeoutMs,
        throwOnInvalidJson: true,
      });
      try {
        return mapResponse(response.data);
      } catch (error) {
        const mappingError = responseMappingError(error);
        throw attachResponseDiagnostics(error, [
          {
            ...response.diagnostic,
            ...(mappingError?.validationCode ? { validationCode: mappingError.validationCode } : {}),
            ...(mappingError?.missingFields?.length ? { missingFields: mappingError.missingFields } : {}),
          },
        ]);
      }
    } catch (error) {
      const currentAttempts = responseDiagnosticsForError(error)?.attempts ?? [];
      responseAttempts.push(...currentAttempts.map((item) => ({ ...item, attempt: attempt + 1 })));
      const isFinalAttempt = attempt === WW_API_REQUEST_MAX_ATTEMPTS - 1;
      if (isFinalAttempt || !isRetryableWwRequestError(error)) {
        throw attachResponseDiagnostics(error, responseAttempts);
      }
      await waitForWwRetry(error, attempt, deadline);
    }
  }
  throw attachResponseDiagnostics(new Error("ww_request_retry_exhausted"), responseAttempts);
}

async function requestWwJson<T>(
  baseUrl: string,
  path: string,
  options: WwJsonRequestOptions,
  mapResponse: (input: unknown) => T,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeRequestTimeoutMs(options.timeoutMs));
  try {
    const response = await fetch(withBasePath(baseUrl, path), {
      method: options.method,
      headers: options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {},
      signal: controller.signal,
    });
    const body = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return undefined;
    });
    if (!response.ok) {
      const envelope = record(body);
      throw mapWwError(
        response.status,
        envelope.error,
        parseRetryAfter(response.headers.get("Retry-After")),
        stringValue(envelope.request_id) || undefined,
      );
    }
    return mapResponse(body);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("ww_request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return WW_API_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("ww_request_timeout_invalid");
  return Math.ceil(value);
}

function isRetryableWwRequestError(error: unknown): boolean {
  if (!isWwApiError(error)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function isWwApiError(error: unknown): error is WwApiError {
  return (
    error instanceof Error &&
    typeof (error as Partial<WwApiError>).status === "number" &&
    typeof (error as Partial<WwApiError>).publicCode === "string"
  );
}

function responseMappingError(error: unknown): WwResponseMappingError | undefined {
  return error instanceof Error && typeof (error as Partial<WwResponseMappingError>).validationCode === "string"
    ? (error as WwResponseMappingError)
    : undefined;
}

function responseDiagnosticsForError(error: unknown): WwResponseDiagnostics | undefined {
  if (!(error instanceof Error)) return undefined;
  const diagnostics = (error as Error & { responseDiagnostics?: unknown }).responseDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return undefined;
  const attempts = (diagnostics as { attempts?: unknown }).attempts;
  return Array.isArray(attempts) ? { attempts: attempts as DiagnosticHttpResponseAttempt[] } : undefined;
}

function attachResponseDiagnostics(error: unknown, attempts: DiagnosticHttpResponseAttempt[]): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(target, "responseDiagnostics", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: { attempts },
  });
  return target;
}

function buildHttpResponseDiagnostic(
  response: Response,
  body: unknown,
  method: WwRequestMethod,
  endpoint: string,
  validationCode?: string,
): DiagnosticHttpResponseAttempt {
  const envelope =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const data = envelope && Object.hasOwn(envelope, "data") ? envelope.data : undefined;
  const requestId = envelope ? stringValue(envelope.request_id) || stringValue(record(envelope.error).request_id) : "";
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return {
    attempt: 1,
    method,
    endpoint,
    httpStatus: response.status,
    ...(requestId ? { upstreamRequestId: requestId } : {}),
    ...(contentType ? { contentType } : {}),
    envelopeKind: validationCode === "invalid_json" ? "invalid-json" : jsonKind(body),
    ...(envelope ? { envelopeFields: fieldKinds(envelope) } : {}),
    dataKind:
      validationCode === "invalid_json"
        ? "unavailable"
        : envelope && Object.hasOwn(envelope, "data")
          ? jsonKind(data)
          : "missing",
    ...(data && typeof data === "object" && !Array.isArray(data)
      ? { dataFields: fieldKinds(data as Record<string, unknown>) }
      : {}),
    ...(Array.isArray(data) ? arrayShape(data) : {}),
    ...(validationCode ? { validationCode } : {}),
  };
}

function jsonKind(value: unknown): DiagnosticJsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "object":
      return "object";
    case "string":
      return "string";
    default:
      return "missing";
  }
}

function fieldKinds(value: Record<string, unknown>): Record<string, DiagnosticJsonKind> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .slice(0, 64)
      .map((key) => [key, jsonKind(value[key])]),
  );
}

function arrayShape(
  value: unknown[],
): Pick<DiagnosticHttpResponseAttempt, "dataItemCount" | "dataItemKinds" | "dataItemFields"> {
  const sample = value.slice(0, 20);
  const dataItemKinds = [...new Set(sample.map(jsonKind))].sort();
  const objectItems = sample.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  const keys = [...new Set(objectItems.flatMap((item) => Object.keys(item)))].sort().slice(0, 64);
  const dataItemFields = Object.fromEntries(
    keys.map((key) => {
      const kinds = objectItems.map((item) => (Object.hasOwn(item, key) ? jsonKind(item[key]) : "missing"));
      return [key, [...new Set(kinds)].sort().join("|")];
    }),
  );
  return {
    dataItemCount: value.length,
    ...(dataItemKinds.length > 0 ? { dataItemKinds } : {}),
    ...(keys.length > 0 ? { dataItemFields } : {}),
  };
}

async function waitForWwRetry(error: unknown, attempt: number, deadline: number): Promise<void> {
  const retryAfterMs = isWwApiError(error) && error.retryAfter !== undefined ? error.retryAfter * 1_000 : undefined;
  const requestedDelayMs = retryAfterMs ?? WW_API_REQUEST_RETRY_DELAYS_MS[attempt] ?? 0;
  const remainingMs = Math.max(0, deadline - Date.now());
  const delayMs = Math.min(requestedDelayMs, Math.floor(remainingMs / 2));
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function mapWwError(
  status: number,
  input: unknown,
  retryAfter: number | undefined,
  envelopeRequestId?: string,
): WwApiError {
  const error = record(input);
  const code = numberValue(error.code);
  const mapped = publicErrorForCode(code, status);
  const result = new Error(mapped.publicCode) as WwApiError;
  result.status = mapped.status;
  result.code = code;
  result.publicCode = mapped.publicCode;
  result.requestId = stringValue(error.request_id) || envelopeRequestId;
  result.retryAfter = retryAfter;
  return result;
}

function publicErrorForCode(code: number | undefined, status: number): { status: number; publicCode: string } {
  if (code === 110101) return { status: 401, publicCode: "verification_code_invalid" };
  if (code === 100002) return { status: 429, publicCode: "rate_limited" };
  if (code === 100005) return { status: 409, publicCode: "idempotency_conflict" };
  if (code === 110301) return { status: 403, publicCode: "user_disabled" };
  if (code === 110601) return { status: 403, publicCode: "invite_code_required" };
  if (code === 110602) return { status: 403, publicCode: "invite_code_invalid" };
  if (code === 110605) return { status: 400, publicCode: "country_code_required" };
  if (code === 110606) return { status: 400, publicCode: "country_code_invalid" };
  if (code === 110202) return { status: 401, publicCode: "refresh_token_invalid" };
  if (code === 110203) return { status: 401, publicCode: "api_key_invalid" };
  if (code === 110201) return { status: 401, publicCode: "access_token_invalid" };
  return { status, publicCode: "auth_unavailable" };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function withBasePath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
