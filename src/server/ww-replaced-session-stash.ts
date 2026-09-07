import { createHash } from "node:crypto";
import type { AuthTokens } from "./bridge-security.js";
import type { WwTokenPair } from "./ww/types.js";
import { canonicalWwIssuer } from "./ww-provider-local-state.js";

interface StashedSession {
  tokens: AuthTokens;
  email: string;
  issuer: string;
  ownerSessionId: string;
  ownerRefreshFingerprint: string;
  expiresAt: number;
  restoring: boolean;
}

// The readable session id is only an index. The private refresh credential is
// the proof of possession, and follows WW's refresh rotation for that session.
// Real-account credentials remain in memory and never outlive this Bridge.
const stashedSessions = new Map<string, StashedSession>();
const MAX_STASHED_SESSIONS = 256;
const MAX_STASH_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function stashReplacedSession(input: {
  baseUrl: string;
  nextSessionId: string;
  nextTokens: WwTokenPair;
  replaced: AuthTokens | undefined;
  replacedEmail: string | undefined;
}): void {
  const carried = readStashedSession(input.replaced, input.baseUrl);
  if (carried) discardStashedSession(carried);
  const original =
    carried ??
    (input.replaced?.refreshToken && input.replacedEmail
      ? { tokens: input.replaced, email: input.replacedEmail }
      : undefined);
  if (!original) return;
  const now = Date.now();
  for (const [id, session] of stashedSessions) {
    if (session.expiresAt <= now) stashedSessions.delete(id);
  }
  while (stashedSessions.size >= MAX_STASHED_SESSIONS) {
    const oldest = stashedSessions.keys().next().value;
    if (oldest) stashedSessions.delete(oldest);
  }
  const expiresAt = Math.min(
    carried?.expiresAt ?? now + MAX_STASH_LIFETIME_MS,
    now + input.nextTokens.refreshTokenExpiresIn * 1000,
  );
  stashedSessions.set(input.nextSessionId, {
    tokens: original.tokens,
    email: original.email,
    issuer: canonicalWwIssuer(input.baseUrl),
    ownerSessionId: input.nextSessionId,
    ownerRefreshFingerprint: refreshFingerprint(input.nextTokens.refreshToken),
    expiresAt,
    restoring: false,
  });
}

export function readStashedSession(tokens: AuthTokens | undefined, baseUrl: string): StashedSession | undefined {
  if (!tokens?.sessionId) return undefined;
  const session = stashedSessions.get(tokens.sessionId);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    stashedSessions.delete(tokens.sessionId);
    return undefined;
  }
  return session.issuer === canonicalWwIssuer(baseUrl) &&
    session.ownerRefreshFingerprint === refreshFingerprint(tokens.refreshToken)
    ? session
    : undefined;
}

export function rotateStashedSession(tokens: AuthTokens, refreshed: WwTokenPair, baseUrl: string): void {
  const session = readStashedSession(tokens, baseUrl);
  if (!session) return;
  session.ownerRefreshFingerprint = refreshFingerprint(refreshed.refreshToken);
  session.expiresAt = Math.min(session.expiresAt, Date.now() + refreshed.refreshTokenExpiresIn * 1000);
}

export function clearStashedSession(tokens: AuthTokens | undefined, baseUrl: string): void {
  const session = readStashedSession(tokens, baseUrl);
  if (session) discardStashedSession(session);
}

export function discardStashedSession(session: StashedSession): void {
  if (stashedSessions.get(session.ownerSessionId) === session) stashedSessions.delete(session.ownerSessionId);
}

function refreshFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
