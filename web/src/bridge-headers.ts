import { APP_BRIDGE_TOKEN_HEADER, APP_STORAGE_KEYS } from "./identity";

export function bridgeHeaders(includeContentType = true): HeadersInit {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["content-type"] = "application/json";
  const token = localStorage.getItem(APP_STORAGE_KEYS.bridgeToken);
  if (token) headers[APP_BRIDGE_TOKEN_HEADER] = token;
  return headers;
}
