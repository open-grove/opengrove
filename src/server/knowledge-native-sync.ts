import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { APP_PROTOCOL_ID, APP_VAULT_ROOT_NAME } from "../identity.js";
import type { BridgeState } from "./bridge-types.js";
import { KNOWLEDGE_FILE_SIZE_LIMIT } from "./bridge-types.js";
import { kernelConfigHome } from "./kernel-utils.js";
import {
  inferKnowledgeFileFormat,
  isVisibleKnowledgeFileName,
  safeIdSegment,
  safePathSegment,
  shortHash,
  shouldIgnoreVaultDirectory,
} from "./knowledge-path-utils.js";

const GLOBAL_KERNEL_KNOWLEDGE_SYNC_INTERVAL_MS = 30_000;

let lastGlobalKernelKnowledgeSyncAt = 0;
let lastGlobalKernelKnowledgeSyncKey = "";

function syncGlobalKernelKnowledgeDocuments(state: BridgeState): void {
  const home = homedir();
  const codexHome = kernelConfigHome(state.settings, "codex");
  const claudeHome = kernelConfigHome(state.settings, "claude-code");
  const hermesHome = kernelConfigHome(state.settings, "hermes");
  upsertNativeMarkdownFile(state, {
    id: "native.codex.agents-md",
    kernelId: "codex",
    sourceId: "codex.user-agents-md",
    title: "AGENTS.md",
    path: join(codexHome, "AGENTS.md"),
    vaultPath: "Codex/AGENTS.md",
    tags: ["codex", "instructions"],
    type: "project_doc",
  });
  upsertSkillDirectory(state, {
    kernelId: "codex",
    sourceId: "codex.user-skills",
    dir: join(codexHome, "skills"),
    vaultRoot: "Codex/skills",
    tags: ["codex", "skill"],
  });
  upsertNativeKnowledgeDirectory(state, {
    kernelId: "codex",
    sourceId: "codex.user-memories",
    dir: join(codexHome, "memories"),
    vaultRoot: "Codex/memories",
    tags: ["codex", "memory"],
    type: "memory",
  });
  upsertSkillDirectory(state, {
    kernelId: "codex",
    sourceId: "codex.user-agent-skills",
    dir: join(home, ".agents", "skills"),
    vaultRoot: "Codex/skills",
    tags: ["codex", "skill"],
  });

  upsertNativeMarkdownFile(state, {
    id: "native.claude.claude-md",
    kernelId: "claude-code",
    sourceId: "claude.user-claude-md",
    title: "CLAUDE.md",
    path: join(claudeHome, "CLAUDE.md"),
    vaultPath: "Claude/CLAUDE.md",
    tags: ["claude", "instructions"],
    type: "project_doc",
  });
  upsertSkillDirectory(state, {
    kernelId: "claude-code",
    sourceId: "claude.user-skills",
    dir: join(claudeHome, "skills"),
    vaultRoot: "Claude/skills",
    tags: ["claude", "skill"],
  });
  upsertSkillDirectory(state, {
    kernelId: "claude-code",
    sourceId: "claude.user-commands",
    dir: join(claudeHome, "commands"),
    vaultRoot: "Claude/commands",
    tags: ["claude", "command"],
  });
  upsertClaudeAgents(state, join(claudeHome, "agents"));
  upsertClaudeAgentMemory(state, join(claudeHome, "agent-memory"));

  upsertNativeMarkdownFile(state, {
    id: "native.hermes.soul-md",
    kernelId: "hermes",
    sourceId: "hermes.soul",
    title: "SOUL.md",
    path: join(hermesHome, "SOUL.md"),
    vaultPath: "Hermes/SOUL.md",
    tags: ["hermes", "identity"],
    type: "profile",
  });
  upsertSkillDirectory(state, {
    kernelId: "hermes",
    sourceId: "hermes.local-skills",
    dir: join(hermesHome, "skills"),
    vaultRoot: "Hermes/skills",
    tags: ["hermes", "skill"],
  });
  upsertSkillDirectory(state, {
    kernelId: APP_PROTOCOL_ID,
    sourceId: `${APP_PROTOCOL_ID}.cc-switch-skills`,
    dir: join(home, ".cc-switch", "skills"),
    vaultRoot: `${APP_VAULT_ROOT_NAME}/skills`,
    tags: [APP_PROTOCOL_ID, "skill", "cc-switch"],
  });
  upsertNativeMarkdownFile(state, {
    id: "native.hermes.memory-md",
    kernelId: "hermes",
    sourceId: "hermes.memories",
    title: "MEMORY.md",
    path: join(hermesHome, "memories", "MEMORY.md"),
    vaultPath: "Hermes/memory/MEMORY.md",
    tags: ["hermes", "memory"],
    type: "memory",
  });
  upsertNativeMarkdownFile(state, {
    id: "native.hermes.user-md",
    kernelId: "hermes",
    sourceId: "hermes.memories",
    title: "USER.md",
    path: join(hermesHome, "memories", "USER.md"),
    vaultPath: "Hermes/memory/USER.md",
    tags: ["hermes", "memory", "user"],
    type: "memory",
  });
}

export function syncGlobalKernelKnowledgeDocumentsIfNeeded(state: BridgeState): void {
  const syncKey = [
    kernelConfigHome(state.settings, "codex"),
    kernelConfigHome(state.settings, "claude-code"),
    kernelConfigHome(state.settings, "hermes"),
  ].join("\0");
  const now = Date.now();
  if (
    syncKey === lastGlobalKernelKnowledgeSyncKey &&
    now - lastGlobalKernelKnowledgeSyncAt < GLOBAL_KERNEL_KNOWLEDGE_SYNC_INTERVAL_MS
  ) {
    return;
  }
  lastGlobalKernelKnowledgeSyncKey = syncKey;
  lastGlobalKernelKnowledgeSyncAt = now;
  syncGlobalKernelKnowledgeDocuments(state);
}

function upsertSkillDirectory(
  state: BridgeState,
  input: {
    kernelId: string;
    sourceId: string;
    dir: string;
    vaultRoot: string;
    tags: string[];
  },
): void {
  if (!existsSync(input.dir)) return;
  for (const entry of safeReadDir(input.dir)) {
    if (!entry.isDirectory() || shouldIgnoreVaultDirectory(entry.name)) continue;
    upsertNativeSkillFolder(state, {
      ...input,
      skillName: entry.name,
      skillRoot: join(input.dir, entry.name),
      vaultRoot: `${input.vaultRoot}/${safePathSegment(entry.name)}`,
    });
  }
}

function upsertNativeSkillFolder(
  state: BridgeState,
  input: {
    kernelId: string;
    sourceId: string;
    skillName: string;
    skillRoot: string;
    vaultRoot: string;
    tags: string[];
  },
): void {
  const skillId = `native.${input.kernelId}.skill.${safeIdSegment(input.skillName)}`;
  for (const filePath of listVisibleKnowledgeFiles(input.skillRoot)) {
    const relativePath = relative(input.skillRoot, filePath).replace(/\\/g, "/");
    const isEntry = relativePath.toLowerCase() === "skill.md";
    upsertNativeMarkdownFile(state, {
      id: isEntry ? skillId : `${skillId}.${shortHash(filePath)}`,
      kernelId: input.kernelId,
      sourceId: input.sourceId,
      title: isEntry ? input.skillName : relativePath,
      path: filePath,
      vaultPath: `${input.vaultRoot}/${relativePath
        .split("/")
        .map((part) => safePathSegment(part))
        .join("/")}`,
      tags: isEntry ? input.tags : [...input.tags, "reference"],
      type: isEntry ? "skill" : "source",
      metadata: {
        skillName: input.skillName,
        skillRoot: input.skillRoot,
        entry: join(input.skillRoot, "SKILL.md"),
        parentSkillId: skillId,
        skillFilePath: relativePath,
      },
    });
  }
}

function upsertNativeKnowledgeDirectory(
  state: BridgeState,
  input: {
    kernelId: string;
    sourceId: string;
    dir: string;
    vaultRoot: string;
    tags: string[];
    type: "memory" | "note" | "project_doc" | "profile" | "source";
  },
): void {
  if (!existsSync(input.dir)) return;
  for (const filePath of listVisibleKnowledgeFiles(input.dir)) {
    const relativePath = relative(input.dir, filePath).replace(/\\/g, "/");
    upsertNativeMarkdownFile(state, {
      id: `native.${input.kernelId}.${input.sourceId}.${shortHash(filePath)}`,
      kernelId: input.kernelId,
      sourceId: input.sourceId,
      title: relativePath,
      path: filePath,
      vaultPath: `${input.vaultRoot}/${relativePath
        .split("/")
        .map((part) => safePathSegment(part))
        .join("/")}`,
      tags: input.tags,
      type: input.type,
    });
  }
}

function listVisibleKnowledgeFiles(root: string, depth = 0): string[] {
  if (depth > 8) return [];
  const files: string[] = [];
  for (const entry of safeReadDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!shouldIgnoreVaultDirectory(entry.name)) {
        files.push(...listVisibleKnowledgeFiles(path, depth + 1));
      }
      continue;
    }
    if (!entry.isFile() || !isVisibleKnowledgeFileName(entry.name)) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > KNOWLEDGE_FILE_SIZE_LIMIT) continue;
      files.push(path);
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right), "zh-CN"));
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function upsertClaudeAgents(state: BridgeState, dir: string): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    const file = join(dir, entry.name);
    const name = basename(entry.name, ".md");
    upsertNativeMarkdownFile(state, {
      id: `native.claude.agent.${safeIdSegment(name)}`,
      kernelId: "claude-code",
      sourceId: "claude.user-agents",
      title: entry.name,
      path: file,
      vaultPath: `Claude/agents/${safePathSegment(entry.name)}`,
      tags: ["claude", "agent"],
      type: "profile",
    });
  }
}

function upsertClaudeAgentMemory(state: BridgeState, dir: string): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "MEMORY.md");
    upsertNativeMarkdownFile(state, {
      id: `native.claude.memory.${safeIdSegment(entry.name)}`,
      kernelId: "claude-code",
      sourceId: "claude.user-agent-memory",
      title: `${entry.name}/MEMORY.md`,
      path: file,
      vaultPath: `Claude/memory/${safePathSegment(entry.name)}/MEMORY.md`,
      tags: ["claude", "memory", entry.name],
      type: "memory",
    });
  }
}

function upsertNativeMarkdownFile(
  state: BridgeState,
  input: {
    id: string;
    kernelId: string;
    sourceId: string;
    title: string;
    path: string;
    vaultPath: string;
    tags: string[];
    type: "skill" | "memory" | "note" | "project_doc" | "profile" | "source";
    metadata?: Record<string, unknown>;
  },
): void {
  if (!existsSync(input.path)) return;
  try {
    const stat = statSync(input.path);
    if (!stat.isFile() || stat.size > KNOWLEDGE_FILE_SIZE_LIMIT) return;
    const body = readFileSync(input.path, "utf8");
    state.app.knowledge.upsert({
      id: input.id,
      slug: input.id
        .replace(/^native\./, "native-")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .toLowerCase(),
      type: input.type,
      title: input.title,
      body,
      format: inferKnowledgeFileFormat(input.path),
      tags: input.tags,
      sourceRefs: [{ title: input.title, locator: input.path }],
      scope: "user",
      lifecycle: "active",
      metadata: {
        nativeGlobalKnowledge: true,
        kernelId: input.kernelId,
        sourceId: input.sourceId,
        sourceFilePath: input.path,
        sourceFileOriginPath: input.path,
        vaultPath: input.vaultPath,
        ...input.metadata,
      },
    });
  } catch {
    // Native files are optional; a broken file should not break inventory.
  }
}
