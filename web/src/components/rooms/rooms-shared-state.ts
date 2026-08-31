import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRoomsServerSync } from "./rooms-server-sync";
import { fetchRoomMessages, isRoomsSessionRequiredError, markServerRoomRead } from "./rooms-api";
import { harmonizeRoomMemberAvatars, type Room, type RoomMember, type RoomsState } from "./rooms-model";
import { mergeHydratedRoomMessages } from "./room-message-hydration";
import { createRoomReadReceiptQueue } from "./room-read-receipts";

const ACTIVE_ROOM_STORAGE_KEY = "opengrove.rooms.activeRoomId";
const ROOM_READ_RECEIPT_DELAY_MS = 5_000;

export type RoomsSharedSnapshot = RoomsState & {
  hydrated: boolean;
};

export type RoomsSharedActions = {
  setRooms: Dispatch<SetStateAction<Room[]>>;
  setMembers: Dispatch<SetStateAction<RoomMember[]>>;
  setDeletedMemberIds: Dispatch<SetStateAction<string[]>>;
  setActiveRoomId: Dispatch<SetStateAction<string>>;
  setRoomsState: Dispatch<SetStateAction<RoomsState>>;
  recordServerEventSeq(eventSeq: number | undefined): void;
  markRoomRead(roomId: string): Promise<void>;
};

export function useRoomsSharedState(input: { enabled?: boolean; onSessionRequired?(): void; sessionKey: string }): {
  snapshot: RoomsSharedSnapshot;
  actions: RoomsSharedActions;
} {
  const [roomsState, setRoomsState] = useState<RoomsState>(() => ({
    rooms: [],
    members: [],
    activeRoomId: readStoredActiveRoomId(),
    deletedMemberIds: [],
  }));
  const [roomsHydrated, setRoomsHydrated] = useState(false);
  const roomsRef = useRef<Room[]>(roomsState.rooms);
  const membersRef = useRef<RoomMember[]>(roomsState.members);
  const deletedMemberIdsRef = useRef<string[]>(roomsState.deletedMemberIds ?? []);
  const serverRoomsEventSeqRef = useRef(0);
  const previousSessionKeyRef = useRef(input.sessionKey);
  const previousActiveRoomIdRef = useRef(roomsState.activeRoomId);
  const onSessionRequiredRef = useRef(input.onSessionRequired);
  onSessionRequiredRef.current = input.onSessionRequired;
  const readReceiptQueueRef = useRef<ReturnType<typeof createRoomReadReceiptQueue> | null>(null);
  if (!readReceiptQueueRef.current) {
    readReceiptQueueRef.current = createRoomReadReceiptQueue({
      delayMs: ROOM_READ_RECEIPT_DELAY_MS,
      send: async (roomId, observedEventSeq) => {
        await markServerRoomRead(roomId, observedEventSeq);
      },
      onFailure: (receipt, error) => {
        if (isRoomsSessionRequiredError(error)) onSessionRequiredRef.current?.();
        const restoredRooms = roomsRef.current.map((room) =>
          room.id === receipt.roomId ? { ...room, unread: Math.max(room.unread, receipt.unread) } : room,
        );
        roomsRef.current = restoredRooms;
        setRoomsState((current) => ({
          ...current,
          rooms: current.rooms.map((room) =>
            room.id === receipt.roomId ? { ...room, unread: Math.max(room.unread, receipt.unread) } : room,
          ),
        }));
      },
    });
  }
  const readReceiptQueue = readReceiptQueueRef.current;

  useEffect(() => {
    roomsRef.current = roomsState.rooms;
  }, [roomsState.rooms]);

  useEffect(() => {
    membersRef.current = roomsState.members;
  }, [roomsState.members]);

  useEffect(() => {
    deletedMemberIdsRef.current = roomsState.deletedMemberIds ?? [];
  }, [roomsState.deletedMemberIds]);

  useEffect(() => {
    writeStoredActiveRoomId(roomsState.activeRoomId);
  }, [roomsState.activeRoomId]);

  useEffect(() => {
    if (input.enabled === false || !roomsHydrated || !roomsState.activeRoomId) return undefined;
    let cancelled = false;
    const roomId = roomsState.activeRoomId;
    const messageIdsAtRequest = new Set(
      roomsRef.current.find((room) => room.id === roomId)?.messages.map((message) => message.id) ?? [],
    );
    void fetchRoomMessages(roomId, 80)
      .then((messages) => {
        if (cancelled) return;
        setRoomsState((current) => ({
          ...current,
          rooms: current.rooms.map((room) => {
            if (room.id !== roomId) return room;
            return {
              ...room,
              messages: mergeHydratedRoomMessages({
                serverMessages: messages,
                currentMessages: room.messages,
                messageIdsAtRequest,
              }),
            };
          }),
        }));
      })
      .catch((error) => {
        if (!cancelled && isRoomsSessionRequiredError(error)) input.onSessionRequired?.();
      });
    return () => {
      cancelled = true;
    };
  }, [input.enabled, input.onSessionRequired, roomsHydrated, roomsState.activeRoomId]);

  useEffect(() => {
    if (previousSessionKeyRef.current === input.sessionKey) return;
    previousSessionKeyRef.current = input.sessionKey;
    readReceiptQueue.reset();
    roomsRef.current = [];
    membersRef.current = [];
    deletedMemberIdsRef.current = [];
    serverRoomsEventSeqRef.current = 0;
    setRoomsHydrated(false);
    setRoomsState({
      rooms: [],
      members: [],
      activeRoomId: readStoredActiveRoomId(),
      deletedMemberIds: [],
    });
  }, [input.sessionKey, readReceiptQueue]);

  useEffect(() => {
    const previousRoomId = previousActiveRoomIdRef.current;
    previousActiveRoomIdRef.current = roomsState.activeRoomId;
    if (!previousRoomId || previousRoomId === roomsState.activeRoomId) return;
    void readReceiptQueue.flush(previousRoomId);
  }, [readReceiptQueue, roomsState.activeRoomId]);

  useEffect(
    () => () => {
      void readReceiptQueue.flushAll();
    },
    [readReceiptQueue],
  );

  const setRooms = useCallback<Dispatch<SetStateAction<Room[]>>>((action) => {
    setRoomsState((current) => ({ ...current, rooms: applyStateAction(current.rooms, action) }));
  }, []);

  const setMembers = useCallback<Dispatch<SetStateAction<RoomMember[]>>>((action) => {
    setRoomsState((current) => ({ ...current, members: applyStateAction(current.members, action) }));
  }, []);

  const setDeletedMemberIds = useCallback<Dispatch<SetStateAction<string[]>>>((action) => {
    setRoomsState((current) => ({
      ...current,
      deletedMemberIds: applyStateAction(current.deletedMemberIds ?? [], action),
    }));
  }, []);

  const setActiveRoomId = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setRoomsState((current) => ({ ...current, activeRoomId: applyStateAction(current.activeRoomId, action) }));
  }, []);

  const recordServerEventSeq = useCallback((eventSeq: number | undefined) => {
    if (typeof eventSeq !== "number") return;
    serverRoomsEventSeqRef.current = Math.max(serverRoomsEventSeqRef.current, eventSeq);
  }, []);

  const markRoomRead = useCallback(
    async (roomId: string) => {
      const room = roomsRef.current.find((candidate) => candidate.id === roomId);
      if (!room?.unread) return;
      const unread = room.unread;
      const optimisticRooms = roomsRef.current.map((candidate) =>
        candidate.id === roomId ? { ...candidate, unread: 0 } : candidate,
      );
      roomsRef.current = optimisticRooms;
      setRoomsState((current) => ({
        ...current,
        rooms: current.rooms.map((candidate) => (candidate.id === roomId ? { ...candidate, unread: 0 } : candidate)),
      }));
      readReceiptQueue.enqueue({
        roomId,
        observedEventSeq: serverRoomsEventSeqRef.current,
        unread,
      });
    },
    [readReceiptQueue],
  );

  const roomsServerSync = useMemo(
    () => ({
      roomsRef,
      membersRef,
      deletedMemberIdsRef,
      serverRoomsEventSeqRef,
      setActiveRoomId,
      setDeletedMemberIds,
      setMembers,
      setRooms,
      setRoomsHydrated,
      enabled: input.enabled,
      onSessionRequired: input.onSessionRequired,
    }),
    [input.enabled, input.onSessionRequired, setActiveRoomId, setDeletedMemberIds, setMembers, setRooms],
  );

  useRoomsServerSync(roomsServerSync, input.sessionKey);

  const snapshot = useMemo<RoomsSharedSnapshot>(
    () => ({
      ...roomsState,
      members: harmonizeRoomMemberAvatars(roomsState.members),
      deletedMemberIds: roomsState.deletedMemberIds ?? [],
      hydrated: roomsHydrated,
    }),
    [roomsHydrated, roomsState],
  );

  const actions = useMemo<RoomsSharedActions>(
    () => ({
      setRooms,
      setMembers,
      setDeletedMemberIds,
      setActiveRoomId,
      setRoomsState,
      recordServerEventSeq,
      markRoomRead,
    }),
    [markRoomRead, recordServerEventSeq, setActiveRoomId, setDeletedMemberIds, setMembers, setRooms],
  );

  return { snapshot, actions };
}

function readStoredActiveRoomId(): string {
  try {
    return window.localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredActiveRoomId(roomId: string) {
  try {
    if (roomId) window.localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, roomId);
    else window.localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
  } catch {
    // Room selection is only a UI convenience; storage failures should not affect chat.
  }
}

function applyStateAction<T>(current: T, action: SetStateAction<T>): T {
  return typeof action === "function" ? (action as (value: T) => T)(current) : action;
}
