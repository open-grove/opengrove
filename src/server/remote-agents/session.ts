import { AgentRouterError } from "@agent-router/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readAppEnv } from "../../identity.js";
import type { RemoteAgentBinding } from "../../rooms/remote-agent.js";
import {
  authSessionFingerprint,
  bridgeSessionUserHasRole,
  readAuthTokens,
  resolveWwRuntimeAuth,
  type BridgeRuntimeAuthSession,
  type BridgeSecurity,
} from "../bridge-security.js";
import type { BridgeState } from "../bridge-types.js";
import { readWwProviderLocalState, wwProviderAccountMatches } from "../ww-provider-local-state.js";
import { AgentNetworkSessions, type NetworkConnection } from "./client.js";

const sessions = new WeakMap<BridgeState, AgentNetworkSessions>();
const generations = new WeakMap<BridgeState, number>();
const authorizedSessions = new WeakMap<BridgeState, Set<string>>();

/** Issued only after product authorization; object identity prevents reconstruction from request or ledger data. */
export interface NetworkRunAuthorization {
  readonly accountIssuer: string;
  readonly accountUserId: string;
}
const runAuthorizations = new WeakMap<NetworkRunAuthorization, { state: BridgeState; generation: number }>();

function issueNetworkRunAuthorization(state: BridgeState, session: BridgeRuntimeAuthSession): NetworkRunAuthorization {
  const authorization = Object.freeze({ accountIssuer: session.auth.baseUrl, accountUserId: session.auth.userId });
  runAuthorizations.set(authorization, { state, generation: networkSessionsFor(state).generation });
  return authorization;
}

export function assertNetworkRunAuthorized(
  state: BridgeState,
  authorization: NetworkRunAuthorization | undefined,
  binding?: RemoteAgentBinding,
): void {
  const issued = authorization && runAuthorizations.get(authorization);
  if (!issued || issued.state !== state) throw new AgentRouterError("remote_authorization_required", 403);
  if (
    issued.generation !== networkSessionsFor(state).generation ||
    (binding &&
      (binding.accountIssuer !== authorization.accountIssuer || binding.accountUserId !== authorization.accountUserId))
  )
    throw new AgentRouterError("remote_account_changed", 409);
}

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
  generations.set(state, networkSessionGeneration(state) + 1);
  authorizedSessions.delete(state);
  await sessions.get(state)?.clear(reason);
}

/** Logout clears only communication state authorized by this existing product session. No remote auth lookup. */
export async function clearNetworkSessionForRequest(state: BridgeState, request: IncomingMessage): Promise<void> {
  const fingerprint = authSessionFingerprint(readAuthTokens(request));
  if (fingerprint && authorizedSessions.get(state)?.has(fingerprint)) await clearNetworkSession(state);
}

export function updateNetworkProductSession(
  state: BridgeState,
  session: BridgeRuntimeAuthSession,
  request: IncomingMessage,
  generation?: number,
): NetworkRunAuthorization | undefined {
  if (generation !== undefined && networkSessionGeneration(state) !== generation) return undefined;
  const network =
    sessions.get(state) ?? (readAppEnv("AGENT_ROUTER_URL")?.trim() ? networkSessionsFor(state) : undefined);
  if (!network) return undefined;
  const product = {
    accountIssuer: session.auth.baseUrl,
    accountUserId: session.auth.userId,
    accessToken: session.auth.accessToken,
  };
  if (!network.matches(product) || !isCurrentHostAccount(state, session)) return undefined;
  if (!bridgeSessionUserHasRole(session.user, "admin")) {
    void clearNetworkSession(state, "external_role_required");
    return undefined;
  }
  network.observe({
    accountIssuer: session.auth.baseUrl,
    accountUserId: session.auth.userId,
    accessToken: session.auth.accessToken,
  });
  rememberAuthorizedSession(state, request);
  return issueNetworkRunAuthorization(state, session);
}

export function networkSessionGeneration(state: BridgeState): number {
  return generations.get(state) ?? 0;
}

interface NetworkRouteContext {
  state: BridgeState;
  security?: BridgeSecurity;
  request: IncomingMessage;
  response: ServerResponse;
}

/** Verify product authority without waiting for the Router. A Bridge token alone grants no network authority. */
export async function authorizeNetworkAccount(
  context: NetworkRouteContext,
  options: { generation?: number; forceRefresh?: boolean } = {},
): Promise<NetworkRunAuthorization> {
  const { state, security, request, response } = context;
  if (!security) throw new AgentRouterError("not_authenticated", 401);
  const network = networkSessionsFor(state);
  const generation = options.generation ?? network.generation;
  const auth = await resolveWwRuntimeAuth(request, response, security, { forceRefresh: options.forceRefresh === true });
  if (network.generation !== generation) throw new AgentRouterError("remote_account_changed", 409);
  if (auth.status === "unauthenticated") throw new AgentRouterError("not_authenticated", 401);
  if (auth.status === "temporarily_unavailable" || auth.verification === "stale")
    throw new AgentRouterError("remote_account_unavailable", 503);
  if (
    !isCurrentHostAccount(state, auth.session) ||
    !network.matches({ accountIssuer: auth.session.auth.baseUrl, accountUserId: auth.session.auth.userId })
  )
    throw new AgentRouterError("remote_account_changed", 409);
  if (!bridgeSessionUserHasRole(auth.session.user, "admin")) {
    await clearNetworkSession(state, "external_role_required");
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
  rememberAuthorizedSession(state, request);
  return issueNetworkRunAuthorization(state, auth.session);
}

export async function requireNetworkConnection(
  context: NetworkRouteContext,
  binding?: RemoteAgentBinding,
): Promise<NetworkConnection & { authorization: NetworkRunAuthorization }> {
  if (!context.security) throw new AgentRouterError("not_authenticated", 401);
  const network = networkSessionsFor(context.state);
  const generation = network.generation;
  for (let attempt = 0; ; attempt++) {
    const authorization = await authorizeNetworkAccount(context, { generation, forceRefresh: attempt > 0 });
    try {
      const connection = await network.connect(binding);
      assertNetworkRunAuthorized(context.state, authorization, binding);
      return { ...connection, authorization };
    } catch (error) {
      if (attempt > 0 || !(error instanceof AgentRouterError) || error.code !== "external_session_invalid") throw error;
    }
  }
}

function rememberAuthorizedSession(state: BridgeState, request: IncomingMessage): void {
  const fingerprint = authSessionFingerprint(readAuthTokens(request));
  if (!fingerprint) return;
  let authorized = authorizedSessions.get(state);
  if (!authorized) {
    authorized = new Set();
    authorizedSessions.set(state, authorized);
  }
  authorized.add(fingerprint);
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

function isCurrentHostAccount(state: BridgeState, session: BridgeRuntimeAuthSession): boolean {
  return (
    !readWwProviderLocalState(state).ownerUserId ||
    wwProviderAccountMatches(state, { issuer: session.auth.baseUrl, userId: session.auth.userId })
  );
}
