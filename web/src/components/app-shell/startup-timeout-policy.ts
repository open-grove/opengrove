export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DESKTOP_BRIDGE_STARTUP_TIMEOUT_MS = 45_000;

export function resolveStartupTimeoutMs(options: { timeoutMs?: number; recoveringLocalService?: boolean }): number {
  return (
    options.timeoutMs ??
    (options.recoveringLocalService ? DESKTOP_BRIDGE_STARTUP_TIMEOUT_MS : DEFAULT_STARTUP_TIMEOUT_MS)
  );
}
