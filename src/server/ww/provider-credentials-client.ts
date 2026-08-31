import { record, stringValue } from "../http-utils.js";
import type { WwTransport } from "./transport.js";
import type { WwApiKeySummary, WwCreatedApiKey, WwProviderCredentialsClient, WwResponseMappingError } from "./types.js";

export function createWwProviderCredentialsClient(transport: WwTransport): WwProviderCredentialsClient {
  return {
    async createApiKey(accessToken, name, options) {
      const idempotencyKey = options.idempotencyKey.trim();
      if (!idempotencyKey) throw new Error("ww_idempotency_key_required");
      return transport.requestEnvelopeWithRetry<WwCreatedApiKey>(
        "/v1/api-keys",
        {
          method: "POST",
          accessToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { name },
          timeoutMs: options.timeoutMs,
        },
        mapCreatedApiKey,
      );
    },
    async listApiKeys(accessToken, options = {}) {
      return transport.requestEnvelopeWithRetry<WwApiKeySummary[]>(
        "/v1/api-keys",
        {
          method: "GET",
          accessToken,
          timeoutMs: options.timeoutMs,
        },
        mapApiKeyList,
      );
    },
  };
}

function mapCreatedApiKey(input: unknown): WwCreatedApiKey {
  const object = record(input);
  const summary = mapApiKeySummary(object);
  const apiKey = stringValue(object.api_key).trim();
  if (!apiKey) throw invalidApiKeyResponse("missing_required_fields", ["api_key"]);
  if (summary.status !== "active") throw invalidApiKeyResponse("created_key_not_active");
  return { ...summary, apiKey };
}

function mapApiKeySummary(input: unknown): WwApiKeySummary {
  const object = record(input);
  const id = stringValue(object.id).trim();
  const name = stringValue(object.name).trim();
  const keyPrefix = stringValue(object.key_prefix).trim();
  const status = stringValue(object.status).trim();
  const expiresAt = stringValue(object.expires_at).trim();
  const missingFields = [
    ...(!id ? ["id"] : []),
    ...(!name ? ["name"] : []),
    ...(!keyPrefix ? ["key_prefix"] : []),
    ...(!status ? ["status"] : []),
  ];
  if (missingFields.length > 0) throw invalidApiKeyResponse("missing_required_fields", missingFields);
  return {
    id,
    name,
    keyPrefix,
    status,
    ...(expiresAt ? { expiresAt } : {}),
    createdAt: stringValue(object.created_at) || undefined,
  };
}

function mapApiKeyList(input: unknown): WwApiKeySummary[] {
  // WW currently returns data:null when the account has no API keys. Treat
  // that collection-specific representation as empty without weakening the
  // validation for missing data or other malformed response shapes.
  if (input === null) return [];
  if (!Array.isArray(input)) throw invalidApiKeyResponse("expected_data_array");
  return input.map(mapApiKeySummary);
}

function invalidApiKeyResponse(validationCode: string, missingFields: string[] = []): WwResponseMappingError {
  const error = new Error("ww_api_key_response_invalid") as WwResponseMappingError;
  error.validationCode = validationCode;
  if (missingFields.length > 0) error.missingFields = missingFields;
  return error;
}
