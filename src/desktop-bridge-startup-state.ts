export const DESKTOP_BRIDGE_STARTUP_STATE_QUERY_CHANNEL = "opengrove:desktop:get-bridge-startup-state";
export const DESKTOP_BRIDGE_STARTUP_STATE_CHANGE_CHANNEL = "opengrove:desktop:bridge-startup-state";
export const DESKTOP_BRIDGE_STARTUP_ACTIVITY_MESSAGE_TYPE = "opengrove.desktop.bridge.startup-activity";

export type DesktopBridgeStartupActivity = "migrating_local_data";

export interface DesktopBridgeStartupActivityMessage {
  type: typeof DESKTOP_BRIDGE_STARTUP_ACTIVITY_MESSAGE_TYPE;
  activity: DesktopBridgeStartupActivity;
}

export type DesktopBridgeStartupBlockerAction =
  | "stop_blocking_process"
  | "repair_state_access"
  | "open_data_dir"
  | "retry";

export type DesktopBridgeStartupState =
  | {
      stage: "starting";
      attempt: number;
    }
  | {
      stage: "migrating";
      attempt: number;
    }
  | {
      stage: "retrying";
      attempt: number;
      retryInMs: number;
      message: string;
    }
  | {
      stage: "blocked";
      attempt: number;
      code: string;
      message: string;
      actions: DesktopBridgeStartupBlockerAction[];
    }
  | {
      stage: "ready";
      generation: number;
    };

export function isDesktopBridgeStartupState(value: unknown): value is DesktopBridgeStartupState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.stage === "ready") return positiveAttempt(candidate.generation);
  if (candidate.stage === "starting") return positiveAttempt(candidate.attempt);
  if (candidate.stage === "migrating") return positiveAttempt(candidate.attempt);
  if (candidate.stage === "retrying") {
    return (
      positiveAttempt(candidate.attempt) &&
      typeof candidate.retryInMs === "number" &&
      Number.isFinite(candidate.retryInMs) &&
      candidate.retryInMs >= 0 &&
      typeof candidate.message === "string"
    );
  }
  if (candidate.stage === "blocked") {
    return (
      positiveAttempt(candidate.attempt) &&
      typeof candidate.code === "string" &&
      typeof candidate.message === "string" &&
      Array.isArray(candidate.actions) &&
      candidate.actions.every(isDesktopBridgeStartupBlockerAction)
    );
  }
  return false;
}

export function isDesktopBridgeStartupActivityMessage(value: unknown): value is DesktopBridgeStartupActivityMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === DESKTOP_BRIDGE_STARTUP_ACTIVITY_MESSAGE_TYPE && candidate.activity === "migrating_local_data"
  );
}

function isDesktopBridgeStartupBlockerAction(value: unknown): value is DesktopBridgeStartupBlockerAction {
  return (
    value === "stop_blocking_process" ||
    value === "repair_state_access" ||
    value === "open_data_dir" ||
    value === "retry"
  );
}

function positiveAttempt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
