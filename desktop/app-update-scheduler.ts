import { createOpenGroveClient, OpenGroveClientError } from "#client";
import { APP_BRIDGE_TOKEN_HEADER } from "../src/identity.js";

const APP_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const APP_UPDATE_STARTUP_DELAY_MS = 8_000;
const APP_UPDATE_AUTH_MIN_INTERVAL_MS = 60_000;

interface DesktopAppUpdateConnection {
  apiBase: string;
  bridgeToken: string;
  cookieHeader: string | undefined;
}

export class DesktopAppUpdateScheduler {
  private startupTimer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private request: AbortController | undefined;
  private running = false;
  private lastCheckStartedAt = 0;

  constructor(
    private readonly options: {
      getConnection(): DesktopAppUpdateConnection | undefined;
      log(message: string): void;
    },
  ) {}

  start(): void {
    this.stop();
    this.running = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.check("startup", 0);
      this.interval = setInterval(() => void this.check("background", 0), APP_UPDATE_INTERVAL_MS);
    }, APP_UPDATE_STARTUP_DELAY_MS);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.startupTimer);
    clearInterval(this.interval);
    this.startupTimer = undefined;
    this.interval = undefined;
    this.request?.abort();
  }

  async check(reason: string, minIntervalMs = APP_UPDATE_AUTH_MIN_INTERVAL_MS): Promise<void> {
    if (!this.running || this.request || Date.now() - this.lastCheckStartedAt < minIntervalMs) return;
    const connection = this.options.getConnection();
    // The trusted token selects the Bridge's non-refreshing auth path. Never
    // let an unattended request consume a refresh token that it may not retain.
    if (!connection?.bridgeToken || !connection.cookieHeader) return;
    const controller = new AbortController();
    this.request = controller;
    this.lastCheckStartedAt = Date.now();
    try {
      const client = createOpenGroveClient({
        baseUrl: connection.apiBase,
        headers: { [APP_BRIDGE_TOKEN_HEADER]: connection.bridgeToken, cookie: connection.cookieHeader },
      });
      const result = await client.apps.updates.schedule({
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      this.options.log(`app update check: ${reason} ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof OpenGroveClientError && error.status === 401) {
        this.options.log(`app update check: ${reason} skipped not_authenticated`);
      } else {
        this.options.log(
          `app_update_schedule_failed: ${reason} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.request = undefined;
    }
  }
}
