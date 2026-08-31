const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface DesktopBridgeStartupFailure {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

interface DesktopBridgeStartupRecoveryOptions<Runtime> {
  beforeFirstAttempt(): void;
  start(): Promise<Runtime>;
  isStopping(): boolean;
  isBlocker(error: unknown): boolean;
  onFailure(failure: DesktopBridgeStartupFailure): void;
  onBlocked(failure: Omit<DesktopBridgeStartupFailure, "delayMs">): void;
  waitForRetry(delayMs: number): Promise<void>;
}

export async function startDesktopBridgeWithRecovery<Runtime>(
  options: DesktopBridgeStartupRecoveryOptions<Runtime>,
): Promise<Runtime> {
  options.beforeFirstAttempt();
  for (let attempt = 1; ; attempt += 1) {
    if (options.isStopping()) {
      throw new Error("desktop_bridge_startup_stopped");
    }
    try {
      return await options.start();
    } catch (error) {
      if (options.isStopping()) throw error;
      if (options.isBlocker(error)) {
        options.onBlocked({ attempt, error });
        throw error;
      }
      const delayMs = desktopBridgeRetryDelay(attempt);
      options.onFailure({ attempt, delayMs, error });
      await options.waitForRetry(delayMs);
    }
  }
}

export function desktopBridgeRetryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(attempt) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** exponent);
}

export class DesktopBridgeStartupRetrySignal {
  private releaseWait: (() => void) | undefined;

  wait(delayMs: number): Promise<void> {
    this.releaseWait?.();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.releaseWait === finish) this.releaseWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, delayMs));
      this.releaseWait = finish;
    });
  }

  retryNow(): void {
    this.releaseWait?.();
  }
}
