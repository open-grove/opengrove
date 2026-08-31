import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  applyRoomEvents,
  fetchRoomEvents,
  fetchRoomsInit,
  isRoomsSessionRequiredError,
  replaceRoomsFromServerSnapshot,
  type RoomEvent,
} from "./rooms-api";
import type { Room, RoomMember } from "./rooms-model";

export function reconcileDeletedRoomMemberIds(currentDeletedMemberIds: string[], members: RoomMember[]): string[] {
  const membersById = new Map(members.map((member) => [member.id, member]));
  return Array.from(
    new Set([
      ...currentDeletedMemberIds.filter((memberId) => membersById.get(memberId)?.disabled !== false),
      ...members.filter((member) => member.disabled).map((member) => member.id),
    ]),
  );
}

export function useRoomsServerSync(
  input: {
    roomsRef: MutableRefObject<Room[]>;
    membersRef: MutableRefObject<RoomMember[]>;
    deletedMemberIdsRef: MutableRefObject<string[]>;
    serverRoomsEventSeqRef: MutableRefObject<number>;
    setActiveRoomId: Dispatch<SetStateAction<string>>;
    setDeletedMemberIds: Dispatch<SetStateAction<string[]>>;
    setMembers: Dispatch<SetStateAction<RoomMember[]>>;
    setRooms: Dispatch<SetStateAction<Room[]>>;
    setRoomsHydrated: Dispatch<SetStateAction<boolean>>;
    enabled?: boolean;
    onSessionRequired?(): void;
  },
  sessionKey: string,
) {
  function reportSessionRequired(error: unknown): boolean {
    if (!isRoomsSessionRequiredError(error)) return false;
    input.onSessionRequired?.();
    return true;
  }

  useEffect(() => {
    if (input.enabled === false) return;
    let cancelled = false;
    let legacyServer = false;
    // A new auth session cannot inherit the previous session's snapshot/cursor checkpoint.
    let snapshotRequired = true;
    const abortController = new AbortController();
    const installSnapshot = async (): Promise<boolean> => {
      const snapshot = await fetchRoomsInit();
      if (!snapshot.ok || cancelled) return false;
      const synced = replaceRoomsFromServerSnapshot(snapshot);
      // Publish the in-memory checkpoint before React state so polling cannot
      // observe a new cursor paired with the previous Room snapshot.
      input.roomsRef.current = synced.rooms;
      input.membersRef.current = synced.members;
      input.deletedMemberIdsRef.current = synced.deletedMemberIds;
      input.serverRoomsEventSeqRef.current = snapshot.currentEventSeq;
      input.setRooms(synced.rooms);
      input.setMembers(synced.members);
      input.setDeletedMemberIds(synced.deletedMemberIds);
      input.setActiveRoomId((current) =>
        synced.rooms.some((room) => room.id === current) ? current : (synced.rooms[0]?.id ?? ""),
      );
      input.setRoomsHydrated(true);
      return true;
    };
    const poll = async (): Promise<boolean> => {
      if (snapshotRequired) {
        if (await installSnapshot()) snapshotRequired = false;
        return false;
      }
      let afterEventSeq = input.serverRoomsEventSeqRef.current;
      let currentEventSeq = afterEventSeq;
      const events: RoomEvent[] = [];
      let resetRequired = false;
      for (;;) {
        const result = await fetchRoomEvents(afterEventSeq, 200, {
          signal: abortController.signal,
          waitMs: events.length === 0 ? 25_000 : 0,
        });
        if (events.length === 0) {
          legacyServer = result.longPollSupported !== true;
        }
        if (!result.ok) break;
        if (result.resetRequired) {
          resetRequired = true;
          break;
        }
        currentEventSeq = result.currentEventSeq;
        events.push(...result.events);
        if (!result.hasMore || currentEventSeq <= afterEventSeq) break;
        afterEventSeq = currentEventSeq;
      }
      if (resetRequired) {
        await installSnapshot();
        return false;
      }
      if (!cancelled) {
        if (events.length) {
          const applied = applyRoomEvents(input.roomsRef.current, input.membersRef.current, events);
          if (applied.requiresResync) {
            await installSnapshot();
            return false;
          }
          const appliedDeletedMemberIds = reconcileDeletedRoomMemberIds(
            input.deletedMemberIdsRef.current,
            applied.members,
          );
          input.roomsRef.current = applied.rooms;
          input.membersRef.current = applied.members;
          input.deletedMemberIdsRef.current = appliedDeletedMemberIds;
          input.serverRoomsEventSeqRef.current = currentEventSeq;
          input.setMembers(applied.members);
          input.setDeletedMemberIds(appliedDeletedMemberIds);
          input.setRooms(applied.rooms);
        } else {
          input.serverRoomsEventSeqRef.current = currentEventSeq;
        }
      }
      return events.length > 0;
    };
    const sync = async () => {
      let failures = 0;
      while (!cancelled) {
        const startedAt = Date.now();
        try {
          const changed = await poll();
          failures = 0;
          const elapsedMs = Date.now() - startedAt;
          const minimumIdleMs = legacyServer ? 1_500 : 1_000;
          if (!changed && elapsedMs < minimumIdleMs) {
            await new Promise((resolve) => window.setTimeout(resolve, minimumIdleMs - elapsedMs));
          }
        } catch (error) {
          if (cancelled || abortController.signal.aborted) return;
          reportSessionRequired(error);
          if (input.serverRoomsEventSeqRef.current <= 0 && input.roomsRef.current.length === 0) {
            input.setRoomsHydrated(true);
          }
          failures += 1;
          const retryMs = Math.min(1_000 * 2 ** Math.min(failures - 1, 3), 8_000);
          await new Promise((resolve) => window.setTimeout(resolve, retryMs));
        }
      }
    };
    void sync();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [input, sessionKey]);
}
