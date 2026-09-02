import { createOpenGroveClient, type OpenGroveClient, type OpenGroveClientConfig } from "#client";
import { APP_BRIDGE_TOKEN_HEADER } from "../identity.js";
import { createPersistedCliAuthSession, hasCliAuthCookies, readCliAuthState } from "./auth-state.js";
import { isLoopbackApiUrl, resolveCliBridge, type CliBridgeBaseUrlSource } from "./bridge-connection.js";
import { OpenGroveCliError } from "./errors.js";

export type CliClientConfig = OpenGroveClientConfig &
  Readonly<{
    baseUrl: string;
    baseUrlSource: CliBridgeBaseUrlSource;
    token?: string;
    authPath?: string;
  }>;

export async function createCliOpenGroveClient(config: CliClientConfig): Promise<OpenGroveClient> {
  const stored = readCliAuthState(config.authPath);
  const hasStoredSession = hasCliAuthCookies(stored);
  const useStoredSession = hasStoredSession && !config.token;
  const headers = withBridgeToken(config.headers, config.token);

  if (config.baseUrlSource !== "default" && !isLoopbackApiUrl(config.baseUrl)) {
    if (useStoredSession) {
      throw new OpenGroveCliError(
        "authentication",
        "bridge_url_not_local",
        "Stored CLI account credentials can only be sent to a local OpenGrove Bridge.",
      );
    }
    return createOpenGroveClient({
      baseUrl: config.baseUrl,
      fetch: config.fetch,
      headers,
      credentials: config.credentials,
    });
  }

  const connection = await resolveCliBridge({
    baseUrl: config.baseUrl,
    baseUrlSource: config.baseUrlSource,
    ...(useStoredSession ? { savedApiUrl: stored.bridgeApiUrl, expectedStateId: stored.stateId } : {}),
    fetch: config.fetch,
  });
  const auth = useStoredSession
    ? createPersistedCliAuthSession({ ...stored, bridgeApiUrl: connection.apiUrl }, config.authPath)
    : undefined;

  return createOpenGroveClient({
    baseUrl: connection.apiUrl,
    fetch: config.fetch,
    headers,
    credentials: config.credentials,
    auth,
  });
}

function withBridgeToken(
  configured: OpenGroveClientConfig["headers"],
  token: string | undefined,
): OpenGroveClientConfig["headers"] {
  if (!token) return configured;
  return async () => {
    const initial = typeof configured === "function" ? await configured() : configured;
    const headers = new Headers(initial);
    headers.set(APP_BRIDGE_TOKEN_HEADER, token);
    return headers;
  };
}
