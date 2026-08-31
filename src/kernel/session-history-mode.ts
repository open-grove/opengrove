import type { SessionHistoryMode } from "../core.js";
import type { KernelCapabilities } from "./types.js";

export function sessionHistoryModeForCapabilities(
  capabilities: Pick<KernelCapabilities, "sessionHistory">,
): SessionHistoryMode {
  return capabilities.sessionHistory === "kernel" ? "native" : "app";
}

/**
 * Native-thread kernels always remain authoritative for transcript history.
 * A caller may opt a stateless adapter into native mode, but may not make a
 * native kernel replay the Host transcript into its own persisted session.
 */
export function resolveSessionHistoryMode(
  capabilities: Pick<KernelCapabilities, "sessionHistory">,
  requested?: SessionHistoryMode,
): SessionHistoryMode {
  return capabilities.sessionHistory === "kernel" ? "native" : (requested ?? "app");
}
