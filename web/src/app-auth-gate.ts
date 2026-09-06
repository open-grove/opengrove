import { useCallback, useState } from "react";
import { useMutation, useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AuthSessionResponse, HealthResponse } from "./bridge";
import {
  fetchBridgeTeamAccounts,
  fetchBridgeTeamGateStatus,
  restoreBridgePreviousSession,
  loginBridgeAuth,
  logoutBridgeAuth,
  sendBridgeEmailCode,
  signInBridgeTeamAccount,
  unlockBridgeTeamToken,
} from "./bridge";
import { APP_STORAGE_KEYS } from "./identity";
import { detectSystemLanguage, translate } from "./i18n";
import { markAuthSessionAuthenticated, markAuthSessionLoggedOut } from "./app-auth-model";
import { readDesktopApi } from "./desktop-api";
import { resolveBridgeAuthPolicy } from "./app-auth-policy";
import type { LanguagePreference } from "./i18n-types";

type LoginFormPayload = Omit<Parameters<typeof loginBridgeAuth>[0], "languagePreference" | "systemLanguage">;
type FixtureAccountSwitchPayload = { email: string };

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
      return switchDevFixtureAccount(payload, { signIn: signInBridgeTeamAccount });
    },
    // Shares applyAuthenticatedSession with email sign-in, so a switched session
    // lands exactly the way a real one does.
    onSuccess: applyAuthenticatedSession,
    onError() {
      // A failed switch leaves ww holding whichever session it had, and the
      // browser cookies were already cleared server-side, so the honest local
      // state is logged out.
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

  // The team gate only exists on a ww deployment that was built with it, and the
  // bridge answers from what ww reports rather than from any local guess about
  // which environment this is. Only asked while session auth is live -- a
  // bridge-token deployment has no ww sign-in to gate.
  const teamGateQuery = useQuery({
    queryKey: ["auth-team-gate"],
    queryFn: ({ signal }) => fetchBridgeTeamGateStatus(signal),
    enabled: sessionAuthActive,
    // Answering costs the bridge a round trip to ww, and the answer only changes
    // when someone unlocks, which invalidates this by hand.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const teamUnlockMutation = useMutation({
    mutationFn: unlockBridgeTeamToken,
    onSuccess(status) {
      queryClient.setQueryData(["auth-team-gate"], status);
      // Sign-in was unreachable until now, so anything that failed against the
      // gate deserves a fresh attempt.
      void queryClient.invalidateQueries();
    },
  });

  // Withheld until the query actually answers: treating "unknown" as "no gate"
  // would show a login form that cannot work, and treating it as "gated" would
  // demand a token on deployments that have none.
  // Returning to the account a switch replaced. Shares applyAuthenticatedSession
  // with every other sign-in path, so the restored session lands identically.
  const teamRestoreMutation = useMutation({
    mutationFn: restoreBridgePreviousSession,
    onSuccess(result) {
      applyAuthenticatedSession(result);
      // The stash is consumed, so the offer must disappear.
      void queryClient.invalidateQueries({ queryKey: ["auth-team-gate"] });
    },
    onError() {
      // The stored refresh token was spent or revoked; the bridge has dropped it.
      // Re-reading the gate status is what removes the affordance.
      void queryClient.invalidateQueries({ queryKey: ["auth-team-gate"] });
    },
  });

  const teamGateStatus = teamGateQuery.data;
  const teamGateBlocksSignIn = teamGateStatus?.required === true && teamGateStatus.satisfied === false;
  const teamGateSatisfied = teamGateStatus?.satisfied === true;

  // The account list is ww's answer, fetched only once the gate is satisfied --
  // before that ww refuses it, and after a switch it does not change.
  const teamAccountsQuery = useQuery({
    queryKey: ["auth-team-accounts"],
    queryFn: ({ signal }) => fetchBridgeTeamAccounts(signal),
    enabled: sessionAuthActive && teamGateSatisfied,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
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
    teamUnlockMutation,
    teamRestoreMutation,
    previousAccountEmail: teamGateStatus?.previousAccount,
    teamGateBlocksSignIn,
    teamGateChecking: sessionAuthActive && teamGateQuery.isPending,
    teamGateSatisfied,
    teamAccounts: teamAccountsQuery.data?.accounts ?? [],
    teamAccountsFailed: teamAccountsQuery.isError,
    teamGateUnavailable: teamGateQuery.isError,
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
