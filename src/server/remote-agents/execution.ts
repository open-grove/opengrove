import { buildRoomTextInput } from "../room-runs/envelope.js";
import type { BridgeState } from "../bridge-types.js";
import type { RoomRunExecutionInput } from "../room-runs/scheduler.js";
import type { RemoteRoomTask } from "../../rooms/remote-agent.js";
import { AgentRouterError, taskText, taskStatusText, type Task } from "@agent-router/sdk";
import { networkSessionsFor } from "./session.js";
import { hostMessage } from "../../localization/host-messages.js";
import { resolveHostLanguageSettings } from "../language-preference.js";

/** Network requests enter the same durable Room ledger, without creating a local Kernel run. */
export async function executeRemoteRoomRun(state: BridgeState, input: RoomRunExecutionInput): Promise<void> {
  const rooms = state.app.rooms;
  const binding = input.target.remoteAgent;
  if (!binding) throw new Error("remote_binding_missing");
  const shutdown = new AbortController();
  const locale = resolveHostLanguageSettings(state.settings);
  const trigger = rooms.getMessage(input.roomId, input.triggerMessageId);
  const assistant = rooms.getMessage(input.roomId, input.assistantMessageId);
  const previous = rooms
    .listMessages(input.roomId, { limit: 0 })
    .filter(
      (message) =>
        message.senderId === input.target.id && message.channelSeq < (assistant?.channelSeq ?? 0) && message.remoteTask,
    )
    .at(-1)?.remoteTask;
  let network: RemoteRoomTask = rooms.getMessage(input.roomId, input.assistantMessageId)?.remoteTask ?? {
    contextId: previous?.contextId,
    messageId: input.assistantMessageId,
    triggerMessageId: input.triggerMessageId,
    pending: true,
    ...(previous?.needsInput && previous.taskId ? { inputTaskId: previous.taskId } : {}),
  };
  let replyText = assistant?.text ?? "";
  let cancelSent = false;
  let observation: AbortController | undefined;
  let updates: AsyncGenerator<Task> | undefined;
  let lastPersisted = "";
  const persist = (statusText: string, status: "running" | "done" | "failed" | "interrupted") => {
    network = { ...network, statusText };
    const digest = JSON.stringify([network, replyText, status]);
    if (digest === lastPersisted) return;
    lastPersisted = digest;
    rooms.updateMessage(input.roomId, input.assistantMessageId, {
      text: replyText,
      status,
      remoteTask: network,
      finishedAt: status === "running" ? undefined : new Date().toISOString(),
    });
    rooms.patchMember(input.target.id, {
      status: status === "running" ? "running" : "idle",
      lastActive: new Date().toISOString(),
    });
    state.store.saveFrom(state.app);
  };
  const cancel = () => {
    if (input.signal?.reason === "host_shutdown") {
      shutdown.abort();
      return;
    }
    observation?.abort("cancel_requested");
    network = { ...network, cancelRequested: true };
    persist(hostMessage(locale, "remote.cancel_requested"), "running");
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (input.signal?.aborted) cancel();
    if (!trigger) throw new Error("remote_trigger_missing");
    if (trigger.attachments?.length || trigger.selectedFile) throw new Error("remote_text_only");
    if (trigger.text.length > 32000) throw new Error("remote_message_too_large");
    network = {
      ...network,
      requestText: network.requestText ?? buildRoomTextInput(state, input.roomId, input.target, trigger),
    };
    if (network.requestText!.length > 32000) throw new Error("remote_message_too_large");
    const connection = await networkSessionsFor(state).connect(binding, shutdown.signal);
    const resolvedTarget = { address: binding.address, matrixId: binding.matrixId };
    shutdown.signal.throwIfAborted();
    if (network.cancelRequested && !network.sendStarted && !network.taskId) {
      network.pending = false;
      persist(hostMessage(locale, "remote.cancelled_before_send"), "interrupted");
      return;
    }
    network = { ...network, sendStarted: true };
    persist(hostMessage(locale, "remote.connecting"), "running");
    // The server allocates the first context. Persist the key before sending so even a lost first response is replayable.
    let task: Task = await connection.request(({ client, sender, signal }) =>
      network.taskId
        ? client.get({ agentId: sender.id, address: binding.address, resolvedTarget, taskId: network.taskId, signal })
        : client.send({
            agentId: sender.id,
            address: binding.address,
            resolvedTarget,
            text: network.requestText!,
            contextId: network.contextId,
            messageId: network.messageId,
            taskId: network.inputTaskId,
            signal,
          }),
    );
    if ((network.contextId && task.contextId !== network.contextId) || (network.taskId && task.id !== network.taskId))
      throw new Error("remote_context_mismatch");
    network = { ...network, taskId: task.id, contextId: task.contextId };
    while (true) {
      shutdown.signal.throwIfAborted();
      const terminal = [
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
      ].includes(task.status.state);
      if (network.cancelRequested && !cancelSent && !terminal) {
        observation?.abort();
        updates = undefined;
        task = await connection.request(({ client, sender, signal }) =>
          client.cancel({ agentId: sender.id, address: binding.address, resolvedTarget, taskId: task.id, signal }),
        );
        if (task.id !== network.taskId || task.contextId !== network.contextId)
          throw new Error("remote_context_mismatch");
        cancelSent = true;
      }
      const phase = task.status.state;
      const done = phase === "TASK_STATE_COMPLETED" || phase === "TASK_STATE_INPUT_REQUIRED";
      const failed = ["TASK_STATE_FAILED", "TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED"].includes(phase);
      const cancelled = phase === "TASK_STATE_CANCELED";
      network = {
        ...network,
        pending: !(done || failed || cancelled),
        needsInput: phase === "TASK_STATE_INPUT_REQUIRED",
      };
      replyText = taskText(task);
      const remoteStatus = taskStatusText(task);
      persist(
        network.cancelRequested && network.pending
          ? hostMessage(locale, "remote.cancel_requested")
          : remoteStatus ||
              (phase === "TASK_STATE_INPUT_REQUIRED"
                ? hostMessage(locale, "remote.input_required")
                : done
                  ? hostMessage(locale, "remote.completed")
                  : cancelled
                    ? hostMessage(locale, "remote.cancelled")
                    : failed
                      ? hostMessage(locale, "remote.failed")
                      : hostMessage(locale, "remote.working")),
        done ? "done" : failed ? "failed" : cancelled ? "interrupted" : "running",
      );
      if (!network.pending) return;
      try {
        const next = await connection.request(async ({ client, sender, signal }) => {
          if (!updates) {
            observation = new AbortController();
            updates = client.watch({
              agentId: sender.id,
              address: binding.address,
              resolvedTarget,
              taskId: task.id,
              signal: AbortSignal.any([signal, observation.signal]),
            });
          }
          try {
            return await updates.next();
          } catch (error) {
            updates = undefined;
            throw error;
          }
        });
        if (next.done) throw new Error("remote_stream_ended");
        if (next.value.id !== task.id || next.value.contextId !== network.contextId)
          throw new Error("remote_context_mismatch");
        task = next.value;
      } catch (error) {
        if (!observation?.signal.aborted || !network.cancelRequested || cancelSent) throw error;
      }
    }
  } catch (error) {
    if (shutdown.signal.aborted) {
      network = { ...network, pending: true };
      persist(hostMessage(locale, "remote.connection_paused"), "interrupted");
      return;
    }
    const failure = error instanceof Error && error.cause instanceof AgentRouterError ? error.cause : error;
    const code = failure instanceof Error ? failure.message : "remote_connection_unavailable";
    const permanent = [
      "remote_binding_missing",
      "remote_trigger_missing",
      "remote_text_only",
      "remote_message_too_large",
      "remote_context_mismatch",
    ].includes(code);
    if (permanent) network = { ...network, pending: false };
    const reason = remoteFailureText(code, locale);
    persist(reason, "failed");
  } finally {
    observation?.abort();
    input.signal?.removeEventListener("abort", cancel);
  }
}

export function remoteFailureText(code: string, locale: Parameters<typeof hostMessage>[0]): string {
  return code === "remote_text_only"
    ? hostMessage(locale, "remote.text_only")
    : code === "not_authenticated" || code === "external_session_invalid"
      ? hostMessage(locale, "remote.login_required")
      : code === "external_role_required"
        ? hostMessage(locale, "remote.admin_required")
        : code === "remote_account_changed"
          ? hostMessage(locale, "remote.account_changed")
          : code === "invalid_response"
            ? hostMessage(locale, "remote.invalid_response")
            : code === "remote_sender_changed" || code === "remote_service_changed"
              ? hostMessage(locale, "remote.sender_changed")
              : code === "remote_message_too_large"
                ? hostMessage(locale, "remote.message_too_large")
                : hostMessage(locale, "remote.connection_unavailable");
}
