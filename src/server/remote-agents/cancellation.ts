import { AgentRouterError, taskStatusText, taskText } from "@agent-router/sdk";
import { hostMessage } from "../../localization/host-messages.js";
import type { RoomChannelMessage } from "../../rooms/channel-store.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { cancelRoomAssistantRun } from "../room-runs/scheduler.js";
import { networkProblem, requireNetworkConnection, type NetworkRouteContext } from "./session.js";

/** Stop local recovery before attempting an independently authorized remote cancellation. */
export async function stopRemoteRoomRun(context: NetworkRouteContext, message: RoomChannelMessage): Promise<void> {
  const { state } = context;
  const rooms = state.app.rooms;
  const target = rooms.listMembers().find((member) => member.id === message.senderId);
  const network = message.remoteTask;
  const locale = resolveHostLanguageSettings(state.settings);
  const attempted = Boolean(network?.sendStarted || network?.taskId);
  rooms.updateMessage(message.roomId, message.id, {
    status: "interrupted",
    finishedAt: new Date().toISOString(),
    ...(network
      ? {
          remoteTask: {
            ...network,
            pending: false,
            needsInput: false,
            cancelRequested: true,
            statusText: hostMessage(locale, attempted ? "remote.stopped_unconfirmed" : "remote.cancelled_before_send"),
          },
        }
      : {}),
  });
  const hasOtherWork = rooms
    .snapshot()
    .messages.some((candidate) => candidate.senderId === message.senderId && candidate.status === "running");
  if (target && !hasOtherWork) rooms.patchMember(target.id, { status: "idle", lastActive: new Date().toISOString() });
  state.store.saveFrom(state.app);
  if (message.runId) cancelRoomAssistantRun(state, message.runId);

  // A missing receipt is not proof of non-delivery. Never resend an uncertain submission just to cancel it.
  if (!network?.taskId) return;
  const binding = target?.remoteAgent;
  const taskId = network.taskId;
  if (!binding) return;
  try {
    const connection = await requireNetworkConnection(context, binding);
    const task = await connection.request(({ client, sender, signal }) =>
      client.cancel({
        agentId: sender.id,
        address: binding.address,
        resolvedTarget: { address: binding.address, matrixId: binding.matrixId },
        taskId,
        signal,
      }),
    );
    if (task.id !== network.taskId || task.contextId !== network.contextId)
      throw new AgentRouterError("remote_context_mismatch");
    const completed = task.status.state === "TASK_STATE_COMPLETED";
    const cancelled = task.status.state === "TASK_STATE_CANCELED";
    const failed = ["TASK_STATE_FAILED", "TASK_STATE_REJECTED"].includes(task.status.state);
    if (!completed && !cancelled && !failed) return;
    const current = rooms.getMessage(message.roomId, message.id);
    if (!current?.remoteTask?.cancelRequested || current.remoteTask.pending || current.runId !== message.runId) return;
    rooms.updateMessage(message.roomId, message.id, {
      text: taskText(task) || current.text,
      status: completed ? "done" : cancelled ? "interrupted" : "failed",
      remoteTask: {
        ...current.remoteTask,
        statusText:
          taskStatusText(task) ||
          hostMessage(locale, completed ? "remote.completed" : cancelled ? "remote.cancelled" : "remote.failed"),
      },
    });
    state.store.saveFrom(state.app);
  } catch (error) {
    console.warn("remote_stop_unconfirmed", networkProblem(error).error);
  }
}
