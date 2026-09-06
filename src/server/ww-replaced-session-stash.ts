import type { AuthTokens } from "./bridge-security.js";

/**
 * Remembers the session a team-account switch replaced, so the person can get
 * back to it without another email verification code.
 *
 * Why this is safe: switching to a test account does not revoke anything in ww
 * -- it only mints an additional session -- so the replaced session's refresh
 * token is still valid. The only thing lost is the browser's cookies, which the
 * switch overwrote. Restoring hands back a session the same browser legitimately
 * held moments ago; it grants nothing new. That is the crucial difference from
 * letting the switch endpoint target a real account, which would turn the shared
 * team token into the ability to become any real user.
 *
 * In memory only, never on disk. These are a real user's tokens -- more
 * sensitive than the team token itself -- so they must not outlive the process.
 * The cost is that a bridge restart drops the option and the person signs in
 * with email again, which is an acceptable trade for not persisting them.
 */
interface StashedSession {
  tokens: AuthTokens;
  /** Shown on the "go back" affordance so it names who you would return to. */
  email: string;
}

// Keyed by the session id of the switched-INTO session, because that is the only
// identifier the browser still presents after the switch overwrote its cookies.
const stashedSessions = new Map<string, StashedSession>();

/**
 * Carries the replaced session forward under the new session's id.
 *
 * When a switch happens while a stash already exists, the existing one wins:
 * after real -> test-a -> test-b, going back should reach the real account
 * rather than test-a. Only the original is worth returning to, and keeping one
 * entry avoids maintaining a stack whose states nobody would exercise.
 */
export function stashReplacedSession(input: {
  previousSessionId: string | undefined;
  nextSessionId: string;
  replaced: AuthTokens | undefined;
  replacedEmail: string | undefined;
}): void {
  const carried = input.previousSessionId ? stashedSessions.get(input.previousSessionId) : undefined;
  if (input.previousSessionId) {
    stashedSessions.delete(input.previousSessionId);
  }
  if (carried) {
    stashedSessions.set(input.nextSessionId, carried);
    return;
  }
  if (!input.replaced?.refreshToken || !input.replacedEmail) return;
  stashedSessions.set(input.nextSessionId, { tokens: input.replaced, email: input.replacedEmail });
}

export function readStashedSession(sessionId: string | undefined): StashedSession | undefined {
  return sessionId ? stashedSessions.get(sessionId) : undefined;
}

export function clearStashedSession(sessionId: string | undefined): void {
  if (sessionId) stashedSessions.delete(sessionId);
}
