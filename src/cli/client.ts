import { createOpenGroveClient, type OpenGroveClient, type OpenGroveClientConfig } from "#client";
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

  if (config.baseUrlSource !== "default" && !isLoopbackApiUrl(config.baseUrl)) {
    if (hasStoredSession && !config.token) {
      throw new OpenGroveCliError(
        "authentication",
        "bridge_url_not_local",
        "Stored CLI account credentials can only be sent to a local OpenGrove Bridge.",
      );
    }
    return createOpenGroveClient({
      baseUrl: config.baseUrl,
      fetch: config.fetch,
      headers: config.headers,
      credentials: config.credentials,
    });
  }

  const connection = await resolveCliBridge({
    baseUrl: config.baseUrl,
    baseUrlSource: config.baseUrlSource,
    ...(stored?.bridgeApiUrl ? { savedApiUrl: stored.bridgeApiUrl } : {}),
    ...(hasStoredSession ? { expectedStateId: stored.stateId } : {}),
    fetch: config.fetch,
  });
  const auth = hasStoredSession
    ? createPersistedCliAuthSession({ ...stored, bridgeApiUrl: connection.apiUrl }, config.authPath)
    : undefined;

  return createOpenGroveClient({
    baseUrl: connection.apiUrl,
    fetch: config.fetch,
    headers: config.headers,
    credentials: config.credentials,
    auth,
  });
}
