export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DESKTOP_BRIDGE_LONG_WAIT_MS = 45_000;

export function resolveStartupTimeoutMs(options: { timeoutMs?: number; mode?: "desktop" | "auth" }): number {
  return options.timeoutMs ?? (options.mode === "desktop" ? DESKTOP_BRIDGE_LONG_WAIT_MS : DEFAULT_STARTUP_TIMEOUT_MS);
}
