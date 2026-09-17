import * as oidc from "openid-client";

/** A lost refresh response may have consumed a rotating token; it must not be replayed. */
export async function oauthFailure(error: unknown): Promise<"rejected" | "unavailable" | "ambiguous"> {
  if (error instanceof oidc.ResponseBodyError) {
    if (["server_error", "temporarily_unavailable", "slow_down"].includes(error.error)) return "unavailable";
    return error.status >= 500 || error.status === 429 ? "ambiguous" : "rejected";
  }
  if (error instanceof oidc.WWWAuthenticateChallengeError)
    return error.status >= 500 || error.status === 429 ? "unavailable" : "rejected";
  if (error instanceof TypeError) return "ambiguous";
  if (error instanceof oidc.ClientError) {
    if (error.code === "OAUTH_TIMEOUT" || error.code === "OAUTH_ABORT") return "ambiguous";
    if (error.cause instanceof Response && (error.cause.status >= 500 || error.cause.status === 429)) {
      let body: unknown;
      try {
        body = await error.cause.clone().json();
      } catch {
        return "ambiguous";
      }
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        (body.error === "server_error" || body.error === "temporarily_unavailable" || body.error === "slow_down")
      )
        return "unavailable";
      return "ambiguous";
    }
    if (error.cause instanceof TypeError) return "ambiguous";
  }
  return "rejected";
}
