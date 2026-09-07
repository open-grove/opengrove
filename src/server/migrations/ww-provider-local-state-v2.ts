import { wwCredentialFingerprint } from "../ww-provider-reconciliation.js";
import type { BridgeProviderProfile } from "../bridge-types.js";
import { resolveProviderApiKey } from "../provider-state.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/48
 * Supports: OpenGrove <=0.6.6 WW ownership records without verification fingerprints.
 * Import existing, unblocked ownership once so an upgrade can keep serving during
 * a management outage. This is continuity evidence, not a fresh verification.
 * Remove when: direct upgrades from <=0.6.6 move to a standalone importer.
 */
export function migrateWwProviderLocalStateToV2(
  source: Record<string, unknown>,
  provider: BridgeProviderProfile | undefined,
  providerIssuer: string | undefined,
): Record<string, unknown> {
  if (source.version !== 1) return source;
  const apiKey = provider ? resolveProviderApiKey(provider) : undefined;
  const legacyOwnership =
    provider &&
    !provider.deleted &&
    provider.enabled !== false &&
    !provider.provisioningBlocked &&
    !provider.provisioning &&
    apiKey &&
    providerIssuer === source.ownerIssuer &&
    typeof source.ownerUserId === "string" &&
    source.ownerUserId.trim() &&
    typeof source.apiKeyId === "string" &&
    source.apiKeyId.trim() &&
    typeof source.apiKeyPrefix === "string" &&
    source.apiKeyPrefix.trim() &&
    apiKey.startsWith(source.apiKeyPrefix.trim()) &&
    source.verification === undefined &&
    source.reconciliation === undefined &&
    source.rejectedKeyFingerprint === undefined &&
    source.recoveryBlock === undefined &&
    (source.pending === undefined || (Array.isArray(source.pending) && source.pending.length === 0));
  const { newUserDefaults, importedCredential: _untrustedImport, ...current } = source;
  return {
    ...current,
    version: 2,
    // The field was called newUserDefaults in 0.6.1.
    productDefaults: source.productDefaults ?? newUserDefaults,
    ...(legacyOwnership
      ? {
          importedCredential: {
            fingerprint: wwCredentialFingerprint(apiKey),
            importedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}
