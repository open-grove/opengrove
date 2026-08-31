import { APP_PROTOCOL_ID } from "../identity.js";

export function kernelIdForVaultPath(vaultPath: string): string {
  if (vaultPath === "Codex" || vaultPath.startsWith("Codex/")) return "codex";
  if (vaultPath === "Claude" || vaultPath.startsWith("Claude/")) return "claude-code";
  if (vaultPath === "Hermes" || vaultPath.startsWith("Hermes/")) return "hermes";
  return APP_PROTOCOL_ID;
}

export function sourceIdForVaultPath(vaultPath: string): string {
  if (vaultPath.startsWith("Codex/skills/")) return "codex.user-skills";
  if (vaultPath.startsWith("Codex/memories/")) return "codex.user-memories";
  if (vaultPath.startsWith("Codex/")) return "codex.user-files";
  if (vaultPath.startsWith("Claude/commands/")) return "claude.user-commands";
  if (vaultPath.startsWith("Claude/skills/")) return "claude.user-skills";
  if (vaultPath.startsWith("Claude/agents/")) return "claude.user-agents";
  if (vaultPath.startsWith("Claude/memory/")) return "claude.user-agent-memory";
  if (vaultPath.startsWith("Claude/")) return "claude.user-files";
  if (vaultPath.startsWith("Hermes/skills/")) return "hermes.local-skills";
  if (vaultPath.startsWith("Hermes/memory/")) return "hermes.memories";
  if (vaultPath.startsWith("Hermes/")) return "hermes.local-files";
  return `${APP_PROTOCOL_ID}.vault`;
}
