import {
  bridgeContractIssues,
  type HostOperation,
  type HostOperationBody,
  type HostOperationDecodedInput,
  type HostOperationOutput,
  type HostOperationParams,
  type HostOperationQuery,
} from "#protocol";
import type { OpenGroveAuthSession } from "./auth.js";
import { OpenGroveClientError, OpenGroveProtocolError } from "./errors.js";

export type OpenGroveClientConfig = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  auth?: OpenGroveAuthSession;
};

export type OpenGroveRequestOptions = {
  signal?: AbortSignal;
};

export type HostOperationCall<TOperation extends HostOperation> = { signal?: AbortSignal } & (TOperation extends {
  params: HostOperation["params"];
}
  ? { params: HostOperationParams<TOperation> }
  : { params?: never }) &
  (TOperation extends { query: HostOperation["query"] }
    ? { query: HostOperationQuery<TOperation> }
    : { query?: never }) &
  (TOperation extends { body: HostOperation["body"] } ? { body: HostOperationBody<TOperation> } : { body?: never });

export type HostOperationRequest = <TOperation extends HostOperation>(
  operation: TOperation,
  input: HostOperationCall<TOperation>,
) => Promise<HostOperationOutput<TOperation>>;

type ValidatedHostOperationCall<TOperation extends HostOperation> = HostOperationDecodedInput<TOperation> &
  Readonly<{ signal?: AbortSignal }>;

export function createHostOperationRequest(config: OpenGroveClientConfig): HostOperationRequest {
  if (!config.fetch && !globalThis.fetch) {
    throw new Error("OpenGrove Client requires a Fetch API implementation.");
  }

  return async <TOperation extends HostOperation>(
    operation: TOperation,
    input: HostOperationCall<TOperation>,
  ): Promise<HostOperationOutput<TOperation>> => {
    const fetchImplementation = config.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImplementation) throw new Error("OpenGrove Client requires a Fetch API implementation.");
    const validated = validateHostOperationCall(operation, input);
    const response = await fetchImplementation(
      resolveOperationUrl(config.baseUrl, operation, validated.params, validated.query),
      {
        method: operation.method,
        headers: await resolveHeaders(config.headers, config.auth, operation.body !== undefined),
        credentials: config.credentials,
        cache: "no-store",
        signal: input.signal,
        ...(operation.body ? { body: JSON.stringify(validated.body) } : {}),
      },
    );
    await config.auth?.updateFromResponse(response);
    const payload = await readResponsePayload(response);
    if (response.status === operation.success.status) {
      try {
        return parseOperationResponse(operation, operation.success.body, payload) as HostOperationOutput<TOperation>;
      } catch (error) {
        if (error instanceof OpenGroveProtocolError && isBusinessFailure(payload)) {
          throw createClientError(response, payload, false);
        }
        throw error;
      }
    }

    const declaredError = operation.errors?.find((candidate) => candidate.status === response.status);
    const errorPayload = declaredError?.body ? parseOperationResponse(operation, declaredError.body, payload) : payload;
    throw createClientError(response, errorPayload, Boolean(declaredError));
  };
}

function validateHostOperationCall<TOperation extends HostOperation>(
  operation: TOperation,
  input: HostOperationCall<TOperation>,
): ValidatedHostOperationCall<TOperation> {
  const validated: Record<string, unknown> = { signal: input.signal };
  if (operation.params) validated.params = parseRequestPart(operation, "params", operation.params, input.params);
  if (operation.query) validated.query = parseRequestPart(operation, "query", operation.query, input.query);
  if (operation.body) validated.body = parseRequestPart(operation, "body", operation.body, input.body);
  return validated as ValidatedHostOperationCall<TOperation>;
}

function parseRequestPart(
  operation: HostOperation,
  name: "params" | "query" | "body",
  schema: HostOperation["params"] | HostOperation["query"] | HostOperation["body"],
  value: unknown,
): unknown {
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = bridgeContractIssues(parsed.error).map((issue) => ({
      ...issue,
      path: issue.path === "$" ? name : `${name}.${issue.path}`,
    }));
    throw new OpenGroveProtocolError("request", operation.id, issues);
  }
  return parsed.data;
}

function parseOperationResponse(
  operation: HostOperation,
  schema: HostOperation["success"]["body"],
  value: unknown,
): unknown {
  if (!schema) {
    if (value !== undefined) {
      throw new OpenGroveProtocolError("response", operation.id, [{ path: "$", code: "unexpected_response_body" }]);
    }
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpenGroveProtocolError("response", operation.id, bridgeContractIssues(parsed.error));
  }
  return parsed.data;
}

function resolveOperationUrl(
  baseUrl: string | undefined,
  operation: HostOperation,
  params: unknown,
  query: unknown,
): string {
  const parameterRecord = isRecord(params) ? params : {};
  const path = operation.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = parameterRecord[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new OpenGroveProtocolError("request", operation.id, [
        { path: `params.${name}`, code: "path_parameter_missing" },
      ]);
    }
    return encodeURIComponent(String(value));
  });
  const queryRecord = isRecord(query) ? query : {};
  const encodedQuery = Object.entries(queryRecord).flatMap(([name, value]) => {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => `${encodeURIComponent(name)}=${encodeURIComponent(parameterValue(item))}`);
  });
  const resolvedPath = encodedQuery.length ? `${path}${path.includes("?") ? "&" : "?"}${encodedQuery.join("&")}` : path;
  if (!baseUrl) return resolvedPath;
  return `${baseUrl.replace(/\/+$/u, "")}/${resolvedPath.replace(/^\/+/, "")}`;
}

function parameterValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  return JSON.stringify(value);
}

async function resolveHeaders(
  configured: OpenGroveClientConfig["headers"],
  auth: OpenGroveAuthSession | undefined,
  includeContentType: boolean,
): Promise<Headers> {
  const initial = typeof configured === "function" ? await configured() : configured;
  const headers = new Headers(initial);
  const authHeaders = new Headers(await auth?.requestHeaders());
  authHeaders.forEach((value, name) => headers.set(name, value));
  if (includeContentType && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  return decodeResponsePayload(text);
}

function decodeResponsePayload(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function createClientError(response: Response, payload: unknown, declared: boolean): OpenGroveClientError {
  const record = isRecord(payload) ? payload : undefined;
  const nestedError = isRecord(record?.error) ? record.error : undefined;
  const code = readString(record?.code) ?? readString(nestedError?.code);
  const message =
    readString(record?.error) ??
    readString(nestedError?.message) ??
    readString(record?.message) ??
    code ??
    (typeof payload === "string" && payload ? payload : `request_failed:${response.status}`);
  return new OpenGroveClientError(message, {
    status: response.status,
    code,
    declared,
    traceId:
      readString(record?.traceId) ??
      readString(record?.trace_id) ??
      response.headers.get("x-opengrove-trace-id") ??
      undefined,
    payload,
  });
}

function isBusinessFailure(payload: unknown): boolean {
  return isRecord(payload) && payload.ok === false && (typeof payload.error === "string" || isRecord(payload.error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
