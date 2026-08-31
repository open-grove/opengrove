import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-auth-degraded-policy-"));
const bundlePath = join(tempDir, "app-auth-policy.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "web", "src", "app-auth-policy.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const { resolveBridgeAuthPolicy } = await import(pathToFileURL(bundlePath).href);

  const desktopOutage = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "temporarily_unavailable",
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    desktopAccountOnboardingCompleted: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(desktopOutage.sessionAuthUnavailable, true);
  assert.equal(desktopOutage.sessionAuthNeedsLogin, false);
  assert.equal(desktopOutage.bridgeProtectedQueriesEnabled, true);
  assert.equal(desktopOutage.clientUpdateEnabled, false);

  const desktopRequestFailure = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionFailed: true,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(desktopRequestFailure.sessionAuthUnavailable, true);
  assert.equal(desktopRequestFailure.sessionAuthNeedsLogin, false);
  assert.equal(desktopRequestFailure.bridgeProtectedQueriesEnabled, true);

  const webOutage = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "temporarily_unavailable",
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: false,
    desktopSavedSession: false,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(webOutage.sessionAuthUnavailable, true);
  assert.equal(webOutage.sessionAuthNeedsLogin, true);
  assert.equal(webOutage.bridgeProtectedQueriesEnabled, false);

  const loggedOutDesktop = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "unauthenticated",
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: false,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(loggedOutDesktop.sessionAuthNeedsLogin, true);
  assert.equal(loggedOutDesktop.bridgeProtectedQueriesEnabled, false);
  assert.equal(loggedOutDesktop.clientUpdateEnabled, false);

  const localDesktopAfterAccountChoice = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "unauthenticated",
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: false,
    desktopAccountOnboardingCompleted: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(localDesktopAfterAccountChoice.sessionAuthNeedsLogin, false);
  assert.equal(localDesktopAfterAccountChoice.bridgeProtectedQueriesEnabled, true);
  assert.equal(localDesktopAfterAccountChoice.clientUpdateEnabled, true);

  const authenticatedDesktop = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "authenticated",
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    desktopAccountOnboardingCompleted: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(authenticatedDesktop.clientUpdateEnabled, true);

  const bridgeTokenOnlyDesktop = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: false,
    sessionPending: false,
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: false,
    desktopAccountOnboardingCompleted: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: true,
  });
  assert.equal(bridgeTokenOnlyDesktop.bridgeProtectedQueriesEnabled, true);
  assert.equal(bridgeTokenOnlyDesktop.clientUpdateEnabled, false);

  const savedSessionPending = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: true,
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(savedSessionPending.sessionAuthChecking, false);
  assert.equal(savedSessionPending.sessionAuthPendingLocallyAvailable, true);
  assert.equal(savedSessionPending.sessionAuthNeedsLogin, false);
  assert.equal(savedSessionPending.bridgeProtectedQueriesEnabled, true);

  const firstLoginPending = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: true,
    sessionFailed: false,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: false,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(firstLoginPending.sessionAuthChecking, true);
  assert.equal(firstLoginPending.sessionAuthPendingLocallyAvailable, false);
  assert.equal(firstLoginPending.bridgeProtectedQueriesEnabled, false);

  const retainedAuthenticatedFailure = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "authenticated",
    sessionFailed: true,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(retainedAuthenticatedFailure.sessionAuthUnavailable, true);
  assert.equal(retainedAuthenticatedFailure.sessionAuthenticated, false);
  assert.equal(retainedAuthenticatedFailure.bridgeProtectedQueriesEnabled, true);

  const retainedLoggedOutFailure = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "unauthenticated",
    sessionFailed: true,
    sessionDegraded: false,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(retainedLoggedOutFailure.sessionAuthUnavailable, false);
  assert.equal(retainedLoggedOutFailure.sessionAuthNeedsLogin, true);
  assert.equal(retainedLoggedOutFailure.bridgeProtectedQueriesEnabled, false);

  const staleDesktopSession = resolveBridgeAuthPolicy({
    healthKnown: true,
    healthPending: false,
    sessionAuthActive: true,
    sessionPending: false,
    sessionStatus: "authenticated",
    sessionFailed: false,
    sessionDegraded: true,
    desktopBridgeAuthenticated: true,
    desktopSavedSession: true,
    bridgeTokenKnownOptional: false,
    bridgeTokenStored: false,
  });
  assert.equal(staleDesktopSession.sessionAuthUnavailable, true);
  assert.equal(staleDesktopSession.sessionAuthenticated, false);
  assert.equal(staleDesktopSession.bridgeProtectedQueriesEnabled, true);

  console.log("auth-degraded-policy-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
