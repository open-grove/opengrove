export type SessionAuthStatus = "authenticated" | "unauthenticated" | "temporarily_unavailable";

export interface BridgeAuthPolicyInput {
  healthKnown: boolean;
  healthPending: boolean;
  sessionAuthActive: boolean;
  sessionPending: boolean;
  sessionStatus?: SessionAuthStatus;
  sessionFailed: boolean;
  sessionDegraded: boolean;
  desktopBridgeAuthenticated: boolean;
  desktopSavedSession: boolean;
  desktopAccountOnboardingCompleted: boolean;
  bridgeTokenKnownOptional: boolean;
  bridgeTokenStored: boolean;
}

export interface BridgeAuthPolicy {
  sessionAuthChecking: boolean;
  sessionAuthPendingLocallyAvailable: boolean;
  sessionAuthUnavailable: boolean;
  sessionAuthNeedsLogin: boolean;
  sessionAuthenticated: boolean;
  clientUpdateEnabled: boolean;
  bridgeProtectedQueriesEnabled: boolean;
}

export function resolveBridgeAuthPolicy(input: BridgeAuthPolicyInput): BridgeAuthPolicy {
  const sessionUnauthenticated = input.sessionAuthActive && input.sessionStatus === "unauthenticated";
  const desktopAccountChoiceCompleted =
    input.desktopBridgeAuthenticated && Boolean(input.desktopAccountOnboardingCompleted);
  const desktopAccountlessAccess = sessionUnauthenticated && desktopAccountChoiceCompleted;
  const sessionAuthPendingLocallyAvailable =
    input.sessionAuthActive &&
    input.sessionPending &&
    input.desktopBridgeAuthenticated &&
    (input.desktopSavedSession || Boolean(input.desktopAccountOnboardingCompleted)) &&
    !sessionUnauthenticated;
  const sessionAuthChecking =
    ((!input.healthKnown && input.healthPending) || (input.sessionAuthActive && input.sessionPending)) &&
    !sessionAuthPendingLocallyAvailable;
  const sessionAuthUnavailable =
    input.sessionAuthActive &&
    !sessionUnauthenticated &&
    (input.sessionStatus === "temporarily_unavailable" || input.sessionFailed || input.sessionDegraded);
  const sessionAuthenticated =
    input.sessionAuthActive && input.sessionStatus === "authenticated" && !sessionAuthUnavailable;
  const sessionAuthNeedsLogin =
    input.sessionAuthActive &&
    !desktopAccountChoiceCompleted &&
    (sessionUnauthenticated || (sessionAuthUnavailable && !input.desktopBridgeAuthenticated));
  const desktopLocalDegraded =
    input.desktopBridgeAuthenticated && (sessionAuthPendingLocallyAvailable || sessionAuthUnavailable);
  const bridgeProtectedQueriesEnabled = input.sessionAuthActive
    ? sessionAuthenticated || desktopLocalDegraded || desktopAccountChoiceCompleted
    : input.desktopBridgeAuthenticated || input.bridgeTokenKnownOptional || input.bridgeTokenStored;
  const clientUpdateEnabled = sessionAuthenticated || desktopAccountlessAccess;

  return {
    sessionAuthChecking,
    sessionAuthPendingLocallyAvailable,
    sessionAuthUnavailable,
    sessionAuthNeedsLogin,
    sessionAuthenticated,
    clientUpdateEnabled,
    bridgeProtectedQueriesEnabled,
  };
}
