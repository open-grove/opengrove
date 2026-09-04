import type {
  DesktopBridgeStartupBlockerAction,
  DesktopBridgeStartupState,
} from "../src/desktop-bridge-startup-state.js";

interface DesktopBridgeRuntimeIdentity {
  apiBase: string;
  pid: number;
}

interface RetryStateInput {
  attempt: number;
  retryInMs: number;
  message: string;
}

interface BlockedStateInput {
  attempt: number;
  code: string;
  message: string;
  actions: DesktopBridgeStartupBlockerAction[];
}

export class DesktopBridgeHostController<Runtime extends DesktopBridgeRuntimeIdentity> {
  private stateValue: DesktopBridgeStartupState = { stage: "starting", attempt: 1 };
  private runtimeValue: Runtime | undefined;
  private generation = 0;

  constructor(private readonly onStateChange: (state: DesktopBridgeStartupState) => void) {}

  get state(): DesktopBridgeStartupState {
    return this.stateValue;
  }

  get runtime(): Runtime | undefined {
    return this.runtimeValue;
  }

  get readyRuntime(): Runtime | undefined {
    return this.stateValue.stage === "ready" ? this.runtimeValue : undefined;
  }

  starting(attempt = 1): void {
    this.runtimeValue = undefined;
    this.publish({ stage: "starting", attempt });
  }

  migrating(attempt?: number): void {
    this.runtimeValue = undefined;
    const currentAttempt = "attempt" in this.stateValue ? this.stateValue.attempt : 1;
    this.publish({ stage: "migrating", attempt: attempt ?? currentAttempt });
  }

  retrying(input: RetryStateInput): void {
    this.runtimeValue = undefined;
    this.publish({ stage: "retrying", ...input });
  }

  blocked(input: BlockedStateInput): void {
    this.runtimeValue = undefined;
    this.publish({ stage: "blocked", ...input });
  }

  maintenance(operation: "storage_cleanup"): void {
    this.publish({ stage: "maintenance", operation });
  }

  completeMaintenance(runtime: Runtime): boolean {
    if (this.stateValue.stage !== "maintenance" || !this.runtimeValue || !sameRuntime(this.runtimeValue, runtime)) {
      return false;
    }
    return this.activate(runtime);
  }

  activate(runtime: Runtime): boolean {
    if (this.stateValue.stage === "ready" && this.runtimeValue && sameRuntime(this.runtimeValue, runtime)) return false;
    this.runtimeValue = runtime;
    this.generation += 1;
    this.publish({ stage: "ready", generation: this.generation });
    return true;
  }

  detach(): void {
    this.runtimeValue = undefined;
  }

  private publish(state: DesktopBridgeStartupState): void {
    this.stateValue = state;
    this.onStateChange(state);
  }
}

function sameRuntime(left: DesktopBridgeRuntimeIdentity, right: DesktopBridgeRuntimeIdentity): boolean {
  return left.pid === right.pid && left.apiBase === right.apiBase;
}
