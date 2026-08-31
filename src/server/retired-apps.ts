import type { BridgeMountedAppSettings } from "./bridge-types.js";
import { readMountedAppManifest } from "./mounted-apps.js";
import { isRetiredKnowledgeVaultIdentity } from "../retired-app-identity.js";

export {
  isRetiredKnowledgeVaultIdentity,
  isRetiredKnowledgeVaultPackage,
  RETIRED_KNOWLEDGE_VAULT_APP_ID,
  RETIRED_KNOWLEDGE_VAULT_PACKAGE_KEY,
} from "../retired-app-identity.js";

export function isRetiredKnowledgeVaultMount(app: BridgeMountedAppSettings): boolean {
  if (isRetiredKnowledgeVaultIdentity(app.id)) return true;
  if (!app.path?.trim()) return false;

  const manifest = readMountedAppManifest(app.path).manifest;
  if (!manifest) return false;
  const store = record(manifest?.store);
  return [manifest?.id, manifest?.name, store.packageKey].some(isRetiredKnowledgeVaultIdentity);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
