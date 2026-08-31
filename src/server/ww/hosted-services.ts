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

export function createWwHostedServices(baseUrl: string, options: WwHostedServicesOptions = {}): WwHostedServices {
  const transport = createWwTransport(baseUrl, options.requestTimeoutMs);
  return {
    account: createWwAccountClient(transport),
    profile: createWwProfileClient(transport),
    clientActivity: createWwClientActivityClient(transport),
    providerCredentials: createWwProviderCredentialsClient(transport),
    clientUpdates: createWwClientUpdateClient(transport),
  };
}
