import type { ClientBootstrap } from "@opengrove/protocol";
import { createOpenGroveClient, OpenGroveClientError, OpenGroveProtocolError } from "@opengrove/client";
import type { DesktopBridgeStartupState } from "../../../src/desktop-bridge-startup-state";
import { apiUrl } from "../api-base";
import { readDesktopApi, readDesktopBridgeStartupState, type OpenGroveDesktopApi } from "../desktop-api";
import { translate } from "../i18n";

let bootstrap: ClientBootstrap | undefined;

export async function loadClientBootstrap(): Promise<ClientBootstrap> {
  return requestClientBootstrap(apiUrl("/"));
}

async function requestClientBootstrap(baseUrl: string): Promise<ClientBootstrap> {
  const client = createOpenGroveClient({ baseUrl, credentials: "include" });
  try {
    bootstrap = await client.host.discovery.bootstrap();
    return bootstrap;
  } catch (error) {
    if (error instanceof OpenGroveClientError) {
      throw new Error(translate("runtime.bootstrapRequestFailed", { status: error.status }), { cause: error });
    }
    if (error instanceof OpenGroveProtocolError) {
      throw new Error(translate("runtime.bootstrapIncompatible"), { cause: error });
    }
    throw error;
  }
}

export async function loadClientBootstrapForRuntime(
  desktopApi: OpenGroveDesktopApi | undefined = readDesktopApi(),
): Promise<ClientBootstrap> {
  if (desktopApi) {
    await waitForDesktopBridgeReady(desktopApi);
    return requestClientBootstrap(desktopApi.apiBase);
  }
  return loadClientBootstrap();
}

async function waitForDesktopBridgeReady(
  desktopApi: OpenGroveDesktopApi,
): Promise<Extract<DesktopBridgeStartupState, { stage: "ready" }>> {
  const initialState = readDesktopBridgeStartupState(desktopApi);
  if (initialState?.stage === "ready") return initialState;
  if (!desktopApi.onBridgeStartupStateChange) {
    throw new Error("desktop_bridge_startup_state_unavailable");
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const onStateChange = (state: DesktopBridgeStartupState) => {
      if (state.stage !== "ready" || settled) return;
      settled = true;
      resolve(state);
      unsubscribe?.();
    };
    unsubscribe = desktopApi.onBridgeStartupStateChange?.(onStateChange);
    if (settled) unsubscribe?.();
  });
}

export function getClientBootstrap(): ClientBootstrap {
  if (!bootstrap) throw new Error(translate("runtime.bootstrapNotLoaded"));
  return bootstrap;
}
