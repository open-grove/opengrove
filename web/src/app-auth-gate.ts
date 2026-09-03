import { useCallback, useState } from "react";
import { useMutation, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AuthSessionResponse, HealthResponse } from "./bridge";
import { loginBridgeAuth, logoutBridgeAuth, sendBridgeEmailCode } from "./bridge";
import { APP_STORAGE_KEYS } from "./identity";
import { detectSystemLanguage, translate } from "./i18n";
import { markAuthSessionAuthenticated, markAuthSessionLoggedOut } from "./app-auth-model";
import { readDesktopApi } from "./desktop-api";
import { resolveBridgeAuthPolicy } from "./app-auth-policy";
import type { LanguagePreference } from "./i18n-types";

type LoginFormPayload = Omit<Parameters<typeof loginBridgeAuth>[0], "languagePreference" | "systemLanguage">;
type FixtureAccountSwitchPayload = { email: string; countryCode: string };

export function useBridgeAuthGate(input: {
  queryClient: QueryClient;
  healthQuery: UseQueryResult<HealthResponse, Error>;
  sessionQuery: UseQueryResult<AuthSessionResponse, Error>;
  desktopSavedSession: boolean;
  desktopBridgeReady: boolean;
  desktopAccountOnboardingCompleted: boolean;
  languagePreference: LanguagePreference;
  onAuthSessionChanged?(): void;
  onProviderProvisioningFailed?(message: string): void;
  onNewUserRegistered?(): void;
}) {
  const {
    queryClient,
    healthQuery,
    sessionQuery,
    desktopSavedSession,
    desktopBridgeReady,
    desktopAccountOnboardingCompleted,
    languagePreference,
    onAuthSessionChanged,
    onProviderProvisioningFailed,
    onNewUserRegistered,
  } = input;
  const bridgeTokenStored =
    typeof window === "undefined" ? "" : (window.localStorage.getItem(APP_STORAGE_KEYS.bridgeToken) ?? "");
  const bridgeTokenKnownOptional = healthQuery.data?.tokenRequired === false;
  const desktopApi = readDesktopApi();
  const desktopBridgeAuthenticated = Boolean(desktopApi) && desktopBridgeReady === true;
  const sessionAuthActive = healthQuery.data?.auth?.mode === "session";
  const authPolicy = resolveBridgeAuthPolicy({
    healthKnown: Boolean(healthQuery.data),
    healthPending: healthQuery.isPending,
    sessionAuthActive,
    sessionPending: sessionQuery.isPending,
    sessionStatus: sessionQuery.data?.status,
    sessionFailed: sessionQuery.isError,
    sessionDegraded: sessionQuery.data?.verification === "stale",
    desktopBridgeAuthenticated,
    desktopSavedSession,
    desktopAccountOnboardingCompleted,
    bridgeTokenKnownOptional,
    bridgeTokenStored: Boolean(bridgeTokenStored),
  });
  const [sendCodeSuccessCount, setSendCodeSuccessCount] = useState(0);
  const [sendCodeRequiresInvite, setSendCodeRequiresInvite] = useState(false);
  const [sendCodeRequiresCountry, setSendCodeRequiresCountry] = useState(false);

  const authSendCodeMutation = useMutation({
    mutationFn: sendBridgeEmailCode,
    onSuccess(result) {
      setSendCodeRequiresInvite(result.requiresInvite === true);
      setSendCodeRequiresCountry(result.requiresCountry === true);
      setSendCodeSuccessCount((count) => count + 1);
    },
  });
  const applyAuthenticatedSession = (result: Awaited<ReturnType<typeof loginBridgeAuth>>) => {
    onAuthSessionChanged?.();
    if (result.isNewUser) {
      onNewUserRegistered?.();
    }
    if (result.providerProvisioning?.status === "failed") {
      onProviderProvisioningFailed?.(formatProviderProvisioningFailure(result.providerProvisioning));
    }
    markAuthSessionAuthenticated(queryClient, result.user);
    void queryClient.invalidateQueries();
  };
  const authLoginMutation = useMutation({
    mutationFn: (payload: LoginFormPayload) =>
      loginBridgeAuth({
        ...payload,
        languagePreference,
        systemLanguage: detectSystemLanguage(),
      }),
    onSuccess: applyAuthenticatedSession,
  });
  const authFixtureSwitchMutation = useMutation({
    async mutationFn(payload: FixtureAccountSwitchPayload) {
      if (!__OPENGROVE_DEV_FIXTURE_ACCOUNTS__) {
        throw new Error("fixture_account_switcher_not_built");
      }
      const { switchDevFixtureAccount } = await import("./dev-fixture-accounts");
      return switchDevFixtureAccount(
        { id: "", roles: [], enabled: true, ...payload },
        { languagePreference, systemLanguage: detectSystemLanguage() },
        { logout: logoutBridgeAuth, sendEmailCode: sendBridgeEmailCode, login: loginBridgeAuth },
      );
    },
    onSuccess: applyAuthenticatedSession,
    onError() {
      onAuthSessionChanged?.();
      markAuthSessionLoggedOut(queryClient);
      void queryClient.invalidateQueries();
    },
  });
  const authLogoutMutation = useMutation({
    mutationFn: logoutBridgeAuth,
    onSuccess() {
      onAuthSessionChanged?.();
      markAuthSessionLoggedOut(queryClient);
      void queryClient.invalidateQueries();
    },
  });

  const requestAuthSessionRevalidation = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["auth-session"] });
  }, [queryClient]);
  const resetSendCodeState = useCallback(() => {
    setSendCodeRequiresInvite(false);
    setSendCodeRequiresCountry(false);
  }, []);

  return {
    authLoginMutation,
    authLogoutMutation,
    authSendCodeMutation,
    authFixtureSwitchMutation,
    bridgeProtectedQueriesEnabled: authPolicy.bridgeProtectedQueriesEnabled,
    sendCodeRequiresInvite,
    sendCodeRequiresCountry,
    sendCodeSuccessCount,
    resetSendCodeState,
    requestAuthSessionRevalidation,
    sessionAuthChecking: authPolicy.sessionAuthChecking,
    sessionAuthPendingLocallyAvailable: authPolicy.sessionAuthPendingLocallyAvailable,
    sessionAuthNeedsLogin: authPolicy.sessionAuthNeedsLogin,
    sessionAuthUnavailable: authPolicy.sessionAuthUnavailable,
    sessionAuthenticated: authPolicy.sessionAuthenticated,
  };
}

function formatProviderProvisioningFailure(provisioning: { reason?: string; error?: string }): string {
  const detail = provisioning.error || provisioning.reason;
  return detail
    ? translate("auth.providerProvisioningFailedDetail", { detail })
    : translate("auth.providerProvisioningFailed");
}
