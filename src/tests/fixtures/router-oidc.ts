import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Synthetic provider for Host lifecycle tests. Cross-repository tests also use WW's real provider. */
export function routerOidcFixture(baseUrl: () => string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-oidc", alg: "EdDSA", use: "sig" };
  const codes = new Map<string, { query: URLSearchParams; user: string }>();
  const tokens = new Map<string, { user: string; client: string; refresh: string }>();
  const refreshes = new Map<string, { user: string; client: string }>();
  const revoked: string[] = [];
  let sequence = 0;
  let expiresIn = 900;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims: unknown) => {
    const value = `${encode({ alg: "EdDSA", kid: jwk.kid, typ: "JWT" })}.${encode(claims)}`;
    return `${value}.${sign(null, Buffer.from(value), privateKey).toString("base64url")}`;
  };
  return {
    revoked,
    expireSoon: () => {
      expiresIn = 45;
    },
    async authorize(url: string, user: string) {
      const target = new URL(url);
      target.searchParams.set("test_user", user);
      const response = await fetch(target);
      assert.equal(response.status, 200, await response.text());
    },
    handle(request: IncomingMessage, response: ServerResponse, raw: string): boolean {
      const issuer = baseUrl(),
        url = new URL(request.url!, issuer),
        path = url.pathname;
      if (
        !path.startsWith("/v1/oauth/") &&
        path !== "/.well-known/openid-configuration" &&
        path !== "/oauth/authorize" &&
        path !== "/v1/network/configuration"
      )
        return false;
      const send = (status: number, value: unknown) => {
        response
          .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(value));
        return true;
      };
      const body = new URLSearchParams(raw);
      if (path === "/v1/network/configuration") {
        const resource = url.searchParams.get("resource")!;
        return send(200, {
          issuer,
          resource,
          client_id: "opengrove-desktop",
          scopes: ["openid", "profile", "network.connect", "offline_access"],
        });
      }
      if (path === "/.well-known/openid-configuration")
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/v1/oauth/token`,
          userinfo_endpoint: `${issuer}/v1/oauth/userinfo`,
          revocation_endpoint: `${issuer}/v1/oauth/revoke`,
          jwks_uri: `${issuer}/v1/oauth/keys`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          id_token_signing_alg_values_supported: ["EdDSA"],
          code_challenge_methods_supported: ["S256"],
        });
      if (path === "/v1/oauth/keys") return send(200, { keys: [jwk] });
      if (path === "/oauth/authorize") {
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { query: url.searchParams, user: url.searchParams.get("test_user")! });
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        response.writeHead(302, { location: callback.toString() }).end();
        return true;
      }
      if (path === "/v1/oauth/token") {
        const authorization = codes.get(body.get("code") ?? "");
        const previous = refreshes.get(body.get("refresh_token") ?? "");
        const client = body.get("client_id")!;
        const user = authorization?.user ?? previous?.user;
        if (
          !user ||
          (authorization &&
            (authorization.query.get("client_id") !== client ||
              authorization.query.get("redirect_uri") !== body.get("redirect_uri") ||
              authorization.query.get("code_challenge") !==
                createHash("sha256")
                  .update(body.get("code_verifier") ?? "")
                  .digest("base64url"))) ||
          (previous && previous.client !== client)
        )
          return send(400, { error: "invalid_grant" });
        if (authorization) codes.delete(body.get("code")!);
        if (previous) refreshes.delete(body.get("refresh_token")!);
        const access = `oauth-${user}-${++sequence}`,
          refresh = `orr_${randomBytes(32).toString("base64url")}`;
        tokens.set(access, { user, client, refresh });
        refreshes.set(refresh, { user, client });
        return send(200, {
          access_token: access,
          refresh_token: refresh,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "openid profile network.connect offline_access",
          id_token: jwt({
            iss: issuer,
            aud: client,
            sub: user,
            exp: Math.floor(Date.now() / 1000) + 900,
            iat: Math.floor(Date.now() / 1000),
            ...(authorization ? { nonce: authorization.query.get("nonce") } : {}),
          }),
        });
      }
      if (path === "/v1/oauth/userinfo") {
        const token = tokens.get(request.headers.authorization?.replace("Bearer ", "") ?? "");
        if (!token || !refreshes.has(token.refresh)) return send(401, { error: "invalid_token" });
        return send(200, {
          sub: token.user,
          client_id: token.client,
          scope: "openid profile network.connect",
          roles: ["admin"],
        });
      }
      if (path === "/v1/oauth/revoke") {
        revoked.push(body.get("token")!);
        refreshes.delete(body.get("token")!);
        return send(200, {});
      }
      return send(404, { error: "not_found" });
    },
  };
}
