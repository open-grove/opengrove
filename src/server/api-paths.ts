export function normalizeBridgeApiUrl(url: URL): URL {
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
    return url;
  }

  const normalized = new URL(url.href);
  normalized.pathname = normalized.pathname === "/api" ? "/" : normalized.pathname.slice("/api".length);
  return normalized;
}

export function isPublicBridgeRoute(pathname: string): boolean {
  return (
    pathname === "/bootstrap" ||
    pathname === "/health" ||
    pathname === "/capabilities" ||
    pathname === "/auth/email-codes" ||
    pathname === "/auth/session" ||
    pathname === "/auth/login" ||
    pathname === "/auth/logout" ||
    // Reachable before sign-in by necessity: on a ww deployment that gates
    // sign-in behind a team token, these are how a client learns the gate
    // exists and supplies the token, so requiring a session would make it
    // impossible to obtain one.
    pathname === "/auth/team-unlock" ||
    pathname === "/auth/team-status" ||
    pathname === "/auth/team-accounts" ||
    pathname === "/auth/team-signin" ||
    pathname === "/auth/team-restore" ||
    pathname === "/room-ledger/read"
  );
}
