import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  APP_BRIDGE_TOKEN_HEADER,
  APP_CONFIG_DIR,
  APP_DESKTOP_UI_ORIGIN,
  normalizeHttpOrigin,
  readAppEnv,
} from "../identity.js";
import type { BridgeState, LocalBridgeServerOptions } from "./bridge-types.js";
import { splitList } from "./http-utils.js";
import type { BridgeSessionUser } from "./bridge-session-user.js";
import { readWwProviderLocalState, wwProviderAccountMatches } from "./ww-provider-local-state.js";
import { createLocalSessionId, createWwHostedServices, type WwApiError, type WwTokenPair } from "./ww/index.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";

export interface BridgeSecurity {
  bridgeToken?: string;
  authMode: "bridge-token" | "session";
  wwBaseUrl?: string;
  allowedOrigins: string[];
  privateHealthRequiresBridgeToken?: boolean;
  mcpAppSandboxOrigin?: string;
}

export type { BridgeSessionUser } from "./bridge-session-user.js";

export interface BridgeRuntimeAuthSession {
  user: BridgeSessionUser;
  auth: BridgeWwRuntimeAuth;
}

export function bridgeSessionUserHasRole(user: BridgeSessionUser | undefined, role: string): boolean {
  const expected = role.trim();
  return Boolean(expected && user && (user.role === expected || user.roles?.includes(expected)));
}

export type WwRuntimeAuthResult =
  | {
      status: "authenticated";
      session: BridgeRuntimeAuthSession;
      verification: "verified" | "cached" | "stale";
      verificationError?: unknown;
    }
  | { status: "unauthenticated"; reason: string }
  | { status: "temporarily_unavailable"; error: unknown };

export type BridgeAuthorizationResult =
  | { authorized: true }
  | { authorized: false; status: "unauthenticated" | "temporarily_unavailable"; error?: unknown };

export function loadLocalEnvFile(): void {
  for (const path of localEnvPaths()) {
    if (!existsSync(path)) {
      continue;
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function createBridgeSecurity(options: LocalBridgeServerOptions): BridgeSecurity {
  const wwBaseUrl = readAppEnv("WW_BASE_URL")?.trim() || undefined;
  const requestedAuthMode = readAppEnv("WEB_AUTH_MODE")?.trim();
  const authMode =
    requestedAuthMode === "bridge-token"
      ? "bridge-token"
      : requestedAuthMode === "session" || Boolean(wwBaseUrl)
        ? "session"
        : "bridge-token";
  return {
    bridgeToken: options.bridgeToken ?? readAppEnv("BRIDGE_TOKEN"),
    authMode,
    wwBaseUrl,
    privateHealthRequiresBridgeToken: options.privateHealthRequiresBridgeToken === true,
    mcpAppSandboxOrigin: normalizeHttpOrigin(readAppEnv("MCP_APP_SANDBOX_ORIGIN")),
    allowedOrigins: [
      APP_DESKTOP_UI_ORIGIN,
      ...(options.allowedOrigins ?? []),
      ...splitList(readAppEnv("BRIDGE_ALLOWED_ORIGINS")),
    ],
  };
}

export function applyCors(response: ServerResponse, request: IncomingMessage, security: BridgeSecurity): void {
  const origin = request.headers.origin;
  if (isLocalProbeRequest(request) && origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  } else if (isAllowedOrigin(origin, security) && origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Vary", "Origin");
  if (origin && isAllowedOrigin(origin, security)) {
    response.setHeader("Access-Control-Allow-Credentials", "true");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", `content-type,${APP_BRIDGE_TOKEN_HEADER}`);
  response.setHeader(
    "Access-Control-Expose-Headers",
    "content-disposition,content-length,x-opengrove-sha256,x-opengrove-size,x-opengrove-evidence-complete,x-opengrove-trace-id",
  );
  response.setHeader("Access-Control-Max-Age", "86400");
}

export async function authorizeBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
  state?: BridgeState,
): Promise<BridgeAuthorizationResult> {
  if (hasBridgeTokenAccess(request, security)) {
    return { authorized: true };
  }
  if (security.authMode === "session") {
    const result = await resolveWwRuntimeAuth(request, response, security);
    if (result.status !== "authenticated") {
      return {
        authorized: false,
        status: result.status,
        ...(result.status === "temporarily_unavailable" ? { error: result.error } : {}),
      };
    }
    const { session } = result;
    if (state) {
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
          return { authorized: false, status: "unauthenticated" };
        }
      } catch (error) {
        return { authorized: false, status: "temporarily_unavailable", error };
      }
    }
    return { authorized: true };
  }
  return security.bridgeToken ? { authorized: false, status: "unauthenticated" } : { authorized: true };
}

export function hasBridgeTokenAccess(request: IncomingMessage, security: BridgeSecurity): boolean {
  return Boolean(security.bridgeToken && request.headers[APP_BRIDGE_TOKEN_HEADER] === security.bridgeToken);
}

export async function readAuthSession(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
): Promise<{ user: BridgeSessionUser } | undefined> {
  const result = await resolveWwRuntimeAuth(request, response, security);
  return result.status === "authenticated" ? { user: result.session.user } : undefined;
}

export async function readWwRuntimeAuth(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
): Promise<BridgeRuntimeAuthSession | undefined> {
  const result = await resolveWwRuntimeAuth(request, response, security);
  return result.status === "authenticated" ? result.session : undefined;
}

export async function resolveWwRuntimeAuth(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity,
): Promise<WwRuntimeAuthResult> {
  if (!security.wwBaseUrl) {
    return { status: "temporarily_unavailable", error: new Error("auth_not_configured") };
  }
  const tokens = readAuthTokens(request);
  if (!tokens) {
    return { status: "unauthenticated", reason: "missing_credentials" };
  }

  const sessionKey = tokens.sessionId || tokenFingerprint(tokens.refreshToken);
  if (isRefreshSessionInvalidated(sessionKey)) {
    clearAuthTokens(response);
    return { status: "unauthenticated", reason: "session_invalidated" };
  }
  if (tokens.accessToken && !accessTokenNeedsRefresh(tokens.accessToken)) {
    const staleUser = readCachedUser(sessionKey, tokens.accessToken, true);
    try {
      const currentUser = await readCurrentUserWithCache(security.wwBaseUrl, sessionKey, tokens.accessToken);
      return {
        status: "authenticated",
        session: runtimeAuthSession(security.wwBaseUrl, tokens.accessToken, currentUser.user),
        verification: currentUser.verification,
        ...(currentUser.verificationError === undefined ? {} : { verificationError: currentUser.verificationError }),
      };
    } catch (error) {
      if (isWwError(error) && error.publicCode === "user_disabled") {
        clearAuthTokens(response);
        clearAuthSessionCache(tokens);
        return { status: "unauthenticated", reason: "user_disabled" };
      }
      if (!isWwError(error) || error.publicCode !== "access_token_invalid") {
        if (staleUser) {
          deferCachedUserRevalidation(sessionKey, tokens.accessToken, error);
          return {
            status: "authenticated",
            session: runtimeAuthSession(security.wwBaseUrl, tokens.accessToken, staleUser),
            verification: "stale",
            verificationError: error,
          };
        }
        return { status: "temporarily_unavailable", error };
      }
    }
  }

  let refreshed: WwTokenPair;
  try {
    refreshed = sessionKey
      ? await refreshWithSingleFlight(security.wwBaseUrl, sessionKey, tokens.refreshToken)
      : await createWwHostedServices(security.wwBaseUrl).account.refresh(tokens.refreshToken);
  } catch (error) {
    if (isWwError(error) && error.publicCode === "refresh_token_invalid") {
      clearAuthTokens(response);
      clearAuthSessionCache(tokens);
      return { status: "unauthenticated", reason: "refresh_token_invalid" };
    }
    if (isWwError(error) && error.publicCode === "user_disabled") {
      clearAuthTokens(response);
      clearAuthSessionCache(tokens);
      return { status: "unauthenticated", reason: "user_disabled" };
    }
    if (tokens.accessToken) {
      const staleUser = readCachedUser(sessionKey, tokens.accessToken, true);
      if (staleUser) {
        deferCachedUserRevalidation(sessionKey, tokens.accessToken, error);
        return {
          status: "authenticated",
          session: runtimeAuthSession(security.wwBaseUrl, tokens.accessToken, staleUser),
          verification: "stale",
          verificationError: error,
        };
      }
    }
    return { status: "temporarily_unavailable", error };
  }

  const refreshedSessionId = tokens.sessionId || createLocalSessionId();
  writeAuthTokens(response, refreshed, refreshedSessionId);
  try {
    const currentUser = await readCurrentUserWithCache(
      security.wwBaseUrl,
      refreshedSessionId,
      refreshed.accessToken,
      refreshed.accessTokenExpiresIn,
    );
    return {
      status: "authenticated",
      session: runtimeAuthSession(security.wwBaseUrl, refreshed.accessToken, currentUser.user),
      verification: currentUser.verification,
      ...(currentUser.verificationError === undefined ? {} : { verificationError: currentUser.verificationError }),
    };
  } catch (error) {
    if (isWwError(error) && error.publicCode === "user_disabled") {
      clearAuthTokens(response);
      clearAuthSessionCache(tokens);
      return { status: "unauthenticated", reason: "user_disabled" };
    }
    if (tokens.accessToken) {
      const staleUser = transferCachedUserToRefreshedToken(
        sessionKey,
        tokens.accessToken,
        refreshedSessionId,
        refreshed.accessToken,
        error,
      );
      if (staleUser) {
        return {
          status: "authenticated",
          session: runtimeAuthSession(security.wwBaseUrl, refreshed.accessToken, staleUser),
          verification: "stale",
          verificationError: error,
        };
      }
    }
    return { status: "temporarily_unavailable", error };
  }
}

function runtimeAuthSession(
  baseUrl: string,
  accessToken: string,
  user: BridgeSessionUser,
): { user: BridgeSessionUser; auth: BridgeWwRuntimeAuth } {
  return {
    user,
    auth: {
      baseUrl,
      accessToken,
      userId: user.userId,
      email: user.email,
    },
  };
}

export interface AuthTokens {
  accessToken?: string;
  refreshToken: string;
  sessionId?: string;
}

export function authSessionFingerprint(tokens: AuthTokens | undefined): string | undefined {
  return tokenFingerprint(tokens?.sessionId || tokens?.refreshToken);
}

export function readAuthTokens(request: IncomingMessage): AuthTokens | undefined {
  const cookies = parseCookieHeader(request.headers.cookie);
  const accessToken = cookies.get(AUTH_ACCESS_COOKIE);
  const refreshToken = cookies.get(AUTH_REFRESH_COOKIE);
  if (!refreshToken) return undefined;
  return {
    ...(accessToken ? { accessToken } : {}),
    refreshToken,
    sessionId: cookies.get(AUTH_SESSION_COOKIE),
  };
}

export function writeAuthTokens(
  response: ServerResponse,
  tokens: WwTokenPair,
  sessionId = createLocalSessionId(),
): void {
  appendSetCookie(response, serializeCookie(AUTH_ACCESS_COOKIE, tokens.accessToken, tokens.accessTokenExpiresIn));
  appendSetCookie(response, serializeCookie(AUTH_REFRESH_COOKIE, tokens.refreshToken, tokens.refreshTokenExpiresIn));
  appendSetCookie(response, serializeCookie(AUTH_SESSION_COOKIE, sessionId, tokens.refreshTokenExpiresIn, false));
}

export function cacheAuthSessionUser(
  sessionId: string | undefined,
  accessToken: string,
  user: BridgeSessionUser,
  accessTokenExpiresIn?: number,
): void {
  cacheUser(sessionId, accessToken, user, accessTokenExpiresIn);
}

export function clearAuthSessionCache(tokens: AuthTokens | undefined): void {
  const sessionKey = tokens?.sessionId || tokenFingerprint(tokens?.refreshToken);
  clearCachedUser(sessionKey);
  clearCachedRefreshRotations(tokens, sessionKey);
}

export function clearAuthTokens(response: ServerResponse): void {
  appendSetCookie(response, serializeCookie(AUTH_ACCESS_COOKIE, "", 0));
  appendSetCookie(response, serializeCookie(AUTH_REFRESH_COOKIE, "", 0));
  appendSetCookie(response, serializeCookie(AUTH_SESSION_COOKIE, "", 0, false));
}

export function isAllowedOrigin(origin: string | undefined, security: BridgeSecurity): boolean {
  if (!origin) {
    return true;
  }

  if (security.allowedOrigins.includes(origin)) {
    return true;
  }

  if (isLoopbackHttpOrigin(origin)) {
    return true;
  }

  return false;
}

function localEnvPaths(): string[] {
  return [
    readAppEnv("ENV_FILE"),
    resolve(homedir(), APP_CONFIG_DIR, ".env.local"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
  ].filter((path): path is string => Boolean(path));
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export function isLocalProbeRequest(request: IncomingMessage): boolean {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    return url.pathname === "/opengrove-probe";
  } catch {
    return false;
  }
}

const AUTH_ACCESS_COOKIE = "opengrove_auth_access";
const AUTH_REFRESH_COOKIE = "opengrove_auth_refresh";
const AUTH_SESSION_COOKIE = "opengrove_auth_session";
const USER_CACHE_FALLBACK_TTL_MS = 60_000;
const USER_CACHE_MAX_VERIFIED_TTL_MS = 10_000;
const USER_CACHE_EXPIRY_SKEW_MS = 5_000;
const USER_CACHE_STALE_IF_ERROR_MS = 30 * 60_000;
const USER_CACHE_RETRY_COOLDOWN_MS = 30_000;
const USER_CACHE_MAX_ENTRIES = 256;
const REFRESH_ROTATION_CACHE_TTL_MS = 120_000;
const REFRESH_ROTATION_CACHE_MAX_ENTRIES = 256;
type CachedUser = {
  user: BridgeSessionUser;
  verifiedUntil: number;
  staleUntil: number;
  verificationError?: unknown;
};

const userCache = new Map<string, CachedUser>();
const userLocks = new Map<string, Promise<BridgeSessionUser>>();
const refreshLocks = new Map<string, Promise<WwTokenPair>>();
const refreshRotationCache = new Map<string, { tokens: WwTokenPair; expiresAt: number; sessionKey: string }>();
const invalidatedRefreshSessions = new Map<string, number>();

function cacheUser(
  sessionKey: string | undefined,
  accessToken: string,
  user: BridgeSessionUser,
  accessTokenExpiresIn?: number,
): void {
  const cacheKey = userCacheKey(sessionKey, accessToken);
  if (!cacheKey) return;
  const now = Date.now();
  pruneUserCache(now);
  while (!userCache.has(cacheKey) && userCache.size >= USER_CACHE_MAX_ENTRIES) {
    const oldest = userCache.keys().next().value;
    if (!oldest) break;
    userCache.delete(oldest);
  }
  const verifiedUntil = now + userCacheTtl(accessToken, accessTokenExpiresIn);
  userCache.delete(cacheKey);
  userCache.set(cacheKey, {
    user,
    verifiedUntil,
    staleUntil: verifiedUntil + USER_CACHE_STALE_IF_ERROR_MS,
  });
}

function clearCachedUser(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  for (const cacheKey of userCache.keys()) {
    if (cacheKey.startsWith(`${sessionKey}:`)) {
      userCache.delete(cacheKey);
    }
  }
  for (const lockKey of userLocks.keys()) {
    if (lockKey.startsWith(`${sessionKey}:`)) {
      userLocks.delete(lockKey);
    }
  }
}

async function readCurrentUserWithCache(
  baseUrl: string,
  sessionKey: string | undefined,
  accessToken: string,
  accessTokenExpiresIn?: number,
): Promise<{
  user: BridgeSessionUser;
  verification: "verified" | "cached" | "stale";
  verificationError?: unknown;
}> {
  const cacheKey = userCacheKey(sessionKey, accessToken);
  if (cacheKey) {
    const cached = readCachedUserEntry(sessionKey, accessToken, false);
    if (cached) {
      return {
        user: cached.user,
        verification: cached.verificationError === undefined ? "cached" : "stale",
        ...(cached.verificationError === undefined ? {} : { verificationError: cached.verificationError }),
      };
    }

    const lockKey = cacheKey;
    const existing = userLocks.get(lockKey);
    if (existing) return { user: await existing, verification: "verified" };
    const promise = createWwHostedServices(baseUrl)
      .profile.readCurrentUser(accessToken)
      .then((user) => {
        cacheUser(sessionKey, accessToken, user, accessTokenExpiresIn);
        return user;
      })
      .finally(() => userLocks.delete(lockKey));
    userLocks.set(lockKey, promise);
    return { user: await promise, verification: "verified" };
  }

  return {
    user: await createWwHostedServices(baseUrl).profile.readCurrentUser(accessToken),
    verification: "verified",
  };
}

function readCachedUser(
  sessionKey: string | undefined,
  accessToken: string,
  allowStale: boolean,
): BridgeSessionUser | undefined {
  return readCachedUserEntry(sessionKey, accessToken, allowStale)?.user;
}

function readCachedUserEntry(
  sessionKey: string | undefined,
  accessToken: string,
  allowStale: boolean,
): CachedUser | undefined {
  const cacheKey = userCacheKey(sessionKey, accessToken);
  if (!cacheKey) return undefined;
  const cached = userCache.get(cacheKey);
  if (!cached) return undefined;
  const now = Date.now();
  if (cached.staleUntil <= now) {
    userCache.delete(cacheKey);
    return undefined;
  }
  return allowStale || cached.verifiedUntil > now ? cached : undefined;
}

function deferCachedUserRevalidation(
  sessionKey: string | undefined,
  accessToken: string,
  verificationError: unknown,
): void {
  const cacheKey = userCacheKey(sessionKey, accessToken);
  if (!cacheKey) return;
  const cached = userCache.get(cacheKey);
  if (!cached) return;
  cached.verifiedUntil = Math.min(cached.staleUntil, Date.now() + USER_CACHE_RETRY_COOLDOWN_MS);
  cached.verificationError = verificationError;
}

function transferCachedUserToRefreshedToken(
  sourceSessionKey: string | undefined,
  sourceAccessToken: string,
  targetSessionKey: string | undefined,
  targetAccessToken: string,
  verificationError: unknown,
): BridgeSessionUser | undefined {
  const sourceCacheKey = userCacheKey(sourceSessionKey, sourceAccessToken);
  const targetCacheKey = userCacheKey(targetSessionKey, targetAccessToken);
  if (!sourceCacheKey || !targetCacheKey) return undefined;

  const now = Date.now();
  const cached = userCache.get(sourceCacheKey);
  if (!cached) return undefined;
  if (cached.staleUntil <= now) {
    userCache.delete(sourceCacheKey);
    return undefined;
  }

  pruneUserCache(now);
  while (!userCache.has(targetCacheKey) && userCache.size >= USER_CACHE_MAX_ENTRIES) {
    const oldest = userCache.keys().next().value;
    if (!oldest) break;
    userCache.delete(oldest);
  }
  userCache.delete(targetCacheKey);
  userCache.set(targetCacheKey, {
    user: cached.user,
    verifiedUntil: Math.min(cached.staleUntil, now + USER_CACHE_RETRY_COOLDOWN_MS),
    staleUntil: cached.staleUntil,
    verificationError,
  });
  return cached.user;
}

function userCacheKey(sessionKey: string | undefined, accessToken: string): string | undefined {
  const accessTokenKey = tokenFingerprint(accessToken);
  return sessionKey && accessTokenKey ? `${sessionKey}:${accessTokenKey}` : undefined;
}

function pruneUserCache(now = Date.now()): void {
  for (const [cacheKey, cached] of userCache) {
    if (cached.staleUntil <= now) {
      userCache.delete(cacheKey);
    }
  }
}

function userCacheTtl(accessToken: string, accessTokenExpiresIn: number | undefined): number {
  if (accessTokenExpiresIn !== undefined && Number.isFinite(accessTokenExpiresIn) && accessTokenExpiresIn > 0) {
    return Math.min(
      USER_CACHE_MAX_VERIFIED_TTL_MS,
      Math.max(0, accessTokenExpiresIn * 1000 - USER_CACHE_EXPIRY_SKEW_MS),
    );
  }
  const expiresAt = jwtExpiryMs(accessToken);
  return expiresAt === undefined
    ? Math.min(USER_CACHE_MAX_VERIFIED_TTL_MS, USER_CACHE_FALLBACK_TTL_MS)
    : Math.min(USER_CACHE_MAX_VERIFIED_TTL_MS, Math.max(0, expiresAt - Date.now() - USER_CACHE_EXPIRY_SKEW_MS));
}

function jwtExpiryMs(accessToken: string): number | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp) && parsed.exp > 0
      ? parsed.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

function accessTokenNeedsRefresh(accessToken: string): boolean {
  const expiresAt = jwtExpiryMs(accessToken);
  return expiresAt !== undefined && expiresAt - Date.now() <= USER_CACHE_EXPIRY_SKEW_MS;
}

async function refreshWithSingleFlight(baseUrl: string, key: string, refreshToken: string): Promise<WwTokenPair> {
  const rotationKey = refreshRotationCacheKey(baseUrl, refreshToken);
  const cached = cachedRefreshRotation(rotationKey);
  if (cached) return cached;

  const lockKey = rotationKey;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;
  const promise = createWwHostedServices(baseUrl)
    .account.refresh(refreshToken)
    .then((tokens) => {
      cacheRefreshRotation(rotationKey, key, tokens);
      return tokens;
    })
    .finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, promise);
  return promise;
}

function cachedRefreshRotation(cacheKey: string): WwTokenPair | undefined {
  const cached = refreshRotationCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    refreshRotationCache.delete(cacheKey);
    return undefined;
  }
  return cached.tokens;
}

function cacheRefreshRotation(cacheKey: string, sessionKey: string, tokens: WwTokenPair): void {
  const now = Date.now();
  pruneRefreshRotationCache(now);
  if (isRefreshSessionInvalidated(sessionKey, now)) {
    return;
  }
  while (refreshRotationCache.size >= REFRESH_ROTATION_CACHE_MAX_ENTRIES) {
    const oldest = refreshRotationCache.keys().next().value;
    if (!oldest) break;
    refreshRotationCache.delete(oldest);
  }
  refreshRotationCache.set(cacheKey, {
    tokens,
    sessionKey,
    expiresAt: now + REFRESH_ROTATION_CACHE_TTL_MS,
  });
}

function clearCachedRefreshRotations(tokens: AuthTokens | undefined, sessionKey: string | undefined): void {
  const refreshTokenKey = tokenFingerprint(tokens?.refreshToken);
  if (sessionKey) {
    invalidatedRefreshSessions.set(sessionKey, Date.now() + REFRESH_ROTATION_CACHE_TTL_MS);
  }
  for (const [cacheKey, cached] of refreshRotationCache) {
    if (
      (sessionKey && cached.sessionKey === sessionKey) ||
      (refreshTokenKey && cacheKey.endsWith(`:${refreshTokenKey}`))
    ) {
      refreshRotationCache.delete(cacheKey);
    }
  }
}

function isRefreshSessionInvalidated(sessionKey: string | undefined, now = Date.now()): boolean {
  if (!sessionKey) return false;
  const expiresAt = invalidatedRefreshSessions.get(sessionKey);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    invalidatedRefreshSessions.delete(sessionKey);
    return false;
  }
  return true;
}

function refreshRotationCacheKey(baseUrl: string, refreshToken: string): string {
  const refreshTokenKey = tokenFingerprint(refreshToken);
  if (!refreshTokenKey) {
    throw new Error("refresh token is required");
  }
  return `${baseUrl}:${refreshTokenKey}`;
}

function pruneRefreshRotationCache(now = Date.now()): void {
  for (const [cacheKey, cached] of refreshRotationCache) {
    if (cached.expiresAt <= now) {
      refreshRotationCache.delete(cacheKey);
    }
  }
  for (const [sessionKey, expiresAt] of invalidatedRefreshSessions) {
    if (expiresAt <= now) {
      invalidatedRefreshSessions.delete(sessionKey);
    }
  }
}

function parseCookieHeader(value: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key) continue;
    cookies.set(key, decodeURIComponent(rawValue));
  }
  return cookies;
}

function serializeCookie(name: string, value: string, maxAge: number, httpOnly = true): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "SameSite=Lax",
    httpOnly ? "HttpOnly" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function appendSetCookie(response: ServerResponse, cookie: string): void {
  const existing = response.getHeader("Set-Cookie");
  if (!existing) {
    response.setHeader("Set-Cookie", cookie);
    return;
  }
  const values = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  response.setHeader("Set-Cookie", [...values, cookie]);
}

function tokenFingerprint(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value).digest("base64url").slice(0, 32) : undefined;
}

function isWwError(value: unknown): value is WwApiError {
  return value instanceof Error && typeof (value as WwApiError).publicCode === "string";
}
