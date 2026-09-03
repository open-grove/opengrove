import { readAppEnv } from "../identity.js";
import { KERNEL_CAPABILITY_CONTRACTS } from "./capabilities/contracts.js";

export type ClaudeCodeRuntimeMode = "cli" | "sdk";

export function resolveClaudeCodeRuntimeMode(): ClaudeCodeRuntimeMode {
  // Only the in-process Agent SDK can receive OpenGrove Host Tools. The CLI
  // runtime is an explicit escape hatch and therefore cannot auto-route work.
  const configured = readAppEnv("CLAUDE_CODE_RUNTIME")?.trim().toLowerCase();
  if (configured === "cli") return "cli";
  if (configured === "sdk") return "sdk";
  return "sdk";
}

/**
 * Static Host Tool capability used both by adapters and pre-run routing gates.
 * Keep this resolver free of adapter construction, CLI probes, and state I/O.
 */
export function bridgeKernelSupportsHostTools(kernelId: string): boolean {
  if (kernelId === "claude-code" && resolveClaudeCodeRuntimeMode() !== "sdk") return false;
  return (
    KERNEL_CAPABILITY_CONTRACTS.find((contract) => contract.kernel === kernelId)?.mappings.some(
      (mapping) => mapping.capability === "tools.hostTool" && mapping.status === "mapped",
    ) === true
  );
}
