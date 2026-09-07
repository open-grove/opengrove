import type { UseQueryOptions } from "@tanstack/react-query";
import type { AuthSessionResponse } from "../bridge-settings-types";

/** Session recovery stays on the cookie-owning request path, including token refresh. */
export function authSessionRecoveryDelay(
  session: AuthSessionResponse | undefined,
  now = Date.now(),
  requestFailed = false,
): number | false {
  if (session?.status === "unauthenticated") return false;
  if (requestFailed || session?.status === "temporarily_unavailable") return 30_000;
  const provisioning = session?.providerProvisioning;
  if (provisioning?.status !== "failed" || provisioning.retryable !== true) return false;
  const retryAt = Date.parse(provisioning.retryAt ?? "");
  return Number.isFinite(retryAt) ? Math.max(1000, retryAt - now) : 30_000;
}

export const authSessionRecoveryOptions: Pick<
  UseQueryOptions<AuthSessionResponse>,
  | "retry"
  | "refetchInterval"
  | "refetchIntervalInBackground"
  | "refetchOnWindowFocus"
  | "refetchOnReconnect"
  | "staleTime"
> = {
  retry: false,
  refetchInterval: (query) => authSessionRecoveryDelay(query.state.data, Date.now(), query.state.status === "error"),
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: (query) =>
    authSessionRecoveryDelay(query.state.data, Date.now(), query.state.status === "error") === false ? false : "always",
  refetchOnReconnect: (query) =>
    authSessionRecoveryDelay(query.state.data, Date.now(), query.state.status === "error") === false ? false : "always",
  staleTime: Infinity,
};
