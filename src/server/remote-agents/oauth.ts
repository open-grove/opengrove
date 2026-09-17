import { AgentRouterError } from "@agent-router/sdk";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as oidc from "openid-client";

export interface RouterAccountIdentity {
  accountIssuer: string;
  accountUserId: string;
}
interface Grant {
  config: oidc.Configuration;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
interface Attempt {
  url: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  state: string;
}

/** Native authorization: primary login credentials are deliberately absent from this interface. */
export class RouterOAuth {
  private grant?: Grant;
  private attempt?: Attempt;
  private starting?: Promise<string>;
  private renewing?: Promise<string>;
  private failure?: AgentRouterError;
  private revision = 0;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly account: RouterAccountIdentity,
    private readonly resource: string,
    private readonly allowLocalHTTP = false,
  ) {}

  private url(raw: string): URL {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      /[?#]/.test(raw) ||
      (url.protocol !== "https:" && !(this.allowLocalHTTP && url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new AgentRouterError("remote_authorization_unavailable", 503);
    return url;
  }
  private stopAttempt(): void {
    if (!this.attempt) return;
    clearTimeout(this.attempt.timer);
    this.attempt.server.close();
    this.attempt.server.closeAllConnections();
    this.attempt = undefined;
  }
  private async revoke(grant: Grant): Promise<void> {
    try {
      await oidc.tokenRevocation(grant.config, grant.refreshToken ?? grant.accessToken);
    } catch {
      console.warn("remote_authorization_revocation_unavailable");
    }
  }
  invalidate(): void {
    const grant = this.grant;
    this.grant = undefined;
    if (grant) void this.revoke(grant);
  }
  cancel(): void {
    this.revision++;
    this.stopAttempt();
  }
  clear(): void {
    this.lifetime.abort();
    this.cancel();
    const grant = this.grant;
    this.grant = undefined;
    if (grant) void this.revoke(grant);
  }
  async begin(): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (this.attempt) return this.attempt.url;
    if (!this.starting)
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async start(): Promise<string> {
    const revision = this.revision;
    const accountUrl = this.url(this.account.accountIssuer);
    const metadataUrl = new URL(`${accountUrl.toString().replace(/\/$/, "")}/v1/oauth/router-client`);
    metadataUrl.searchParams.set("resource", this.resource);
    const response = await fetch(metadataUrl, {
      redirect: "error",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 404) throw new AgentRouterError("remote_router_not_registered", 400);
    if (!response.ok) throw new AgentRouterError("remote_authorization_unavailable", 503);
    const registration = (await response.json()) as {
      issuer?: unknown;
      client_id?: unknown;
      resource?: unknown;
      scopes?: unknown;
    };
    const scopes = registration.scopes;
    const expectedClient = `router-${createHash("sha256").update(this.resource).digest("hex")}`;
    if (
      typeof registration.issuer !== "string" ||
      registration.client_id !== expectedClient ||
      registration.resource !== this.resource ||
      !Array.isArray(scopes) ||
      !["openid", "profile", "router.connect"].every((scope) => scopes.includes(scope))
    )
      throw new AgentRouterError("remote_authorization_unavailable", 503);
    const issuer = this.url(registration.issuer);
    const config = await oidc.discovery(
      issuer,
      expectedClient,
      { token_endpoint_auth_method: "none", id_token_signed_response_alg: "EdDSA" },
      oidc.None(),
      {
        timeout: 10,
        ...(issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
      },
    );
    oidc.enableNonRepudiationChecks(config);
    // All credential-bearing endpoints remain under the issuer vouched for by WW.
    for (const endpoint of [
      config.serverMetadata().authorization_endpoint,
      config.serverMetadata().token_endpoint,
      config.serverMetadata().userinfo_endpoint,
      config.serverMetadata().revocation_endpoint,
      config.serverMetadata().jwks_uri,
    ]) {
      if (typeof endpoint !== "string" || this.url(endpoint).origin !== issuer.origin)
        throw new AgentRouterError("remote_authorization_unavailable", 503);
    }
    this.lifetime.signal.throwIfAborted();
    if (revision !== this.revision) throw new AgentRouterError("remote_authorization_canceled", 400);
    const verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    let redirect = "";
    let consuming = false;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      let callback: URL;
      try {
        callback = new URL(request.url ?? "/", redirect);
      } catch {
        response.writeHead(400).end("Invalid authorization callback.");
        return;
      }
      if (
        request.method !== "GET" ||
        request.headers.host !== new URL(redirect).host ||
        callback.pathname !== "/oauth/callback" ||
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== state ||
        consuming
      ) {
        response.writeHead(400).end("Invalid authorization callback.");
        return;
      }
      consuming = true;
      void (async () => {
        let received: Grant | undefined;
        try {
          const tokens = await oidc.authorizationCodeGrant(config, callback, {
            pkceCodeVerifier: verifier,
            expectedState: state,
            expectedNonce: nonce,
            idTokenExpected: true,
          });
          received = this.readGrant(config, tokens);
          if (tokens.claims()?.sub !== this.account.accountUserId)
            throw new AgentRouterError("remote_account_changed", 409);
          await oidc.fetchUserInfo(config, tokens.access_token, this.account.accountUserId);
          this.lifetime.signal.throwIfAborted();
          if (this.attempt?.state !== state) throw new AgentRouterError("remote_oauth_required", 403);
          this.grant = received;
          response.writeHead(200).end("Authorization complete. Return to OpenGrove.\n授权完成，请返回 OpenGrove。");
        } catch (error) {
          if (received) void this.revoke(received);
          if (this.attempt?.state === state)
            this.failure =
              error instanceof AgentRouterError ? error : new AgentRouterError("remote_authorization_failed", 400);
          response
            .writeHead(400)
            .end("Authorization failed. Return to OpenGrove and try again.\n授权失败，请返回 OpenGrove 重试。");
        } finally {
          // Let the response flush; close() stops accepting new callbacks immediately.
          if (this.attempt?.state === state) {
            clearTimeout(this.attempt.timer);
            this.attempt = undefined;
          }
          server.close();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/callback`;
    if (this.lifetime.signal.aborted || revision !== this.revision) {
      server.close();
      throw new AgentRouterError("remote_authorization_canceled", 400);
    }
    const url = oidc
      .buildAuthorizationUrl(config, {
        redirect_uri: redirect,
        scope: scopes.includes("offline_access")
          ? "openid profile router.connect offline_access"
          : "openid profile router.connect",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        nonce,
        prompt: "consent",
      })
      .toString();
    const timer = setTimeout(() => {
      this.failure = new AgentRouterError("remote_authorization_expired", 400);
      this.stopAttempt();
    }, 10 * 60_000);
    timer.unref();
    server.unref();
    this.attempt = { url, server, timer, state };
    return url;
  }
  private readGrant(
    config: oidc.Configuration,
    tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
  ): Grant {
    if (
      typeof tokens.expires_in !== "number" ||
      tokens.expires_in <= 30 ||
      (tokens.scope !== undefined && !tokens.scope.split(" ").includes("router.connect"))
    )
      throw new AgentRouterError("remote_authorization_failed", 400);
    return {
      config,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
  }
  async accessToken(): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    const grant = this.grant;
    if (!grant) throw new AgentRouterError("remote_oauth_required", 403);
    if (grant.expiresAt > Date.now() + 60_000) return grant.accessToken;
    if (!this.renewing)
      this.renewing = (async () => {
        let next: Grant | undefined;
        try {
          if (!grant.refreshToken) throw new AgentRouterError("remote_oauth_required", 403);
          const tokens = await oidc.refreshTokenGrant(grant.config, grant.refreshToken);
          next = this.readGrant(grant.config, tokens);
          if (!next.refreshToken || next.refreshToken === grant.refreshToken)
            throw new AgentRouterError("remote_authorization_failed", 400);
          if (this.lifetime.signal.aborted) {
            void this.revoke(next);
            this.lifetime.signal.throwIfAborted();
          }
          await oidc.fetchUserInfo(grant.config, next.accessToken, this.account.accountUserId);
          this.lifetime.signal.throwIfAborted();
          this.grant = next;
          return next.accessToken;
        } catch (error) {
          this.grant = undefined;
          void this.revoke(next ?? grant);
          throw error instanceof AgentRouterError ? error : new AgentRouterError("remote_oauth_required", 403);
        }
      })().finally(() => {
        this.renewing = undefined;
      });
    return this.renewing;
  }
}
