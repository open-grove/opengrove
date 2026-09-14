import { refreshCodexCommandPath } from "../runtime/codex/command-path.js";
import { recreateBridgeApp } from "./bridge-state.js";
import type { BridgeState } from "./bridge-types.js";
import { isBridgeKernelAvailable } from "./kernel-selection.js";

const scans = new WeakMap<BridgeState, { checkedAt?: number; pending?: Promise<void>; pendingForced?: boolean }>();

/** Settings can report progress without waiting for registry/package enumeration. */
export function windowsKernelDiscoveryPending(state: BridgeState): boolean {
  return Boolean(scans.get(state)?.pending);
}

export function refreshWindowsKernelDiscovery(state: BridgeState, options: { force?: boolean } = {}): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  let scan = scans.get(state);
  if (!scan) {
    scan = {};
    scans.set(state, scan);
  }
  if (scan.pending) {
    return options.force && !scan.pendingForced
      ? scan.pending.then(() => refreshWindowsKernelDiscovery(state, options))
      : scan.pending;
  }
  if (!options.force && scan.checkedAt !== undefined && Date.now() - scan.checkedAt < 60_000) return Promise.resolve();
  const current = scan;
  current.pendingForced = options.force === true;
  current.pending = refreshCodexCommandPath({ force: options.force })
    .then((command) => {
      // A Store-only install may appear after the initial unavailable adapter
      // was created. Recover that adapter as well as the Settings catalog.
      if (
        command &&
        state.settings.kernel === "codex" &&
        state.kernelUnavailableReason &&
        isBridgeKernelAvailable(state, "codex")
      ) {
        recreateBridgeApp(state);
      }
    })
    .catch((error: unknown) => {
      console.warn(`[windows-discovery] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      current.checkedAt = Date.now();
      current.pending = undefined;
    });
  return current.pending;
}
