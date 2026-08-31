import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBridgeSettings, normalizeBridgeSettingsPatch } from "../server/bridge-settings-store.js";
import { createBridgeState } from "../server/bridge-state.js";
import { defaultStoreAppPackageKeysForState } from "../server/default-store-apps.js";
import type { BridgeState } from "../server/bridge-types.js";

const KNOWLEDGE_VAULT_PACKAGE_KEY = "opengrove.knowledge-vault";
const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-knowledge-vault-install-policy-"));

try {
  const freshRestartRoot = join(tempRoot, "fresh-restart");
  const freshRestartStatePath = join(freshRestartRoot, "state.json");
  const firstLaunchState = createBridgeState({ statePath: freshRestartStatePath });
  assertKnowledgeVaultIsRetired(firstLaunchState, "a fresh install");
  assert.equal(
    existsSync(join(freshRestartRoot, "bridge-settings.json")),
    true,
    "the first launch must persist bridge settings",
  );
  firstLaunchState.store.saveFrom(firstLaunchState.app);
  await firstLaunchState.store.close?.();

  const secondLaunchState = createBridgeState({ statePath: freshRestartStatePath });
  assertKnowledgeVaultIsRetired(secondLaunchState, "a restarted fresh install");
  await secondLaunchState.store.close?.();

  const newInstallState = mockState(join(tempRoot, "new-install", "state.json"));
  newInstallState.settings = loadBridgeSettings(newInstallState);
  assertKnowledgeVaultIsRetired(newInstallState, "a new install without persisted settings");

  const legacyStateRoot = join(tempRoot, "legacy-state");
  const legacyStatePath = join(legacyStateRoot, "state.json");
  mkdirSync(legacyStateRoot, { recursive: true });
  writeFileSync(legacyStatePath, "{}\n", { encoding: "utf8", flag: "wx" });
  const legacyState = mockState(legacyStatePath);
  legacyState.settings = loadBridgeSettings(legacyState);
  assertKnowledgeVaultIsRetired(legacyState, "an install with legacy state data");

  const legacySettingsRoot = join(tempRoot, "legacy-settings");
  const legacySettingsState = mockState(join(legacySettingsRoot, "state.json"));
  const installedKnowledgeVaultPath = join(tempRoot, "installed-knowledge-vault");
  const aliasedKnowledgeVaultPath = join(tempRoot, "aliased-knowledge-vault");
  mkdirSync(legacySettingsRoot, { recursive: true });
  mkdirSync(aliasedKnowledgeVaultPath, { recursive: true });
  writeFileSync(
    join(aliasedKnowledgeVaultPath, "opengrove.app.json"),
    JSON.stringify({
      id: "vault-copy",
      title: "Old Vault Copy",
      store: { packageKey: KNOWLEDGE_VAULT_PACKAGE_KEY },
    }),
    { encoding: "utf8", flag: "wx" },
  );
  writeFileSync(
    join(legacySettingsRoot, "bridge-settings.json"),
    JSON.stringify({
      knowledgeAppMigrationPending: true,
      mountedApps: [
        { id: "story-seed", path: join(tempRoot, "disabled-story-seed"), enabled: false },
        { id: "knowledge-vault", path: installedKnowledgeVaultPath, enabled: true },
        { id: "vault-copy", path: aliasedKnowledgeVaultPath, enabled: true },
      ],
      uninstalledStoreAppIds: [],
      defaultAppSync: {
        managedPackageKeys: ["opengrove.story-seed", KNOWLEDGE_VAULT_PACKAGE_KEY],
      },
    }),
    { encoding: "utf8", flag: "wx" },
  );
  legacySettingsState.settings = loadBridgeSettings(legacySettingsState);
  assert.equal(
    "knowledgeAppMigrationPending" in legacySettingsState.settings,
    false,
    "the retired migration flag must be ignored when old settings are loaded",
  );
  assertKnowledgeVaultIsRetired(legacySettingsState, "an install with the retired migration flag");
  assert.equal(
    legacySettingsState.settings.mountedApps.some((app) => app.id === "story-seed"),
    true,
    "retiring Knowledge Vault must preserve unrelated Apps",
  );
  assert.equal(
    legacySettingsState.settings.defaultAppSync.managedPackageKeys.includes("opengrove.story-seed"),
    true,
    "retiring Knowledge Vault must preserve unrelated default-App management",
  );

  legacySettingsState.settings = normalizeBridgeSettingsPatch(
    {
      mountedApps: [
        ...legacySettingsState.settings.mountedApps,
        { id: "knowledge-vault", path: installedKnowledgeVaultPath, enabled: true },
      ],
    },
    legacySettingsState.settings,
  );
  assertKnowledgeVaultIsRetired(legacySettingsState, "a settings patch that attempts to remount it");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("knowledge-vault retirement migration ok");

function assertKnowledgeVaultIsOptIn(state: BridgeState, scenario: string): void {
  assert.equal(
    defaultStoreAppPackageKeysForState(state).includes(KNOWLEDGE_VAULT_PACKAGE_KEY),
    false,
    `${scenario} must not auto-install Knowledge Vault`,
  );
}

function assertKnowledgeVaultIsRetired(state: BridgeState, scenario: string): void {
  assertKnowledgeVaultIsOptIn(state, scenario);
  assert.equal(
    state.settings.mountedApps.some((app) => app.id === "knowledge-vault" || app.id === "vault-copy"),
    false,
    `${scenario} must not mount Knowledge Vault`,
  );
  assert.equal(
    state.settings.uninstalledStoreAppIds.includes("knowledge-vault"),
    false,
    `${scenario} must not report the retirement as a user uninstall`,
  );
  assert.equal(
    state.settings.defaultAppSync.managedPackageKeys.includes(KNOWLEDGE_VAULT_PACKAGE_KEY),
    false,
    `${scenario} must remove Knowledge Vault from default-App management`,
  );
}

function mockState(statePath: string): BridgeState {
  return {
    store: {
      kind: "json",
      path: statePath,
      loadInto: () => undefined,
      saveFrom: () => {
        throw new Error("not used by this harness");
      },
    },
  } as unknown as BridgeState;
}
