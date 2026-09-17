import { OpenGroveClientError } from "@opengrove/client";
import type { TranslationFn } from "../../i18n";

export function remoteAgentErrorText(error: unknown, t: TranslationFn, fallback: string): string {
  const code =
    error instanceof OpenGroveClientError ? (error.code ?? error.message) : error instanceof Error ? error.message : "";
  const messages: Record<string, Parameters<TranslationFn>[0]> = {
    not_authenticated: "remoteAgent.loginRequired",
    external_session_invalid: "remoteAgent.loginRequired",
    external_role_required: "remoteAgent.adminRequired",
    remote_authorization_required: "remoteAgent.adminRequired",
    remote_not_configured: "remoteAgent.notConfigured",
    invalid_service_url: "remoteAgent.notConfigured",
    invalid_agent_address: "remoteAgent.invalidAddress",
    remote_account_changed: "remoteAgent.accountChanged",
    remote_router_not_registered: "remoteAgent.routerNotRegistered",
    remote_authorization_unavailable: "remoteAgent.authorizationUnavailable",
    remote_authorization_failed: "remoteAgent.authorizationError",
    remote_authorization_expired: "remoteAgent.authorizationExpired",
    remote_authorization_canceled: "remoteAgent.authorizationCanceled",
    remote_session_unavailable: "remoteAgent.sessionUnavailable",
    remote_account_provisioning_failed: "remoteAgent.accountProvisioningFailed",
  };
  return Object.hasOwn(messages, code) ? t(messages[code]!) : fallback;
}
