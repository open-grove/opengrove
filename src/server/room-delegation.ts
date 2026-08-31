import type { ToolResult } from "../core.js";
import type { RoomChannelMember, RoomChannelMessage, RoomChannelRoom } from "../rooms/channel-store.js";
import type { BridgeState } from "./bridge-types.js";
import { isPmAutoRouteTurn, isRoomPmMember } from "../rooms/room-pm.js";
import {
  DEFAULT_ROOM_DELEGATION_CHAIN_DEPTH,
  DEFAULT_ROOM_DELEGATIONS_PER_RUN,
  releaseRoomDelegationBudget,
  reserveRoomDelegationBudget,
} from "./room-delegation-budget.js";
import { isRunnableRoomAssistantTarget, scheduleRoomAssistantRuns } from "./room-runs.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { hostMessage } from "../localization/host-messages.js";

export interface RoomDelegationInput {
  targetMemberId: string;
  prompt?: string;
  sourceRunId?: string;
  roomId?: string;
}

export interface RoomDelegationValue {
  taskId: string;
  roomId: string;
  messageId: string;
  state: "TASK_STATE_SUBMITTED";
  bodySource?: "author_original";
  promptIgnored?: boolean;
  [key: string]: string | boolean | undefined;
}

interface RoomDelegationSource {
  sourceRunId: string;
  sourceRunMessage: RoomChannelMessage;
  triggerMessage: RoomChannelMessage;
  sourceMember: RoomChannelMember;
  room: RoomChannelRoom;
}

export function findRoomPmMember(state: BridgeState, roomId: string): RoomChannelMember | undefined {
  const room = state.app.rooms.getRoom(roomId);
  if (!room || room.kind === "direct") return undefined;

  const membersById = new Map(state.app.rooms.listMembers().map((member) => [member.id, member]));
  const roomMembers = room.memberIds
    .map((memberId) => membersById.get(memberId))
    .filter((member): member is RoomChannelMember => Boolean(member));
  const runnablePmMembers = roomMembers.filter(
    (member) => isRoomPmMember(member) && isRunnableRoomAssistantTarget(member),
  );
  const appIds = new Set<string>();
  for (const member of roomMembers) {
    const appId = member.appId?.trim();
    if (appId) appIds.add(appId);
  }
  if (appIds.size === 1) {
    const [appId] = [...appIds];
    const scopedPm = runnablePmMembers.find((member) => member.appId === appId);
    if (scopedPm) return scopedPm;
  }
  return runnablePmMembers.find((member) => !member.appId);
}

export async function delegateRoomTask(state: BridgeState, input: RoomDelegationInput): Promise<ToolResult> {
  const rootState = state.rootState ?? state;
  const targetMemberId = input.targetMemberId.trim();
  const prompt = input.prompt?.trim() ?? "";
  const sourceRunId = input.sourceRunId?.trim() ?? "";
  const explicitRoomId = input.roomId?.trim() ?? "";
  if (!targetMemberId) return { ok: false, error: "target_member_id_required" };
  if (!sourceRunId) {
    if (!prompt) return { ok: false, error: "prompt_required" };
    if (!explicitRoomId) return { ok: false, error: "source_run_id_required" };
    return delegateSystemRoomTask(rootState, {
      roomId: explicitRoomId,
      targetMemberId,
      prompt,
    });
  }

  const source = resolveDelegationSource(rootState, sourceRunId);
  if ("error" in source) return { ok: false, error: source.error };
  const isPmAutoRoute = isPmAutoRouteTurn(source.sourceMember, source.triggerMessage);
  if (!isPmAutoRoute && !prompt) return { ok: false, error: "prompt_required" };
  if (explicitRoomId && explicitRoomId !== source.room.id) {
    return { ok: false, error: `source_room_mismatch:${explicitRoomId}` };
  }
  if (!source.room.adminMemberIds.includes(source.sourceMember.id)) {
    return {
      ok: false,
      error: "delegation_requires_room_admin",
    };
  }
  if (source.sourceMember.id === targetMemberId) {
    return { ok: false, error: "self_delegation_not_allowed" };
  }
  if (!source.room.memberIds.includes(targetMemberId)) {
    return { ok: false, error: `target_not_in_source_room:${targetMemberId}` };
  }
  const target = rootState.app.rooms.listMembers().find((member) => member.id === targetMemberId);
  if (!target) return { ok: false, error: `member_not_found:${targetMemberId}` };
  if (!isRunnableRoomAssistantTarget(target)) {
    return { ok: false, error: `member_not_runnable:${targetMemberId}` };
  }

  const collaboration = rootState.settings.roomCollaboration;
  const maxChainDepth = collaboration?.maxDelegationChainDepth ?? DEFAULT_ROOM_DELEGATION_CHAIN_DEPTH;
  const chainDepth = delegationChainDepth(rootState, source.room.id, source.triggerMessage);
  if ("error" in chainDepth) return { ok: false, error: chainDepth.error };
  if (chainDepth.depth >= maxChainDepth) {
    return {
      ok: false,
      error: "delegation_chain_limit_reached",
    };
  }

  const reserved = reserveRoomDelegationBudget(rootState, {
    sourceRunId,
    targetMemberId,
    maxDelegationsPerRun: collaboration?.maxDelegationsPerRun ?? DEFAULT_ROOM_DELEGATIONS_PER_RUN,
  });
  if (!reserved.ok) {
    if (reserved.reason === "duplicate_target") {
      return {
        ok: false,
        error: `delegation_target_already_queued:${target.id}`,
      };
    }
    return { ok: false, error: "delegation_run_limit_reached" };
  }

  const rootMessageId = source.triggerMessage.rootMessageId ?? source.triggerMessage.id;
  const deliveryKind = isPmAutoRoute ? ("pm_auto_route" as const) : ("agent_delegation" as const);
  const delegatedMessage = rootState.app.rooms.postAgentMessage({
    roomId: source.room.id,
    senderId: source.sourceMember.id,
    senderName: source.sourceMember.name,
    text: isPmAutoRoute ? source.triggerMessage.text : prompt,
    targetIds: [target.id],
    deliveryKind,
    inReplyToMessageId: source.triggerMessage.id,
    rootMessageId,
  });
  const targetPlaceholder = rootState.app.rooms.createAssistantPlaceholder({
    roomId: source.room.id,
    target,
    inReplyToMessageId: delegatedMessage.id,
    rootMessageId,
  });
  rootState.store.saveFrom(rootState.app);

  return scheduleDelegatedTarget(rootState, {
    roomId: source.room.id,
    triggerMessage: delegatedMessage,
    target,
    targetPlaceholder,
    reservedBudget: { sourceRunId, targetMemberId },
    ...(isPmAutoRoute
      ? {
          submissionMetadata: {
            bodySource: "author_original" as const,
            ...(prompt ? { promptIgnored: true } : {}),
          },
        }
      : {}),
  });
}

function delegateSystemRoomTask(
  state: BridgeState,
  input: { roomId: string; targetMemberId: string; prompt: string },
): ToolResult {
  const room = state.app.rooms.getRoom(input.roomId);
  if (!room) return { ok: false, error: `room_not_found:${input.roomId}` };
  if (!room.memberIds.includes(input.targetMemberId)) {
    return { ok: false, error: `target_not_in_source_room:${input.targetMemberId}` };
  }
  const target = state.app.rooms.listMembers().find((member) => member.id === input.targetMemberId);
  if (!target) return { ok: false, error: `member_not_found:${input.targetMemberId}` };
  if (!isRunnableRoomAssistantTarget(target)) {
    return { ok: false, error: `member_not_runnable:${input.targetMemberId}` };
  }
  const posted = state.app.rooms.postSystemTargetedMessage({
    roomId: room.id,
    senderName: "OpenGrove System",
    text: input.prompt,
    targetIds: [target.id],
    assistantTargets: [target],
    deliveryKind: "system_routine",
  });
  const targetPlaceholder = posted.assistantMessages[0];
  if (!targetPlaceholder) {
    return { ok: false, error: `delegated_placeholder_not_created:${target.id}` };
  }
  state.store.saveFrom(state.app);
  return scheduleDelegatedTarget(state, {
    roomId: room.id,
    triggerMessage: posted.userMessage,
    target,
    targetPlaceholder,
  });
}

function scheduleDelegatedTarget(
  state: BridgeState,
  input: {
    roomId: string;
    triggerMessage: RoomChannelMessage;
    target: RoomChannelMember;
    targetPlaceholder: RoomChannelMessage;
    reservedBudget?: { sourceRunId: string; targetMemberId: string };
    submissionMetadata?: Pick<RoomDelegationValue, "bodySource" | "promptIgnored">;
  },
): ToolResult {
  let scheduled: RoomChannelMessage[];
  try {
    scheduled = scheduleRoomAssistantRuns(state, {
      roomId: input.roomId,
      triggerMessageId: input.triggerMessage.id,
      targets: [input.target],
      assistantMessages: [input.targetPlaceholder],
    });
  } catch (error) {
    if (input.reservedBudget) releaseRoomDelegationBudget(state, input.reservedBudget);
    markDelegatedRunNotScheduled(state, input.roomId, input.targetPlaceholder, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const scheduledMessage = scheduled[0];
  if (!scheduledMessage?.runId) {
    if (input.reservedBudget) releaseRoomDelegationBudget(state, input.reservedBudget);
    markDelegatedRunNotScheduled(state, input.roomId, input.targetPlaceholder);
    return { ok: false, error: `delegated_run_not_scheduled:${input.target.id}` };
  }
  state.store.saveFrom(state.app);
  return {
    ok: true,
    value: {
      taskId: scheduledMessage.runId,
      roomId: input.roomId,
      messageId: scheduledMessage.id,
      state: "TASK_STATE_SUBMITTED",
      ...input.submissionMetadata,
    } satisfies RoomDelegationValue,
  };
}

export function delegationTargetSummaries(
  state: BridgeState,
  sourceRunId: string | undefined,
): Array<{ id: string; name: string; description: string }> {
  const rootState = state.rootState ?? state;
  const normalizedRunId = sourceRunId?.trim() ?? "";
  if (!normalizedRunId) return [];
  const source = resolveDelegationSource(rootState, normalizedRunId);
  if ("error" in source) return [];
  if (!source.room.adminMemberIds.includes(source.sourceMember.id)) return [];
  const membersById = new Map(rootState.app.rooms.listMembers().map((member) => [member.id, member]));
  return source.room.memberIds
    .map((memberId) => membersById.get(memberId))
    .filter((member): member is RoomChannelMember =>
      Boolean(member && member.id !== source.sourceMember.id && isRunnableRoomAssistantTarget(member)),
    )
    .map((member) => ({
      id: member.id,
      name: member.name || member.id,
      description: member.publicDescription?.trim() || "",
    }));
}

function resolveDelegationSource(state: BridgeState, sourceRunId: string): RoomDelegationSource | { error: string } {
  const sourceRunMessage = state.app.rooms
    .snapshot()
    .messages.find((message) => message.senderType === "agent" && message.runId === sourceRunId);
  if (!sourceRunMessage) return { error: `source_run_not_found:${sourceRunId}` };
  const room = state.app.rooms.getRoom(sourceRunMessage.roomId);
  if (!room) return { error: `source_room_not_found:${sourceRunMessage.roomId}` };
  const sourceMember = state.app.rooms.listMembers().find((member) => member.id === sourceRunMessage.senderId);
  if (!sourceMember) return { error: `source_member_not_found:${sourceRunMessage.senderId}` };
  if (!room.memberIds.includes(sourceMember.id)) {
    return { error: `source_not_in_source_room:${sourceMember.id}` };
  }
  const triggerMessageId = sourceRunMessage.inReplyToMessageId?.trim() ?? "";
  if (!triggerMessageId) return { error: `source_trigger_message_missing:${sourceRunId}` };
  const triggerMessage = state.app.rooms.getMessage(room.id, triggerMessageId);
  if (!triggerMessage) return { error: `source_trigger_message_not_found:${triggerMessageId}` };
  return { sourceRunId, sourceRunMessage, triggerMessage, sourceMember, room };
}

function delegationChainDepth(
  state: BridgeState,
  roomId: string,
  triggerMessage: RoomChannelMessage,
): { depth: number } | { error: string } {
  const expectedRootId = triggerMessage.rootMessageId;
  const visited = new Set<string>();
  let current = triggerMessage;
  let depth = 0;
  for (;;) {
    if (visited.has(current.id)) return { error: `delegation_chain_invalid:cycle:${current.id}` };
    visited.add(current.id);
    if (
      current.senderType === "agent" &&
      (current.deliveryKind === "agent_delegation" || current.deliveryKind === "pm_auto_route")
    ) {
      depth += 1;
    }
    const parentId = current.inReplyToMessageId?.trim() ?? "";
    if (!parentId) {
      if (expectedRootId && current.id !== expectedRootId) {
        return { error: `delegation_chain_invalid:root_not_reached:${expectedRootId}` };
      }
      if (current.senderType === "agent") {
        return { error: `delegation_chain_invalid:agent_parent_missing:${current.id}` };
      }
      return { depth };
    }
    const parent = state.app.rooms.getMessage(roomId, parentId);
    if (!parent) return { error: `delegation_chain_invalid:parent_not_found:${parentId}` };
    current = parent;
  }
}

function markDelegatedRunNotScheduled(
  state: BridgeState,
  roomId: string,
  message: RoomChannelMessage,
  error?: unknown,
): void {
  const language = resolveHostLanguageSettings(state.settings);
  state.app.rooms.updateMessage(roomId, message.id, {
    status: "failed",
    text: hostMessage(language, "room.delegation_failed"),
    finishedAt: new Date().toISOString(),
    ...(error
      ? {
          parts: [
            {
              type: "tool",
              phase: "result",
              toolId: "room.delegate.task",
              title: hostMessage(language, "room.delegate_employee"),
              status: "incomplete",
              error: error instanceof Error ? error.message : String(error),
            },
          ],
        }
      : {}),
  });
  state.store.saveFrom(state.app);
}
