import type { AgentEvent, DiagnosticProblemRef } from "../../core.js";
import type { BridgeState } from "../bridge-types.js";
import type { BridgeWwRuntimeAuth } from "../ww-runtime-auth.js";
import type { RoomChannelMember, RoomChannelMessage } from "../../rooms/channel-store.js";
import { isRunnableRoomAssistantTarget } from "../../rooms/channel-store.js";
import { interruptRoomRunMessage, resetInactiveRoomMember } from "../../rooms/run-liveness.js";
import { hostMessage } from "../../localization/host-messages.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import {
  cancelActiveBridgeRun,
  clearActiveBridgeRunExecutionState,
  registerActiveBridgeRun,
  setActiveBridgeRunExecutionState,
} from "../active-runs.js";

export interface RoomRunInput {
  roomId: string;
  triggerMessageId: string;
  targets: RoomChannelMember[];
  assistantMessages: RoomChannelMessage[];
  wwAuth?: BridgeWwRuntimeAuth;
  traceId?: string;
  onMessageFinalized?(result: {
    target: RoomChannelMember;
    message: RoomChannelMessage;
    events: AgentEvent[];
    error?: string;
    problem?: DiagnosticProblemRef;
  }): void | Promise<void>;
}

export interface RoomRunExecutionInput {
  roomId: string;
  triggerMessageId: string;
  assistantMessageId: string;
  assistantMessage: RoomChannelMessage;
  runId: string;
  target: RoomChannelMember;
  wwAuth?: BridgeWwRuntimeAuth;
  traceId?: string;
  signal?: AbortSignal;
  onMessageFinalized?: RoomRunInput["onMessageFinalized"];
}

type RoomRunExecutor = (state: BridgeState, input: RoomRunExecutionInput) => Promise<void>;

const roomRunQueues = new WeakMap<BridgeState, Map<string, Promise<void>>>();
const roomRunControllers = new WeakMap<BridgeState, Map<string, AbortController>>();
const roomRunActiveReleases = new WeakMap<BridgeState, Map<string, () => void>>();

export function scheduleRoomAssistantRunsWithExecutor(
  state: BridgeState,
  input: RoomRunInput,
  executeRoomRun: RoomRunExecutor,
): RoomChannelMessage[] {
  const updatedMessages: RoomChannelMessage[] = [];
  for (const [index, target] of input.targets.entries()) {
    if (!isRunnableRoomAssistantTarget(target)) continue;
    const message = input.assistantMessages[index];
    if (!message) continue;
    const runId = createRoomRunId();
    const controller = new AbortController();
    let releaseActiveRun: () => void;
    try {
      releaseActiveRun = registerActiveBridgeRun(state, runId, { cancel: () => controller.abort() });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "bridge_runs_paused_for_storage_maintenance") throw error;
      const language = resolveHostLanguageSettings((state.rootState ?? state).settings);
      const updated = state.app.rooms.updateMessage(input.roomId, message.id, {
        text: hostMessage(language, "room.run_paused_for_maintenance"),
        status: "failed",
        finishedAt: new Date().toISOString(),
      });
      updatedMessages.push(updated);
      continue;
    }
    controllerMapForState(state).set(runId, controller);
    activeReleaseMapForState(state).set(runId, releaseActiveRun);
    const updated = state.app.rooms.updateMessage(input.roomId, message.id, {
      runId,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    updatedMessages.push(updated);
    let finalizationObserved = false;
    const notifyFinalized: RoomRunInput["onMessageFinalized"] = input.onMessageFinalized
      ? (result) => {
          if (finalizationObserved) return;
          finalizationObserved = true;
          return input.onMessageFinalized?.(result);
        }
      : undefined;
    enqueueRoomRun(state, input.roomId, target.id, async () => {
      try {
        await executeRoomRun(state, {
          roomId: input.roomId,
          triggerMessageId: input.triggerMessageId,
          assistantMessageId: message.id,
          assistantMessage: updated,
          runId,
          target,
          ...(input.wwAuth ? { wwAuth: input.wwAuth } : {}),
          traceId: input.traceId,
          signal: controller.signal,
          onMessageFinalized: notifyFinalized,
        });
      } finally {
        if (notifyFinalized && !finalizationObserved) {
          const rootState = state.rootState ?? state;
          const latest = rootState.app.rooms.getMessage?.(input.roomId, message.id) ?? updated;
          const error =
            latest.status === "done"
              ? undefined
              : latest.status === "interrupted"
                ? "member_step_canceled"
                : latest.status === "failed"
                  ? latest.text || "member_step_failed"
                  : "room_run_finalization_missing";
          try {
            await notifyFinalized({
              target,
              message: latest,
              events: [],
              ...(error ? { error } : {}),
            });
          } catch (error) {
            console.error("room run finalization callback failed:", error instanceof Error ? error.message : error);
          }
        }
      }
    });
  }
  return updatedMessages;
}

export function cancelRoomAssistantRun(state: BridgeState, runId: string): boolean {
  const controller = controllerMapForState(state).get(runId);
  if (!controller) return false;
  if (!cancelActiveBridgeRun(state, runId)) controller.abort();
  return true;
}

export function hasActiveRoomRunController(state: BridgeState, runId: string): boolean {
  return controllerMapForState(state).has(runId);
}

export function clearRoomRunController(state: BridgeState, runId: string): void {
  controllerMapForState(state).delete(runId);
  activeReleaseMapForState(state).get(runId)?.();
  activeReleaseMapForState(state).delete(runId);
}

export function activeRoomRunIds(state: BridgeState): ReadonlySet<string> {
  const rootState = state.rootState ?? state;
  return new Set(controllerMapForState(rootState).keys());
}

export function reapInactiveRoomRun(
  state: BridgeState,
  input: Pick<RoomRunExecutionInput, "roomId" | "assistantMessageId" | "runId">,
  timestamp = new Date().toISOString(),
): boolean {
  const rootState = state.rootState ?? state;
  const activeRunIds = activeRoomRunIds(rootState);
  if (activeRunIds.has(input.runId)) return false;
  const message = rootState.app.rooms.getMessage(input.roomId, input.assistantMessageId);
  if (message?.status !== "running" || message.runId !== input.runId) return false;

  const language = resolveHostLanguageSettings(rootState.settings);
  const fallbackText = hostMessage(language, "room.run_inactive");
  const idleText = hostMessage(language, "room.member_idle");
  const transientLastActiveTexts = [
    hostMessage(language, "room.member_running"),
    hostMessage(language, "room.member_waiting"),
  ];
  const interrupted = interruptRoomRunMessage(message, {
    fallbackText,
    reason: "run_inactive",
    timestamp,
  });
  rootState.app.rooms.updateMessage(input.roomId, input.assistantMessageId, {
    text: interrupted.text,
    status: interrupted.status,
    parts: interrupted.parts,
    finishedAt: interrupted.finishedAt,
  });

  const liveSenderIds = new Set(
    rootState.app.rooms
      .snapshot()
      .messages.filter(
        (message) => message.status === "running" && Boolean(message.runId && activeRunIds.has(message.runId)),
      )
      .map((message) => message.senderId),
  );
  if (!liveSenderIds.has(message.senderId)) {
    const member = rootState.app.rooms.listMembers().find((candidate) => candidate.id === message.senderId);
    const reset = member ? resetInactiveRoomMember(member, { idleText, transientLastActiveTexts }) : undefined;
    if (member && reset && reset !== member) {
      rootState.app.rooms.patchMember(member.id, {
        status: reset.status,
        lastActive: reset.lastActive,
      });
    }
  }
  rootState.store.saveFrom(rootState.app);
  return true;
}

export function registerActiveRoomRunExecutionState(
  state: BridgeState,
  runId: string,
  executionState: BridgeState,
): void {
  setActiveBridgeRunExecutionState(state, runId, executionState);
}

export function clearActiveRoomRunExecutionState(state: BridgeState, runId: string): void {
  clearActiveBridgeRunExecutionState(state, runId);
}

// re-export 自 rooms 层(channel-store.ts),保持 room-runs barrel 的现有 import 不变。
// 权威定义已下沉到 rooms 层(它是 member 属性,app 层 workflow.create 也要用)。
export { isRunnableRoomAssistantTarget } from "../../rooms/channel-store.js";

function enqueueRoomRun(state: BridgeState, roomId: string, memberId: string, task: () => Promise<void>): void {
  const queues = queueMapForState(state);
  const queueKey = JSON.stringify([roomId, memberId]);
  const previous = queues.get(queueKey) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(task);
  queues.set(queueKey, queued);
  const cleanup = () => {
    if (queues.get(queueKey) === queued) {
      queues.delete(queueKey);
    }
  };
  void queued.then(cleanup, cleanup);
}

function queueMapForState(state: BridgeState): Map<string, Promise<void>> {
  let queues = roomRunQueues.get(state);
  if (!queues) {
    queues = new Map();
    roomRunQueues.set(state, queues);
  }
  return queues;
}

function controllerMapForState(state: BridgeState): Map<string, AbortController> {
  const rootState = state.rootState ?? state;
  let controllers = roomRunControllers.get(rootState);
  if (!controllers) {
    controllers = new Map();
    roomRunControllers.set(rootState, controllers);
  }
  return controllers;
}

function activeReleaseMapForState(state: BridgeState): Map<string, () => void> {
  const rootState = state.rootState ?? state;
  let releases = roomRunActiveReleases.get(rootState);
  if (!releases) {
    releases = new Map();
    roomRunActiveReleases.set(rootState, releases);
  }
  return releases;
}

function createRoomRunId(): string {
  return `room_run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}
