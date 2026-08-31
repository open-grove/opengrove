import type { QueryClient } from "@tanstack/react-query";
import type { AuthSessionResponse, BridgeAuthUser } from "./bridge";
import { translate } from "./i18n";
import type { TranslationFn } from "./i18n";

export function authErrorLabel(value: string, t: TranslationFn = translate): string {
  if (value === "verification_code_invalid") return t("auth.errorCodeInvalid");
  if (value === "rate_limited") return t("auth.errorRateLimited");
  if (value === "user_disabled") return t("auth.errorUserDisabled");
  if (value === "invite_code_required") return t("auth.errorInviteRequired");
  if (value === "invite_code_invalid") return t("auth.errorInviteInvalid");
  if (value === "country_code_required") return t("auth.errorCountryRequired");
  if (value === "country_code_invalid") return t("auth.errorCountryInvalid");
  if (value === "refresh_token_invalid") return t("auth.errorRefreshTokenInvalid");
  if (value === "api_key_invalid") return t("auth.errorApiKeyInvalid");
  if (value === "invalid_email") return t("auth.errorInvalidEmail");
  if (value === "auth_not_configured") return t("auth.errorNotConfigured");
  if (value === "auth_unavailable") return t("auth.errorUnavailable");
  if (value === "ww_request_timeout") return t("auth.errorWwTimeout");
  return value;
}

export function markAuthSessionAuthenticated(queryClient: QueryClient, user: BridgeAuthUser) {
  queryClient.setQueryData<AuthSessionResponse>(["auth-session"], {
    status: "authenticated",
    authenticated: true,
    user,
  });
}

export function markAuthSessionLoggedOut(queryClient: QueryClient) {
  queryClient.setQueryData<AuthSessionResponse>(["auth-session"], {
    status: "unauthenticated",
    authenticated: false,
  });
}
