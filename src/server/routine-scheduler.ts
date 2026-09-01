import type { Routine, ToolResult } from "../core.js";
import { runRoutine, type RoutineMemberStepRequest } from "../routines/routine-runner.js";
import type { BridgeState } from "./bridge-types.js";
import { createRoutineFlowInstanceObserver } from "./routine-flow-instance.js";
import { createRoutineProblemReporter } from "./routine-problems.js";
import { isRunnableRoomAssistantTarget, scheduleRoomAssistantRuns } from "./room-runs.js";
import { resolveWorkflowMemberRef } from "./workflow-member-ref.js";

const SCHEDULER_TICK_MS = 30_000;

interface RoutineSchedulerOptions {
  tickMs?: number;
  executeRoutine?: (state: BridgeState, routine: Routine) => Promise<void>;
}

/**
 * Start the background scheduler without making one long-lived Kernel turn the
 * liveness boundary for every other Routine. Individual turns retain their
 * native waiting semantics; producer loss and Host shutdown settle them.
 */
export function startRoutineScheduler(state: BridgeState, options: RoutineSchedulerOptions = {}): () => void {
  const activeRoutineIds = new Set<string>();
  const timer = setInterval(() => {
    for (const routine of claimDueRoutines(state, new Date(), activeRoutineIds)) {
      activeRoutineIds.add(routine.id);
      void executeScheduledRoutine(state, routine, options.executeRoutine)
        .catch((error: unknown) => {
          console.error(`scheduled routine ${routine.id} failed:`, error instanceof Error ? error.message : error);
        })
        .finally(() => {
          activeRoutineIds.delete(routine.id);
        });
    }
  }, options.tickMs ?? SCHEDULER_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function tickRoutineScheduler(
  state: BridgeState,
  now = new Date(),
  options: Pick<RoutineSchedulerOptions, "executeRoutine"> = {},
): Promise<string[]> {
  const claimed = claimDueRoutines(state, now);
  await Promise.all(
    claimed.map(async (routine) => {
      try {
        await executeScheduledRoutine(state, routine, options.executeRoutine);
      } catch (error) {
        console.error(`scheduled routine ${routine.id} failed:`, error instanceof Error ? error.message : error);
      }
    }),
  );
  return claimed.map((routine) => routine.id);
}

function claimDueRoutines(state: BridgeState, now: Date, activeRoutineIds = new Set<string>()): Routine[] {
  const claimed: Routine[] = [];
  for (const routine of state.app.routines.list("active")) {
    if (activeRoutineIds.has(routine.id)) continue;
    if (routine.trigger !== "schedule") continue;
    if (!isRoutineDue(routine, now)) continue;
    state.app.routines.update(routine.id, {
      schedule: { ...routine.schedule!, lastFiredAt: now.toISOString() },
    });
    state.store.saveFrom(state.app);
    claimed.push(routine);
  }
  return claimed;
}

async function executeScheduledRoutine(
  state: BridgeState,
  routine: Routine,
  executeRoutine: RoutineSchedulerOptions["executeRoutine"],
): Promise<void> {
  if (executeRoutine) {
    await executeRoutine(state, routine);
  } else {
    await runRoutine(state.app, routine.id, {
      memberExecutor: createRoutineMemberExecutor(state),
      problemReporter: createRoutineProblemReporter(state),
      statusObserver: createRoutineFlowInstanceObserver(state),
    });
  }
  state.store.saveFrom(state.app);
}

export function isRoutineDue(routine: Routine, now: Date): boolean {
  const schedule = routine.schedule;
  if (!schedule) return false;
  if (schedule.daysOfWeek?.length && !schedule.daysOfWeek.includes(now.getDay())) return false;

  if (typeof schedule.everyMinutes === "number") {
    if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes < 1) return false;
    if (!schedule.lastFiredAt) return true;
    const lastFired = new Date(schedule.lastFiredAt);
    if (Number.isNaN(lastFired.getTime())) return true;
    return now.getTime() - lastFired.getTime() >= schedule.everyMinutes * 60_000;
  }

  if (!schedule.at) return false;
  const match = schedule.at.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return false;

  const fireAt = new Date(now);
  fireAt.setHours(hour, minute, 0, 0);
  if (now < fireAt) return false;

  if (!schedule.lastFiredAt) return true;
  const lastFired = new Date(schedule.lastFiredAt);
  return lastFired < fireAt;
}

export function createRoutineMemberExecutor(state: BridgeState) {
  return (request: RoutineMemberStepRequest): Promise<ToolResult> => {
    const runnable = resolveWorkflowMemberRef(state.app.rooms, {
      memberId: request.memberId,
      requireRunnable: true,
    });
    if (!runnable) {
      const candidate = resolveWorkflowMemberRef(state.app.rooms, { memberId: request.memberId });
      if (candidate && !isRunnableRoomAssistantTarget(candidate.member)) {
        return Promise.resolve({ ok: false, error: `member_not_runnable:${request.memberId}` });
      }
      return Promise.resolve({ ok: false, error: `member_not_found:${request.memberId}` });
    }
    const target = resolveWorkflowMemberRef(state.app.rooms, {
      memberId: request.memberId,
      roomId: request.roomId,
      requireInRoom: true,
      requireRunnable: true,
    });
    if (!target?.room) {
      return Promise.resolve({ ok: false, error: `room_not_found_for_member:${request.memberId}` });
    }
    const member = target.member;
    const roomId = target.room.id;

    const posted = state.app.rooms.postSystemTargetedMessage({
      roomId,
      senderName: "OpenGrove Routine",
      text: request.prompt,
      targetIds: [member.id],
      assistantTargets: [member],
      deliveryKind: "system_routine",
    });
    state.store.saveFrom(state.app);

    return new Promise<ToolResult>((resolve) => {
      const scheduled = scheduleRoomAssistantRuns(state, {
        roomId,
        triggerMessageId: posted.userMessage.id,
        targets: [member],
        assistantMessages: posted.assistantMessages,
        onMessageFinalized: ({ message, error, problem }) => {
          if (error || message.status === "failed") {
            resolve({
              ok: false,
              error: error ?? message.text ?? "member_step_failed",
              ...(problem ? { problem } : {}),
            });
            return;
          }
          resolve({
            ok: true,
            value: {
              memberId: member.id,
              requestedMemberId: request.memberId,
              roomId,
              messageId: message.id,
              runId: message.runId ?? scheduled[0]?.runId ?? "",
              text: message.text ?? "",
            },
          });
        },
      });
      if (scheduled.length === 0) {
        resolve({ ok: false, error: `member_run_not_scheduled:${request.memberId}` });
        return;
      }
      const started = scheduled[0];
      if (started?.runId) {
        void Promise.resolve(
          request.onStarted?.({
            runId: started.runId,
            messageId: started.id,
            roomId,
          }),
        ).catch((error: unknown) => {
          console.error("routine member step started callback failed:", error instanceof Error ? error.message : error);
        });
      }
    });
  };
}
