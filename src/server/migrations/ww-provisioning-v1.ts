import { wwProviderReconciliationSchema, type WwProviderReconciliation } from "../ww-provider-reconciliation.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/48
 * Supports: OpenGrove <=0.6.6 profiles containing only provisioningBlocked.
 * Retains quarantine until a fresh account-scoped check verifies the Key.
 * Remove when: direct upgrades from <=0.6.6 move to a standalone importer.
 */
export function migrateWwProvisioning(source: Record<string, unknown>): WwProviderReconciliation | undefined {
  if (source.provisioning !== undefined) return wwProviderReconciliationSchema.parse(source.provisioning);
  if (source.provisioningBlocked === true) return { status: "pending", reason: "verification_required", attempt: 0 };
  return undefined;
}
