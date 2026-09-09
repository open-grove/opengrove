import { AgentRouterError } from "@agent-router/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readAppEnv } from "../../identity.js";
import type { RemoteAgentBinding } from "../../rooms/remote-agent.js";
import {
  bridgeSessionUserHasRole,
  resolveWwRuntimeAuth,
  type BridgeRuntimeAuthSession,
  type BridgeSecurity,
} from "../bridge-security.js";
import type { BridgeState } from "../bridge-types.js";
import { AgentNetworkSessions, type NetworkConnection } from "./client.js";

const sessions = new WeakMap<BridgeState, AgentNetworkSessions>();

export function networkSessionsFor(state: BridgeState): AgentNetworkSessions {
  let network = sessions.get(state);
  if (!network) {
    const baseUrl = readAppEnv("AGENT_ROUTER_URL")?.trim();
    if (!baseUrl) throw new AgentRouterError("remote_not_configured", 503);
    network = new AgentNetworkSessions({
      baseUrl,
      provider: readAppEnv("AGENT_ROUTER_PROVIDER")?.trim() || "opengrove",
      allowLocalHTTP: readAppEnv("AGENT_ROUTER_ALLOW_LOCAL_HTTP") === "1",
    });
    sessions.set(state, network);
  }
  return network;
}

export async function clearNetworkSession(state: BridgeState, reason = "not_authenticated"): Promise<void> {
  await sessions.get(state)?.clear(reason);
}

export function updateNetworkProductSession(
  state: BridgeState,
  session: BridgeRuntimeAuthSession,
  generation?: number,
): void {
  const network = sessions.get(state);
  if (!network || (generation !== undefined && network.generation !== generation)) return;
  if (!bridgeSessionUserHasRole(session.user, "admin")) {
    void network.clear("external_role_required");
    return;
  }
  network.observe({
    accountIssuer: session.auth.baseUrl,
    accountUserId: session.auth.userId,
    accessToken: session.auth.accessToken,
  });
}

export function networkSessionGeneration(state: BridgeState): number | undefined {
  return sessions.get(state)?.generation;
}

interface NetworkRouteContext {
  state: BridgeState;
  security?: BridgeSecurity;
  request: IncomingMessage;
  response: ServerResponse;
}

/** A desktop Bridge token alone never grants communication-account authority. */
export async function requireNetworkConnection(
  context: NetworkRouteContext,
  binding?: RemoteAgentBinding,
): Promise<NetworkConnection> {
  const { state, security, request, response } = context;
  if (!security) throw new AgentRouterError("not_authenticated", 401);
  const network = networkSessionsFor(state);
  const generation = network.generation;
  for (let attempt = 0; ; attempt++) {
    const auth = await resolveWwRuntimeAuth(request, response, security, { forceRefresh: attempt > 0 });
    if (network.generation !== generation) throw new AgentRouterError("remote_account_changed", 409);
    if (auth.status === "unauthenticated") throw new AgentRouterError("not_authenticated", 401);
    if (auth.status === "temporarily_unavailable" || auth.verification === "stale")
      throw new AgentRouterError("remote_account_unavailable", 503);
    if (!bridgeSessionUserHasRole(auth.session.user, "admin")) {
      await network.clear("external_role_required");
      throw new AgentRouterError("external_role_required", 403);
    }
    network.observe(
      {
        accountIssuer: auth.session.auth.baseUrl,
        accountUserId: auth.session.auth.userId,
        accessToken: auth.session.auth.accessToken,
      },
      generation,
    );
    try {
      return await network.connect(binding);
    } catch (error) {
      if (attempt > 0 || !(error instanceof AgentRouterError) || error.code !== "external_session_invalid") throw error;
    }
  }
}

export function networkProblem(error: unknown): { error: string; status: number } {
  if (error instanceof AgentRouterError) {
    return { error: error.code, status: [400, 401, 403, 409].includes(error.status) ? error.status : 503 };
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return { error: "remote_connection_unavailable", status: 503 };
  console.warn("remote_unexpected_error", error instanceof Error ? error.name : "unknown");
  return { error: "invalid_response", status: 503 };
}
