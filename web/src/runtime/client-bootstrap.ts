import { clientBootstrapContract, type ClientBootstrap } from "@opengrove/agent-protocol";
import type { DesktopBridgeStartupState } from "../../../src/desktop-bridge-startup-state";
import { apiUrl } from "../api-base";
import { readDesktopApi, readDesktopBridgeStartupState, type OpenGroveDesktopApi } from "../desktop-api";
import { translate } from "../i18n";

let bootstrap: ClientBootstrap | undefined;

export async function loadClientBootstrap(): Promise<ClientBootstrap> {
  return requestClientBootstrap(apiUrl("/bootstrap"));
}

async function requestClientBootstrap(url: string): Promise<ClientBootstrap> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(translate("runtime.bootstrapRequestFailed", { status: response.status }));
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(translate("runtime.bootstrapIncompatible"));
  }
  const parsed = clientBootstrapContract.response.safeParse(body);
  if (!parsed.success) {
    throw new Error(translate("runtime.bootstrapIncompatible"));
  }
  bootstrap = parsed.data;
  return parsed.data;
}

export async function loadClientBootstrapForRuntime(
  desktopApi: OpenGroveDesktopApi | undefined = readDesktopApi(),
): Promise<ClientBootstrap> {
  if (desktopApi) {
    await waitForDesktopBridgeReady(desktopApi);
    return requestClientBootstrap(new URL("bootstrap", ensureTrailingSlash(desktopApi.apiBase)).toString());
  }
  return loadClientBootstrap();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
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
