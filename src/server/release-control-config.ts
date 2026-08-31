import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeAppStoreRegistryUrl } from "../app-store-package-identity.js";
import { APP_DEFAULT_RELEASE_CONTROL_URL, readAppEnv } from "../identity.js";
import { readWwRuntimeAuth, type BridgeSecurity } from "./bridge-security.js";
import type { BridgeState } from "./bridge-types.js";

export interface ReleaseControlConfig {
  baseUrl: string;
  accessToken: string;
}

export function readReleaseControlBaseUrl(): string {
  return (
    normalizeAppStoreRegistryUrl(readAppEnv("RELEASE_CONTROL_URL") || APP_DEFAULT_RELEASE_CONTROL_URL) ??
    APP_DEFAULT_RELEASE_CONTROL_URL
  );
}

export async function resolveReleaseControlConfig(
  state: BridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  security?: BridgeSecurity,
): Promise<ReleaseControlConfig | undefined> {
  if (!security?.wwBaseUrl) {
    const configuredToken = state.settings.appStore?.registryToken;
    return state.settings.appStore?.releaseControlUrl && configuredToken
      ? {
          // Embedded harnesses may supply an explicit non-session credential.
          // A WW session token must never be paired with this user-writable URL.
          baseUrl:
            normalizeAppStoreRegistryUrl(state.settings.appStore.releaseControlUrl) ?? APP_DEFAULT_RELEASE_CONTROL_URL,
          accessToken: configuredToken,
        }
      : undefined;
  }
  const session = await readWwRuntimeAuth(request, response, security);
  if (!session?.auth.accessToken) return undefined;
  return {
    baseUrl: readReleaseControlBaseUrl(),
    accessToken: session.auth.accessToken,
  };
}
