import { readAppEnv } from "../../identity.js";
import { createWwAccountClient } from "./account-client.js";
import { createWwClientActivityClient } from "./client-activity-client.js";
import { createWwClientUpdateClient } from "./client-update-client.js";
import { createWwProfileClient } from "./profile-client.js";
import { createWwProviderCredentialsClient } from "./provider-credentials-client.js";
import { createWwTransport } from "./transport.js";
import type { WwHostedServices, WwHostedServicesOptions } from "./types.js";

export function readWwBaseUrl(): string | undefined {
  return readAppEnv("WW_BASE_URL")?.trim() || undefined;
}

// WW_TEAM_TOKEN_HEADER matches internal/teamauth in the ww repository. A header
// rather than a cookie because that is how every ww credential travels, and
// because this transport has no cookie store to hold one anyway.
export const WW_TEAM_TOKEN_HEADER = "X-Team-Token";

export function createWwHostedServices(baseUrl: string, options: WwHostedServicesOptions = {}): WwHostedServices {
  const teamToken = options.teamToken?.trim();
  const transport = createWwTransport(
    baseUrl,
    options.requestTimeoutMs,
    teamToken ? { [WW_TEAM_TOKEN_HEADER]: teamToken } : {},
  );
  return {
    account: createWwAccountClient(transport),
    profile: createWwProfileClient(transport),
    clientActivity: createWwClientActivityClient(transport),
    providerCredentials: createWwProviderCredentialsClient(transport),
    clientUpdates: createWwClientUpdateClient(transport),
  };
}
