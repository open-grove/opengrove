export type DesktopReleaseChannel = "stable" | "dev";

export type DesktopStripeDeepLinkAction = "return" | "refresh";

export interface DesktopStripeDeepLink {
  kind: "stripe-onboarding";
  action: DesktopStripeDeepLinkAction;
}

export const DESKTOP_STRIPE_DEEP_LINK_CHANNEL = "opengrove:desktop:stripe-deep-link";

export function desktopStripeDeepLinkScheme(channel: DesktopReleaseChannel): string {
  return channel === "stable" ? "opengrove" : "opengrove-dev";
}

export function parseDesktopStripeDeepLink(value: string, expectedScheme: string): DesktopStripeDeepLink | null {
  const normalizedScheme = expectedScheme.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/u.test(normalizedScheme) || value !== value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${normalizedScheme}:` ||
    url.hostname !== "stripe" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const action = url.pathname === "/return" ? "return" : url.pathname === "/refresh" ? "refresh" : null;
  return action ? { kind: "stripe-onboarding", action } : null;
}

export function findDesktopStripeDeepLink(
  values: readonly string[],
  expectedScheme: string,
): DesktopStripeDeepLink | null {
  for (const value of values) {
    const deepLink = parseDesktopStripeDeepLink(value, expectedScheme);
    if (deepLink) return deepLink;
  }
  return null;
}

export function isDesktopStripeDeepLink(value: unknown): value is DesktopStripeDeepLink {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesktopStripeDeepLink>;
  return candidate.kind === "stripe-onboarding" && (candidate.action === "return" || candidate.action === "refresh");
}
