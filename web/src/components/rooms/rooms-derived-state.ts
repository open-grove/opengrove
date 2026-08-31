import { useMemo, useRef } from "react";
import type { AgentEventRecord, RunRecord } from "../../bridge";
import { useI18n } from "../../i18n";
import type { MentionOption } from "./room-composer";
import type { MentionMenuState } from "./room-chat-utils";
import { groupEventsByRunId, isTerminalRunStatus, removedMemberForRoom, runRecordId } from "./rooms-guide";
import { visibleEmployeeDefinitions } from "./contacts-model";
import { ROOM_OWNER_MEMBER, directRoomMember, roomMemberDisplayName, type Room, type RoomMember } from "./rooms-model";

export function useRoomsDerivedState(input: {
  rooms: Room[];
  members: RoomMember[];
  deletedMemberIds: string[];
  activeRoom?: Room;
  memberQuery: string;
  memberPickerMode: "add" | "remove" | null;
  memberPickerQuery: string;
  mentionMenu: MentionMenuState;
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
}) {
  const { t } = useI18n();
  const deletedMemberIdSet = useMemo(() => new Set(input.deletedMemberIds), [input.deletedMemberIds]);
  const roomMembers = useMemo(
    () =>
      input.activeRoom
        ? (input.activeRoom.kind === "direct"
            ? [directRoomMember(input.activeRoom, input.members)].filter((member): member is RoomMember =>
                Boolean(member),
              )
            : input.activeRoom.memberIds
                .map((id) => input.members.find((member) => member.id === id))
                .filter((member): member is RoomMember => Boolean(member))
          ).map((member) => removedMemberForRoom(member, deletedMemberIdSet, t("rooms.statusRemoved")))
        : [],
    [deletedMemberIdSet, input.activeRoom, input.members, t],
  );
  const contactMembers = useMemo(() => {
    return visibleEmployeeDefinitions(
      input.members.filter((member) => !deletedMemberIdSet.has(member.id) && !member.disabled),
    );
  }, [deletedMemberIdSet, input.members]);
  const visibleRoomMembers = useMemo(
    () => (input.activeRoom?.kind === "group" ? [ROOM_OWNER_MEMBER, ...roomMembers] : roomMembers),
    [input.activeRoom?.kind, roomMembers],
  );
  const filteredMembers = useMemo(() => {
    const query = input.memberQuery.trim().toLowerCase();
    if (!query) return visibleRoomMembers;
    return visibleRoomMembers.filter(
      (member) =>
        roomMemberDisplayName(member).toLowerCase().includes(query) ||
        member.name.toLowerCase().includes(query) ||
        member.role.toLowerCase().includes(query) ||
        member.kernel.toLowerCase().includes(query),
    );
  }, [input.memberQuery, visibleRoomMembers]);
  const availableMembers = useMemo(() => {
    if (input.activeRoom?.kind !== "group") return [];
    const existingIds = new Set(input.activeRoom.memberIds);
    return contactMembers.filter((member) => !existingIds.has(member.id));
  }, [input.activeRoom, contactMembers]);
  const removableMembers = useMemo(() => {
    if (input.activeRoom?.kind !== "group" || roomMembers.length <= 1) return [];
    return roomMembers;
  }, [input.activeRoom?.kind, roomMembers]);
  const memberPickerOptions = useMemo(() => {
    const source =
      input.memberPickerMode === "add" ? availableMembers : input.memberPickerMode === "remove" ? removableMembers : [];
    const query = input.memberPickerQuery.trim().toLowerCase();
    if (!query) return source;
    return source.filter(
      (member) =>
        roomMemberDisplayName(member).toLowerCase().includes(query) ||
        member.name.toLowerCase().includes(query) ||
        member.role.toLowerCase().includes(query) ||
        member.kernel.toLowerCase().includes(query) ||
        member.model.toLowerCase().includes(query),
    );
  }, [availableMembers, input.memberPickerMode, input.memberPickerQuery, removableMembers]);
  const mentionOptions = useMemo(() => {
    const query = input.mentionMenu.query.trim().toLowerCase();
    const allOption: MentionOption = {
      id: "all",
      kind: "all",
      label: t("mountedApp.mentionAll"),
      detail: t("mountedApp.mentionAllHint"),
    };
    const allAliases = ["所有人", "全部", "all"];
    const includeAll =
      input.activeRoom?.kind === "group" && (!query || allAliases.some((alias) => alias.toLowerCase().includes(query)));
    const memberOptions: MentionOption[] = roomMembers
      .filter((member) => {
        if (member.disabled) return false;
        if (!query) return true;
        return [roomMemberDisplayName(member), member.name, member.role, member.kernel, member.model].some((value) =>
          value.toLowerCase().includes(query),
        );
      })
      .map((member) => ({
        id: member.id,
        kind: "member",
        label: roomMemberDisplayName(member),
        member,
      }));
    return [...(includeAll ? [allOption] : []), ...memberOptions];
  }, [input.activeRoom?.kind, input.mentionMenu.query, roomMembers, t]);
  const activeRoomRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const message of input.activeRoom?.messages ?? []) {
      if (message.runId) runIds.add(message.runId);
    }
    return runIds;
  }, [input.activeRoom?.messages]);
  const allRoomRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const room of input.rooms) {
      for (const message of room.messages) {
        if (message.runId) runIds.add(message.runId);
      }
    }
    return runIds;
  }, [input.rooms]);
  const activeRoomRuntimeEventsByRunId = useStableGroupedEvents(input.runtimeEvents, activeRoomRunIds);
  const allRoomRuntimeEventsByRunId = useStableGroupedEvents(input.runtimeEvents, allRoomRunIds);
  const runsById = useMemo(() => {
    const runs = new Map<string, RunRecord>();
    for (const run of input.runs ?? []) {
      const runId = runRecordId(run);
      if (runId) runs.set(runId, run);
    }
    return runs;
  }, [input.runs]);
  const runningRoomRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const room of input.rooms) {
      for (const message of room.messages) {
        if (message.status === "running" && message.runId) {
          runIds.add(message.runId);
        }
      }
    }
    return runIds;
  }, [input.rooms]);
  const runningRoomEventsByRunId = useStableGroupedEvents(input.runtimeEvents, runningRoomRunIds);
  const activeRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const run of input.runs ?? []) {
      const runId = runRecordId(run);
      if (runId && !isTerminalRunStatus(run.status)) {
        runIds.add(runId);
      }
    }
    return runIds;
  }, [input.runs]);

  return {
    activeRunIds,
    activeRoomRuntimeEventsByRunId,
    allRoomRunIds,
    allRoomRuntimeEventsByRunId,
    contactMembers,
    deletedMemberIdSet,
    filteredMembers,
    memberPickerOptions,
    mentionOptions,
    removableMembers,
    roomMembers,
    runningRoomEventsByRunId,
    runningRoomRunIds,
    runsById,
    visibleRoomMemberCount: visibleRoomMembers.length,
    visibleRoomMembers,
  };
}

function useStableGroupedEvents(
  runtimeEvents: AgentEventRecord[] | undefined,
  runIds: Set<string>,
): Map<string, AgentEventRecord[]> {
  const previousRef = useRef(new Map<string, AgentEventRecord[]>());
  return useMemo(() => {
    const next = groupEventsByRunId(runtimeEvents, runIds);
    for (const [runId, events] of next) {
      const previous = previousRef.current.get(runId);
      if (previous && sameEventRecords(previous, events)) {
        next.set(runId, previous);
      }
    }
    previousRef.current = next;
    return next;
  }, [runIds, runtimeEvents]);
}

function sameEventRecords(left: AgentEventRecord[], right: AgentEventRecord[]): boolean {
  return left.length === right.length && left.every((event, index) => event === right[index]);
}
