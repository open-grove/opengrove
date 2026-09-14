import { apiUrl } from "../api-base";
import { BridgeRequestError } from "../bridge-client";
import { readDesktopApi } from "../desktop-api";

// Supports: OpenApp Portal 0.1.0 gateways returning 401 authentication_required from /instances/:id/api.
// Remove when: OpenApp Portal 0.1.0 proxy deployments retire these routes or provide browser sign-in handoff.

/** OpenApp rejects expired Portal sessions before a request reaches the Bridge. */
export function isOpenAppSessionRequiredError(error: unknown): boolean {
  return error instanceof BridgeRequestError && error.status === 401 && error.message === "authentication_required";
}

/**
 * OpenApp's /instances/:id/api proxy also protects the Bridge sign-in endpoints.
 * Its root page owns Portal sign-in. Keep this deployment-specific contract at
 * the adapter boundary; remove it when OpenApp no longer hosts these routes or
 * supplies a replacement authentication handoff contract.
 */
export function openAppSignInUrl(error: unknown): string | undefined {
  if (!isOpenAppSessionRequiredError(error) || typeof window === "undefined" || readDesktopApi()) return undefined;
  const location = window.location;
  const endpoint = new URL(apiUrl("/auth/session"), location.href);
  const match = endpoint.pathname.match(/^(\/instances\/[^/]+\/)api\/auth\/session$/u);
  if (
    !match ||
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.origin !== location.origin ||
    !location.pathname.startsWith(match[1]!)
  ) {
    return undefined;
  }
  return new URL("/", location.href).href;
}
