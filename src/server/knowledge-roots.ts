import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { APP_VAULT_DIR, APP_VAULT_ROOT_NAME, readAppEnv } from "../identity.js";
import type { BridgeState } from "./bridge-types.js";
import { kernelConfigHome } from "./kernel-utils.js";
import { joinVaultPath, safePathSegment, safeVaultPath, shouldIgnoreVaultDirectory } from "./knowledge-path-utils.js";

export interface KnowledgeWritableRootSpec {
  path: string;
  vaultPath: string;
  backing: "vault" | "native";
  originPath?: string;
}

export interface ScannedKnowledgeFolder {
  path: string;
  backing: "vault" | "native";
  originPath?: string;
}

export function knowledgeVaultRoot(): string {
  const dataDir = readAppEnv("DATA_DIR")?.trim();
  return resolve(dataDir || resolve(process.cwd(), "data"), APP_VAULT_DIR);
}

export function ensureKnowledgeVaultRoot(): void {
  const root = knowledgeVaultRoot();
  for (const dir of [
    "",
    APP_VAULT_ROOT_NAME,
    `${APP_VAULT_ROOT_NAME}/skills`,
    `${APP_VAULT_ROOT_NAME}/memories`,
    `${APP_VAULT_ROOT_NAME}/artifacts`,
    "Codex",
    "Codex/skills",
    "Claude",
    "Claude/skills",
    "Claude/agents",
    "Claude/memory",
    "Hermes",
    "Hermes/skills",
    "Hermes/memory",
  ]) {
    mkdirSync(resolve(root, dir), { recursive: true });
  }
}

export function knowledgeWritableRootSpecs(state?: BridgeState): KnowledgeWritableRootSpec[] {
  const home = homedir();
  const root = knowledgeVaultRoot();
  const codexHome = state ? kernelConfigHome(state.settings, "codex") : join(home, ".codex");
  const claudeHome = state ? kernelConfigHome(state.settings, "claude-code") : join(home, ".claude");
  const hermesHome = state ? kernelConfigHome(state.settings, "hermes") : join(home, ".hermes");
  const specs: KnowledgeWritableRootSpec[] = [
    { vaultPath: APP_VAULT_ROOT_NAME, path: resolve(root, APP_VAULT_ROOT_NAME), backing: "vault" },
    { vaultPath: "Codex", path: codexHome, backing: "native", originPath: codexHome },
    {
      vaultPath: "Codex/skills",
      path: join(codexHome, "skills"),
      backing: "native",
      originPath: join(codexHome, "skills"),
    },
    {
      vaultPath: "Codex/skills",
      path: join(home, ".agents", "skills"),
      backing: "native",
      originPath: join(home, ".agents", "skills"),
    },
    {
      vaultPath: "Codex/memories",
      path: join(codexHome, "memories"),
      backing: "native",
      originPath: join(codexHome, "memories"),
    },
    { vaultPath: "Claude", path: claudeHome, backing: "native", originPath: claudeHome },
    {
      vaultPath: "Claude/skills",
      path: join(claudeHome, "skills"),
      backing: "native",
      originPath: join(claudeHome, "skills"),
    },
    {
      vaultPath: "Claude/commands",
      path: join(claudeHome, "commands"),
      backing: "native",
      originPath: join(claudeHome, "commands"),
    },
    {
      vaultPath: "Claude/agents",
      path: join(claudeHome, "agents"),
      backing: "native",
      originPath: join(claudeHome, "agents"),
    },
    {
      vaultPath: "Claude/memory",
      path: join(claudeHome, "agent-memory"),
      backing: "native",
      originPath: join(claudeHome, "agent-memory"),
    },
    { vaultPath: "Hermes", path: hermesHome, backing: "native", originPath: hermesHome },
    {
      vaultPath: "Hermes/skills",
      path: join(hermesHome, "skills"),
      backing: "native",
      originPath: join(hermesHome, "skills"),
    },
    {
      vaultPath: "Hermes/memory",
      path: join(hermesHome, "memories"),
      backing: "native",
      originPath: join(hermesHome, "memories"),
    },
  ];

  if (state) {
    const seen = new Set(specs.map((spec) => spec.vaultPath));
    for (const document of state.app.knowledge.list({ limit: 5_000 })) {
      const metadata = document.metadata ?? {};
      if (metadata.createdBy !== "opengrove.import-folder") continue;
      const vaultPath = safeVaultPath(metadata.vaultPath);
      if (!vaultPath) continue;
      const rootName = vaultPath.split("/")[0];
      if (!rootName || seen.has(rootName)) continue;
      const originPath = resolveImportedRootPath(state, rootName);
      if (originPath) {
        specs.push({ vaultPath: rootName, path: originPath, backing: "native", originPath });
        seen.add(rootName);
      }
    }
  }

  return specs;
}

export function scanKnowledgeFolderRoot(
  root: KnowledgeWritableRootSpec,
  addFolder: (folder: ScannedKnowledgeFolder) => void,
  depth = 0,
): void {
  if (!existsSync(root.path)) return;
  addFolder({ path: root.vaultPath, backing: root.backing, originPath: root.originPath ?? root.path });
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldIgnoreVaultDirectory(entry.name)) continue;
    scanKnowledgeFolderRoot(
      {
        ...root,
        path: join(root.path, entry.name),
        originPath: root.backing === "native" ? join(root.path, entry.name) : undefined,
        vaultPath: joinVaultPath(root.vaultPath, safePathSegment(entry.name)),
      },
      addFolder,
      depth + 1,
    );
  }
}

function resolveImportedRootPath(state: BridgeState, rootName: string): string | undefined {
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const metadata = document.metadata ?? {};
    if (metadata.createdBy !== "opengrove.import-folder") continue;
    const vaultPath = safeVaultPath(metadata.vaultPath);
    if (!vaultPath) continue;
    const originPath = typeof metadata.sourceFileOriginPath === "string" ? metadata.sourceFileOriginPath : "";
    if (!originPath) continue;
    if (metadata.importedFolderRoot && (vaultPath === rootName || vaultPath === `${rootName}/.imported-root`)) {
      return originPath;
    }
    if (!vaultPath.startsWith(`${rootName}/`)) continue;
    const relFromRoot = vaultPath.slice(rootName.length + 1);
    const relSegments = relFromRoot.split("/").filter(Boolean);
    let resolved = originPath;
    for (let i = 0; i < relSegments.length; i += 1) {
      resolved = dirname(resolved);
    }
    return resolved;
  }
  return undefined;
}
