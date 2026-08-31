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
    pathname === "/room-ledger/read"
  );
}
