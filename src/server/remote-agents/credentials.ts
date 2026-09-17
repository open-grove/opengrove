import { AgentRouterError } from "@agent-router/sdk";
import { z } from "zod";
import { createWwTransport, isWwApiError } from "../ww/transport.js";

const nativeSession = z.object({
  serviceUrl: z.string(),
  homeserverUrl: z.string(),
  accessToken: z.string().min(1).max(8192),
  expiresAt: z.string(),
  owner: z.string().min(1),
  agent: z.object({
    id: z.string().min(1),
    owner: z.string().min(1),
    name: z.literal("client"),
    address: z.string().min(1),
    matrixId: z.string().min(1),
  }),
});
export type NativeNetworkSession = z.infer<typeof nativeSession>;

export function credentialServiceUrl(raw: string, allowLocalHTTP = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentRouterError("remote_authorization_unavailable", 503);
  }
  if (
    url.username ||
    url.password ||
    /[?#]/.test(raw) ||
    (url.protocol !== "https:" && !(allowLocalHTTP && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new AgentRouterError("remote_authorization_unavailable", 503);
  return url;
}

/** Only WW receives OAuth. Router receives an existing native Matrix credential. */
export async function issueNetworkSession(input: {
  accountIssuer: string;
  serviceUrl: string;
  accessToken: string;
  signal: AbortSignal;
  allowLocalHTTP?: boolean;
  fetch?: typeof fetch;
  now?: number;
}): Promise<NativeNetworkSession> {
  const issuer = credentialServiceUrl(input.accountIssuer, input.allowLocalHTTP).toString().replace(/\/$/, "");
  let payload: unknown;
  try {
    payload = await createWwTransport(issuer, 15_000).requestJson(
      "/v1/network/sessions",
      {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        accessToken: input.accessToken,
        body: { serviceUrl: input.serviceUrl },
        signal: input.signal,
        fetch: input.fetch,
      },
      (body) => body,
    );
  } catch (error) {
    input.signal.throwIfAborted();
    const status = isWwApiError(error) ? error.status : 503;
    const code =
      status === 401
        ? "remote_oauth_required"
        : status === 403
          ? "remote_authorization_required"
          : "remote_session_unavailable";
    throw Object.assign(new AgentRouterError(code, status === 401 ? 403 : status), { cause: error });
  }
  const parsed = nativeSession.safeParse(payload);
  if (!parsed.success) throw new AgentRouterError("invalid_response");
  const session = parsed.data;
  credentialServiceUrl(session.homeserverUrl, input.allowLocalHTTP);
  if (
    session.serviceUrl !== input.serviceUrl ||
    session.owner !== session.agent.owner ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) > (input.now ?? Date.now()) + 125_000
  )
    throw new AgentRouterError("invalid_response");
  return session;
}

export async function revokeNetworkSession(session: NativeNetworkSession, fetcher = fetch): Promise<void> {
  try {
    const response = await fetcher(`${session.homeserverUrl}/_matrix/client/v3/logout`, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "content-type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok && response.status !== 401) console.warn("remote_session_revocation_unavailable");
  } catch {
    console.warn("remote_session_revocation_unavailable");
  }
}
