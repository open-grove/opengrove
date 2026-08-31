export type RoomReadReceiptInput = {
  roomId: string;
  observedEventSeq: number;
  unread: number;
};

export type RoomReadReceiptQueue = {
  enqueue(input: RoomReadReceiptInput): void;
  flush(roomId: string): Promise<void>;
  flushAll(): Promise<void>;
  reset(): void;
};

type TimerId = number;

type PendingReceipt = RoomReadReceiptInput & {
  timerId?: TimerId;
  inFlight?: Promise<void>;
  flushAfterFlight: boolean;
};

export function createRoomReadReceiptQueue(input: {
  delayMs: number;
  send(roomId: string, observedEventSeq: number): Promise<void>;
  onFailure?(receipt: RoomReadReceiptInput, error: unknown): void;
  setTimer?(callback: () => void, delayMs: number): TimerId;
  clearTimer?(timerId: TimerId): void;
}): RoomReadReceiptQueue {
  const pendingByRoomId = new Map<string, PendingReceipt>();
  const setTimer = input.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((timerId) => window.clearTimeout(timerId));

  const cancelTimer = (receipt: PendingReceipt) => {
    if (receipt.timerId === undefined) return;
    clearTimer(receipt.timerId);
    receipt.timerId = undefined;
  };

  const armTimer = (receipt: PendingReceipt) => {
    if (receipt.inFlight) return;
    cancelTimer(receipt);
    receipt.timerId = setTimer(() => {
      receipt.timerId = undefined;
      void sendReceipt(receipt);
    }, input.delayMs);
  };

  const sendReceipt = (receipt: PendingReceipt): Promise<void> => {
    if (pendingByRoomId.get(receipt.roomId) !== receipt) return Promise.resolve();
    if (receipt.inFlight) {
      receipt.flushAfterFlight = true;
      return receipt.inFlight;
    }
    cancelTimer(receipt);
    const sentEventSeq = receipt.observedEventSeq;
    let request: Promise<void>;
    request = Promise.resolve()
      .then(() => input.send(receipt.roomId, sentEventSeq))
      .then(async () => {
        if (receipt.inFlight === request) receipt.inFlight = undefined;
        if (pendingByRoomId.get(receipt.roomId) !== receipt) return;
        if (receipt.observedEventSeq <= sentEventSeq) {
          pendingByRoomId.delete(receipt.roomId);
          return;
        }
        if (receipt.flushAfterFlight) {
          receipt.flushAfterFlight = false;
          await sendReceipt(receipt);
          return;
        }
        armTimer(receipt);
      })
      .catch((error) => {
        if (receipt.inFlight === request) receipt.inFlight = undefined;
        if (pendingByRoomId.get(receipt.roomId) !== receipt) return;
        pendingByRoomId.delete(receipt.roomId);
        input.onFailure?.(
          {
            roomId: receipt.roomId,
            observedEventSeq: receipt.observedEventSeq,
            unread: receipt.unread,
          },
          error,
        );
      });
    receipt.inFlight = request;
    return request;
  };

  const flush = async (roomId: string) => {
    const receipt = pendingByRoomId.get(roomId);
    if (!receipt) return;
    receipt.flushAfterFlight = true;
    await sendReceipt(receipt);
  };

  return {
    enqueue(next) {
      const existing = pendingByRoomId.get(next.roomId);
      if (existing) {
        existing.observedEventSeq = Math.max(existing.observedEventSeq, next.observedEventSeq);
        existing.unread = Math.max(existing.unread, next.unread);
        if (!existing.inFlight) armTimer(existing);
        return;
      }
      const receipt: PendingReceipt = {
        ...next,
        flushAfterFlight: false,
      };
      pendingByRoomId.set(next.roomId, receipt);
      armTimer(receipt);
    },
    flush,
    async flushAll() {
      await Promise.all([...pendingByRoomId.keys()].map(async (roomId) => await flush(roomId)));
    },
    reset() {
      for (const receipt of pendingByRoomId.values()) cancelTimer(receipt);
      pendingByRoomId.clear();
    },
  };
}
