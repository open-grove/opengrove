import { normalizeAppStorePackageKey } from "./app-store-package-identity.js";

export const RETIRED_KNOWLEDGE_VAULT_APP_ID = "knowledge-vault";
export const RETIRED_KNOWLEDGE_VAULT_PACKAGE_KEY = "opengrove.knowledge-vault";

export function isRetiredKnowledgeVaultPackage(input: {
  id?: unknown;
  packageId?: unknown;
  appId?: unknown;
  packageKey?: unknown;
}): boolean {
  return [input.id, input.packageId, input.appId, input.packageKey].some(isRetiredKnowledgeVaultIdentity);
}

export function isRetiredKnowledgeVaultIdentity(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === RETIRED_KNOWLEDGE_VAULT_APP_ID ||
    normalizeAppStorePackageKey(normalized) === RETIRED_KNOWLEDGE_VAULT_PACKAGE_KEY
  );
}
