import type { IncomingMessage, ServerResponse } from "node:http";
import { safeDiagnosticErrorCode } from "../../diagnostics/redaction.js";
import { readAppEnv } from "../../identity.js";
import { scheduleInstalledAppStoreUpdatesAfterAuth } from "../app-store-auto-updates.js";
import { releaseControlRegistryConfig } from "../app-store-registry.js";
import {
  authSessionFingerprint,
  type BridgeSecurity,
  cacheAuthSessionUser,
  clearAuthSessionCache,
  clearAuthTokens,
  hasBridgeTokenAccess,
  readAuthTokens,
  resolveWwRuntimeAuth,
  resolveWwRuntimeAuthWithoutRefresh,
  writeAuthTokens,
} from "../bridge-security.js";
import { saveBridgeSettings } from "../bridge-state.js";
import type { BridgeState } from "../bridge-types.js";
import { readClientReleaseNumber, readPackageVersion } from "../client-release.js";
import { scheduleDefaultStoreAppsInstalledAfterAuth } from "../default-store-apps.js";
import { record, stringValue } from "../http-utils.js";
import {
  type HostLanguagePreference,
  type HostSystemLanguage,
  normalizeHostLanguagePreference,
  normalizeHostSystemLanguage,
} from "../language-preference.js";
import { recordProblem } from "../problem-records.js";
import {
  createLocalSessionId,
  createWwHostedServices,
  type WwApiError,
  type WwClientPlatformVersion,
  type WwLatestClientVersion,
  wwDiagnosticFacts,
} from "../ww/index.js";
import {
  claimWwProviderAccount,
  clearWwProviderRecoveryBlock,
  readWwProviderLocalState,
  wwProviderAccountMatches,
} from "../ww-provider-local-state.js";
import { provisionWwProviderAfterLogin } from "../ww-provider-provisioning.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage, maxBytes?: number) => Promise<unknown>;
const PROFILE_REQUEST_MAX_BYTES = 1024 * 1024;
const PROFILE_AVATAR_MAX_BYTES = 512 * 1024;
const PROFILE_AVATAR_MAX_DIMENSION = 2048;
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const CLIENT_ACTIVITY_REQUEST_MAX_BYTES = 1024;

export async function handleAuthRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  security: BridgeSecurity;
  state: BridgeState;
  traceId?: string;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
}): Promise<boolean> {
  const { request, response, url, security, state, traceId, sendJson, readJsonBody } = options;
  if (request.method === "POST" && url.pathname === "/auth/email-codes") {
    await handleSendEmailCode(request, response, security, state, traceId, sendJson, readJsonBody);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/auth/login") {
    await handleLogin(request, response, security, state, traceId, sendJson, readJsonBody);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/auth/session") {
    await handleSession(request, response, security, state, traceId, sendJson);
    return true;
  }
  if (request.method === "PATCH" && url.pathname === "/auth/profile") {
    await handleProfileUpdate(request, response, security, state, traceId, sendJson, readJsonBody);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/auth/client-update") {
    await handleClientUpdate(request, response, security, state, traceId, sendJson);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/auth/activity") {
    await handleClientActivity(request, response, security, sendJson, readJsonBody);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    await handleLogout(request, response, security, state, traceId, sendJson);
    return true;
  }
  return false;
}

async function handleSendEmailCode(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
  readJsonBody: ReadJsonBody,
): Promise<void> {
  const services = wwServicesOrUnavailable(security, response, sendJson);
  if (!services) return;
  let body: Record<string, unknown>;
  try {
    body = record(await readJsonBody(request));
  } catch (error) {
    sendJson(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
      error: "invalid_auth_request",
    });
    return;
  }
  const email = stringValue(body.email).trim();
  if (!email) {
    sendJson(response, 400, { error: "invalid_email" });
    return;
  }
  try {
    const result = await services.account.sendEmailCode(email);
    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    sendAuthError(response, sendJson, state, traceId, "send-code", error);
  }
}

async function handleLogin(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
  readJsonBody: ReadJsonBody,
): Promise<void> {
  const services = wwServicesOrUnavailable(security, response, sendJson);
  if (!services) return;
  let body: Record<string, unknown>;
  try {
    body = record(await readJsonBody(request));
  } catch (error) {
    sendJson(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
      error: "invalid_auth_request",
    });
    return;
  }
  const email = stringValue(body.email).trim();
  const code = stringValue(body.code).trim();
  if (!email) {
    sendJson(response, 400, { error: "invalid_email" });
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    sendJson(response, 400, { error: "verification_code_invalid" });
    return;
  }
  try {
    const wwBaseUrl = security.wwBaseUrl;
    if (!wwBaseUrl) {
      sendJson(response, 503, { error: "auth_not_configured" });
      return;
    }
    const tokens = await services.account.login({
      email,
      code,
      deviceName: stringValue(body.deviceName),
      platform: stringValue(body.platform),
      inviteCode: stringValue(body.inviteCode),
      countryCode: stringValue(body.countryCode),
    });
    const user = await services.profile.readCurrentUser(tokens.accessToken);
    initializeHostLanguageFromLogin(state, body, traceId);
    const sessionId = createLocalSessionId();
    writeAuthTokens(response, tokens, sessionId);
    cacheAuthSessionUser(sessionId, tokens.accessToken, user, tokens.accessTokenExpiresIn);
    clearWwProviderRecoveryBlock(state, { issuer: wwBaseUrl, userId: user.userId });
    const providerProvisioning = await provisionWwProviderAfterLogin({
      state,
      client: services.providerCredentials,
      baseUrl: wwBaseUrl,
      accessToken: tokens.accessToken,
      userId: user.userId,
    });
    if (providerProvisioning.status === "failed") {
      recordProblem(state, {
        traceId,
        category: "ww",
        phase: "provider-provision",
        code: "ww_provider_provision_failed",
        error: providerProvisioning.error,
        retryable: true,
        facts: providerProvisioning.diagnosticFacts,
      });
    }
    claimWwProviderAccount(state, { issuer: wwBaseUrl, userId: user.userId });
    const defaultStoreApps = scheduleDefaultStoreAppsInstalledAfterAuth({
      state,
      request,
      installPolicyConfig: {
        baseUrl: wwBaseUrl,
        registryToken: tokens.accessToken,
      },
      packageRegistryConfig: releaseControlRegistryConfig(tokens.accessToken),
      userId: user.userId,
      traceId,
    });
    const appUpdates = scheduleInstalledAppStoreUpdatesAfterAuth({
      state,
      request,
      packageRegistryConfig: releaseControlRegistryConfig(tokens.accessToken),
      userId: user.userId,
      traceId,
    });
    sendJson(response, 200, {
      user,
      isNewUser: tokens.isNewUser,
      providerProvisioning,
      defaultStoreApps,
      appUpdates,
    });
  } catch (error) {
    sendAuthError(response, sendJson, state, traceId, "login", error);
  }
}

function initializeHostLanguageFromLogin(
  state: BridgeState,
  body: Record<string, unknown>,
  traceId: string | undefined,
): void {
  initializeHostLanguageSettings(
    state,
    {
      languagePreference: normalizeHostLanguagePreference(body.languagePreference),
      systemLanguage: normalizeHostSystemLanguage(body.systemLanguage),
    },
    traceId,
    "login",
  );
}

function initializeHostLanguageFromSession(
  state: BridgeState,
  request: IncomingMessage,
  traceId: string | undefined,
): void {
  const systemLanguage = requestSystemLanguage(request);
  if (!systemLanguage) return;
  initializeHostLanguageSettings(
    state,
    {
      languagePreference: "system",
      systemLanguage,
    },
    traceId,
    "session",
  );
}

function initializeHostLanguageSettings(
  state: BridgeState,
  input: {
    languagePreference?: HostLanguagePreference;
    systemLanguage?: HostSystemLanguage;
  },
  traceId: string | undefined,
  source: "login" | "session",
): void {
  let changed = false;
  if (!state.settings.languagePreference && input.languagePreference) {
    state.settings.languagePreference = input.languagePreference;
    changed = true;
  }
  if (!state.settings.systemLanguage && input.systemLanguage) {
    state.settings.systemLanguage = input.systemLanguage;
    changed = true;
  }
  if (!changed) return;
  try {
    saveBridgeSettings(state);
  } catch (error) {
    recordProblem(state, {
      traceId,
      category: "bridge",
      phase: "language-settings-save",
      code: "language_settings_save_failed",
      level: "warning",
      error,
      retryable: true,
      context: { source },
    });
  }
}

function requestSystemLanguage(request: IncomingMessage): HostSystemLanguage | undefined {
  const header = request.headers["accept-language"];
  const value = Array.isArray(header) ? header.join(",") : header;
  for (const candidate of value?.split(",") ?? []) {
    const language = normalizeHostSystemLanguage(candidate.split(";")[0]?.trim());
    if (language) return language;
  }
  return undefined;
}

async function handleSession(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
): Promise<void> {
  const authResult = await resolveWwRuntimeAuth(request, response, security);
  if (authResult.status === "unauthenticated") {
    sendJson(response, 200, {
      status: "unauthenticated",
      authenticated: false,
      reason: authResult.reason,
    });
    return;
  }
  if (authResult.status === "temporarily_unavailable") {
    const problem = recordProblem(state, {
      traceId,
      category: "ww",
      phase: "session-verify",
      code: authErrorCode(authResult.error),
      error: authResult.error,
      retryable: true,
      facts: wwDiagnosticFacts(authResult.error),
    });
    sendJson(response, 200, {
      status: "temporarily_unavailable",
      error: authErrorCode(authResult.error),
      incidentId: problem.incidentId,
      traceId: problem.traceId,
    });
    return;
  }
  const { session } = authResult;
  const verificationProblem =
    authResult.verificationError !== undefined
      ? (() => {
          const sessionFingerprint = authSessionFingerprint(readAuthTokens(request));
          return recordProblem(state, {
            traceId,
            category: "ww",
            phase: "session-verify",
            code: authErrorCode(authResult.verificationError),
            level: "warning",
            error: authResult.verificationError,
            retryable: true,
            facts: wwDiagnosticFacts(authResult.verificationError),
            backgroundDedupe: {
              key: `session-verify-degraded:${sessionFingerprint ?? "unknown"}`,
              windowMs: 10 * 60_000,
            },
          });
        })()
      : undefined;
  try {
    const localOwner = readWwProviderLocalState(state).ownerUserId;
    if (
      localOwner &&
      !wwProviderAccountMatches(state, {
        issuer: session.auth.baseUrl,
        userId: session.auth.userId,
      })
    ) {
      clearAuthTokens(response);
      clearAuthSessionCache(readAuthTokens(request));
      sendJson(response, 200, {
        status: "unauthenticated",
        authenticated: false,
        reason: "account_switched",
      });
      return;
    }
  } catch (error) {
    const problem = recordProblem(state, {
      traceId,
      category: "ww",
      phase: "session-account-state",
      error,
      retryable: true,
    });
    sendJson(response, 200, {
      status: "temporarily_unavailable",
      error: "account_state_unavailable",
      incidentId: problem.incidentId,
      traceId: problem.traceId,
    });
    return;
  }
  initializeHostLanguageFromSession(state, request, traceId);
  const providerProvisioning = await provisionWwProviderAfterLogin({
    state,
    client: createWwHostedServices(session.auth.baseUrl).providerCredentials,
    baseUrl: session.auth.baseUrl,
    accessToken: session.auth.accessToken,
    userId: session.auth.userId,
  });
  if (providerProvisioning.status === "failed") {
    recordProblem(state, {
      traceId,
      category: "ww",
      phase: "provider-provision",
      code: "ww_provider_provision_failed",
      error: providerProvisioning.error,
      retryable: true,
      facts: providerProvisioning.diagnosticFacts,
    });
  }
  const defaultStoreApps = scheduleDefaultStoreAppsInstalledAfterAuth({
    state,
    request,
    installPolicyConfig: {
      baseUrl: session.auth.baseUrl,
      registryToken: session.auth.accessToken,
    },
    packageRegistryConfig: releaseControlRegistryConfig(session.auth.accessToken),
    userId: session.auth.userId,
    traceId,
  });
  const appUpdates = scheduleInstalledAppStoreUpdatesAfterAuth({
    state,
    request,
    packageRegistryConfig: releaseControlRegistryConfig(session.auth.accessToken),
    userId: session.auth.userId,
    traceId,
  });
  sendJson(response, 200, {
    status: "authenticated",
    authenticated: true,
    verification: authResult.verification,
    ...(verificationProblem
      ? {
          error: authErrorCode(authResult.verificationError),
          incidentId: verificationProblem.incidentId,
          traceId: verificationProblem.traceId,
        }
      : {}),
    user: session.user,
    providerProvisioning,
    defaultStoreApps,
    appUpdates,
  });
}

async function handleProfileUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
  readJsonBody: ReadJsonBody,
): Promise<void> {
  const authResult = await resolveWwRuntimeAuth(request, response, security);
  if (authResult.status === "unauthenticated") {
    sendJson(response, 401, { error: "not_authenticated" });
    return;
  }
  if (authResult.status === "temporarily_unavailable") {
    sendAuthError(response, sendJson, state, traceId, "profile-update", authResult.error);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = record(await readJsonBody(request, PROFILE_REQUEST_MAX_BYTES));
  } catch (error) {
    sendJson(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
      error: "invalid_profile_request",
    });
    return;
  }
  const displayNamePresent = Object.hasOwn(body, "displayName");
  const avatarPresent = Object.hasOwn(body, "avatarDataUrl");
  if (!displayNamePresent && !avatarPresent) {
    sendJson(response, 400, { error: "invalid_profile_request" });
    return;
  }
  const displayName =
    body.displayName === null ? null : typeof body.displayName === "string" ? body.displayName.trim() : undefined;
  const avatarDataUrl = body.avatarDataUrl;
  if (
    displayNamePresent &&
    (displayName === undefined || (displayName !== null && (!displayName || Array.from(displayName).length > 80)))
  ) {
    sendJson(response, 400, { error: "invalid_display_name" });
    return;
  }
  if (
    avatarPresent &&
    avatarDataUrl !== null &&
    (typeof avatarDataUrl !== "string" || !isValidProfileAvatarDataUrl(avatarDataUrl))
  ) {
    sendJson(response, 400, { error: "invalid_avatar" });
    return;
  }

  const { session } = authResult;
  try {
    const user = await createWwHostedServices(session.auth.baseUrl).profile.updateCurrentUser(
      session.auth.accessToken,
      {
        ...(displayNamePresent ? { displayName: displayName ?? null } : {}),
        ...(avatarPresent ? { avatarDataUrl: typeof avatarDataUrl === "string" ? avatarDataUrl : null } : {}),
      },
    );
    cacheAuthSessionUser(readAuthTokens(request)?.sessionId, session.auth.accessToken, user);
    sendJson(response, 200, { user });
  } catch (error) {
    sendAuthError(response, sendJson, state, traceId, "profile-update", error);
  }
}

function isValidProfileAvatarDataUrl(value: string): boolean {
  if (!value.startsWith(JPEG_DATA_URL_PREFIX)) return false;
  const encoded = value.slice(JPEG_DATA_URL_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    return false;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > PROFILE_AVATAR_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false;
  }
  const dimensions = jpegDimensions(bytes);
  return (
    dimensions !== undefined &&
    dimensions.width <= PROFILE_AVATAR_MAX_DIMENSION &&
    dimensions.height <= PROFILE_AVATAR_MAX_DIMENSION
  );
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) return undefined;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return undefined;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return undefined;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

async function handleLogout(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
): Promise<void> {
  const tokens = readAuthTokens(request);
  clearAuthTokens(response);
  clearAuthSessionCache(tokens);
  if (tokens?.refreshToken && security.wwBaseUrl) {
    try {
      await createWwHostedServices(security.wwBaseUrl).account.logout(tokens.refreshToken);
    } catch (error) {
      recordProblem(state, {
        traceId,
        category: "ww",
        phase: "logout",
        code: "ww_logout_failed",
        error,
        retryable: true,
        facts: wwDiagnosticFacts(error),
      });
      // Local logout should still clear OpenGrove auth state when WW is unreachable.
    }
  }
  sendJson(response, 200, { ok: true });
}

async function handleClientUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state: BridgeState,
  traceId: string | undefined,
  sendJson: SendJson,
): Promise<void> {
  const services = wwServicesOrUnavailable(security, response, sendJson);
  if (!services) return;
  const authResult = await resolveWwRuntimeAuthWithoutRefresh(request, security);
  if (authResult.status === "temporarily_unavailable") {
    sendAuthError(response, sendJson, state, traceId, "client-update", authResult.error);
    return;
  }
  if (authResult.status === "authenticated") {
    // The packaged desktop client polls this GET every six hours. Reuse the
    // heartbeat for background App updates only while its access token remains
    // valid; login and session restoration own refresh and schedule updates
    // after rotating credentials.
    scheduleInstalledAppStoreUpdatesAfterAuth({
      state,
      request,
      packageRegistryConfig: releaseControlRegistryConfig(authResult.session.auth.accessToken),
      userId: authResult.session.auth.userId,
      traceId,
    });
  }
  try {
    // Keep this background endpoint read-only with respect to auth cookies.
    // A main-process request can be abandoned after the server rotates a
    // one-time refresh token, leaving the durable desktop cookie jar behind.
    const latest =
      authResult.status === "authenticated"
        ? await services.clientUpdates.readLatestClientVersion(authResult.session.auth.accessToken)
        : await services.clientUpdates.readPublicLatestClientVersion();
    const platform = selectClientVersionForCurrentPlatform(latest);
    sendJson(response, 200, {
      ok: true,
      current: readClientReleaseNumber(),
      latest: platform ?? null,
    });
  } catch (error) {
    sendAuthError(response, sendJson, state, traceId, "client-update", error);
  }
}

async function handleClientActivity(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  sendJson: SendJson,
  readJsonBody: ReadJsonBody,
): Promise<void> {
  // This is deliberately a desktop-only account metric. A normal authenticated
  // browser must not be able to make itself look like a desktop installation.
  if (!hasBridgeTokenAccess(request, security)) {
    sendJson(response, 403, { error: "desktop_client_required" });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = record(await readJsonBody(request, CLIENT_ACTIVITY_REQUEST_MAX_BYTES));
  } catch (error) {
    sendJson(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
      error: "invalid_client_activity_request",
    });
    return;
  }
  if (Object.keys(body).some((key) => key !== "clientVersion" && key !== "clientReleaseNumber")) {
    sendJson(response, 400, { error: "invalid_client_activity_request" });
    return;
  }
  const clientVersion = stringValue(body.clientVersion).trim();
  const clientReleaseNumber = optionalPositiveSafeInteger(body.clientReleaseNumber);
  if (
    !validActivityVersion(clientVersion) ||
    (body.clientReleaseNumber !== undefined && clientReleaseNumber === undefined)
  ) {
    sendJson(response, 400, { error: "invalid_client_activity_request" });
    return;
  }
  const authResult = await resolveWwRuntimeAuth(request, response, security);
  if (authResult.status === "unauthenticated") {
    sendJson(response, 401, { error: "not_authenticated" });
    return;
  }
  if (authResult.status === "temporarily_unavailable") {
    sendJson(response, 503, { error: "client_activity_unavailable" });
    return;
  }
  const bridgeVersion = readPackageVersion() ?? "unknown";
  const bridgeReleaseNumber = readClientReleaseNumber() ?? undefined;
  try {
    const result = await createWwHostedServices(authResult.session.auth.baseUrl).clientActivity.recordClientActivity(
      authResult.session.auth.accessToken,
      {
        surface: "desktop",
        operatingSystem: currentOperatingSystem(),
        architecture: currentArchitecture(),
        clientVersion,
        ...(clientReleaseNumber === undefined ? {} : { clientReleaseNumber }),
        bridgeVersion,
        ...(bridgeReleaseNumber === undefined ? {} : { bridgeReleaseNumber }),
        releaseChannel: readAppEnv("DESKTOP_CHANNEL") === "stable" ? "stable" : "dev",
      },
    );
    sendJson(response, 200, { ok: true, day: result.day });
  } catch {
    // Activity collection is best-effort and must never create a user-visible
    // WW problem record or affect the local workspace.
    sendJson(response, 503, { error: "client_activity_unavailable" });
  }
}

function validActivityVersion(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[\x21-\x7e]+$/.test(value);
}

function optionalPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function currentOperatingSystem(): "macos" | "windows" | "linux" | "unknown" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

function currentArchitecture(): "arm64" | "x64" | "unknown" {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return "unknown";
}

function selectClientVersionForCurrentPlatform(latest: WwLatestClientVersion): WwClientPlatformVersion | undefined {
  if (process.platform === "darwin") {
    return process.arch === "x64" ? (latest.macX64 ?? latest.mac) : (latest.macArm64 ?? latest.mac);
  }
  if (process.platform === "win32") {
    return process.arch === "x64" ? (latest.windowsX64 ?? latest.windows) : latest.windows;
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? (latest.linuxArm64 ?? latest.linux) : (latest.linuxX64 ?? latest.linux);
  }
  return undefined;
}

function wwServicesOrUnavailable(security: BridgeSecurity, response: ServerResponse, sendJson: SendJson) {
  if (!security.wwBaseUrl) {
    sendJson(response, 503, { error: "auth_not_configured" });
    return undefined;
  }
  return createWwHostedServices(security.wwBaseUrl);
}

function sendAuthError(
  response: ServerResponse,
  sendJson: SendJson,
  state: BridgeState,
  traceId: string | undefined,
  phase: string,
  error: unknown,
): void {
  const problem = recordProblem(state, {
    traceId,
    category: "ww",
    phase,
    code: stableAuthDiagnosticCode(error),
    error,
    retryable: isRetryableAuthError(error),
    facts: wwDiagnosticFacts(error),
  });
  if (isWwError(error)) {
    if (error.retryAfter !== undefined) {
      response.setHeader("Retry-After", String(error.retryAfter));
    }
    sendJson(response, error.status, {
      error: error.publicCode,
      requestId: error.requestId,
      incidentId: problem.incidentId,
      traceId: problem.traceId,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    });
    return;
  }
  const timeout = error instanceof Error && error.message === "ww_request_timeout";
  sendJson(response, timeout ? 504 : 502, {
    error: timeout ? "ww_request_timeout" : "auth_unavailable",
    incidentId: problem.incidentId,
    traceId: problem.traceId,
  });
}

function isRetryableAuthError(error: unknown): boolean {
  if (isWwError(error))
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  return true;
}

function authErrorCode(error: unknown): string {
  if (isWwError(error)) return error.publicCode;
  return error instanceof Error && error.message === "ww_request_timeout" ? "ww_request_timeout" : "auth_unavailable";
}

function stableAuthDiagnosticCode(error: unknown): string {
  const publicCode = authErrorCode(error);
  const safeCode = safeDiagnosticErrorCode(publicCode);
  return safeCode === "unknown_error" ? `auth_${publicCode}` : safeCode;
}

function isWwError(value: unknown): value is WwApiError {
  return value instanceof Error && typeof (value as WwApiError).publicCode === "string";
}
