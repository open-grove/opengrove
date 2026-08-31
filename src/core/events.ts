import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./types.js";

export interface EventLogPage {
  events: AgentEvent[];
  cursor: string;
  oldestCursor: string;
  hasMore: boolean;
  hasOlder: boolean;
  historyTruncated: boolean;
  resetRequired: boolean;
}

export interface EventLogCheckpoint {
  generation: string;
  currentEventSeq: number;
  entries: Array<{ eventSeq: number; event: AgentEvent }>;
}

type ParsedEventCursor = {
  generation: string;
  eventSeq: number;
  scope: string;
};

export class EventLog {
  private readonly entries: Array<{ eventSeq: number; event: AgentEvent }> = [];
  private readonly eventWaiters = new Set<{
    predicate: (event: AgentEvent) => boolean;
    finish(): void;
  }>();
  private retentionLimit?: number;
  private startIndex = 0;
  private currentEventSeq = 0;
  private generation: string = randomUUID();

  append(event: AgentEvent): AgentEvent {
    this.currentEventSeq += 1;
    this.entries.push({ eventSeq: this.currentEventSeq, event });
    this.trimToRetentionLimit();
    for (const waiter of [...this.eventWaiters]) {
      try {
        if (waiter.predicate(event)) waiter.finish();
      } catch {
        // A broken notification predicate must never turn an already-recorded
        // event into an apparent append failure. Release that waiter so it
        // cannot poison every future append.
        waiter.finish();
      }
    }
    return event;
  }

  restore(events: AgentEvent[]): void {
    this.releaseEventWaiters();
    this.entries.length = 0;
    this.startIndex = 0;
    this.currentEventSeq = 0;
    this.generation = randomUUID();
    const retained = this.retentionLimit === undefined ? events : events.slice(-this.retentionLimit);
    for (const event of retained) {
      this.currentEventSeq += 1;
      this.entries.push({ eventSeq: this.currentEventSeq, event });
    }
  }

  /**
   * Captures the in-process cursor identity together with the retained window.
   * This is intentionally separate from durable restore: a cold start must get
   * a new generation, while a synchronous hot rebuild can keep existing cursors
   * valid without pretending that persisted state is the same live log.
   */
  checkpoint(): EventLogCheckpoint {
    return {
      generation: this.generation,
      currentEventSeq: this.currentEventSeq,
      entries: this.entries.slice(this.startIndex).map((entry) => ({ ...entry })),
    };
  }

  restoreCheckpoint(checkpoint: EventLogCheckpoint): void {
    if (!checkpoint.generation || !Number.isSafeInteger(checkpoint.currentEventSeq) || checkpoint.currentEventSeq < 0) {
      throw new Error("invalid_event_log_checkpoint");
    }
    let previousEventSeq = 0;
    for (const entry of checkpoint.entries) {
      if (
        !Number.isSafeInteger(entry.eventSeq) ||
        entry.eventSeq <= previousEventSeq ||
        entry.eventSeq > checkpoint.currentEventSeq
      ) {
        throw new Error("invalid_event_log_checkpoint");
      }
      previousEventSeq = entry.eventSeq;
    }
    this.releaseEventWaiters();
    this.entries.length = 0;
    this.startIndex = 0;
    this.currentEventSeq = checkpoint.currentEventSeq;
    this.generation = checkpoint.generation;
    this.entries.push(...checkpoint.entries.map((entry) => ({ ...entry })));
    this.trimToRetentionLimit();
  }

  setRetentionLimit(limit: number | undefined): void {
    this.retentionLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
    this.trimToRetentionLimit();
  }

  list(predicate: (event: AgentEvent) => boolean = () => true): AgentEvent[] {
    return this.entries
      .slice(this.startIndex)
      .map((entry) => entry.event)
      .filter(predicate);
  }

  sequence(predicate?: (event: AgentEvent) => boolean): number {
    if (!predicate) return this.currentEventSeq;
    for (let index = this.entries.length - 1; index >= this.startIndex; index -= 1) {
      const entry = this.entries[index];
      if (entry && predicate(entry.event)) return entry.eventSeq;
    }
    return 0;
  }

  revision(predicate?: (event: AgentEvent) => boolean, scope = ""): string {
    return this.encodeCursor(this.sequence(predicate), scope);
  }

  latest(limit: number, predicate: (event: AgentEvent) => boolean = () => true, scope = ""): EventLogPage {
    const visible = this.entries.slice(this.startIndex);
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const matching = visible.filter((entry) => predicate(entry.event));
    const selected = matching.slice(-normalizedLimit);
    return {
      events: selected.map((entry) => entry.event),
      cursor: this.encodeCursor(this.currentEventSeq, scope),
      oldestCursor: this.encodeCursor(selected[0]?.eventSeq ?? this.currentEventSeq, scope),
      hasMore: false,
      hasOlder: matching.length > selected.length,
      historyTruncated: (visible[0]?.eventSeq ?? 1) > 1,
      resetRequired: false,
    };
  }

  eventsAfter(
    cursorValue: string,
    limit: number,
    predicate: (event: AgentEvent) => boolean = () => true,
    scope = "",
  ): EventLogPage {
    const visible = this.entries.slice(this.startIndex);
    const oldestAvailableEventSeq = visible[0]?.eventSeq ?? this.currentEventSeq + 1;
    const cursor = decodeEventCursor(cursorValue);
    const resetRequired = !this.isCursorUsable(cursor, scope);
    if (resetRequired) {
      return this.resetPage(oldestAvailableEventSeq, scope);
    }

    const normalizedLimit = Math.max(1, Math.floor(limit));
    const selected: Array<{ eventSeq: number; event: AgentEvent }> = [];
    let nextEventSeq = cursor.eventSeq;
    for (const entry of visible) {
      if (entry.eventSeq <= cursor.eventSeq) continue;
      nextEventSeq = entry.eventSeq;
      if (predicate(entry.event)) selected.push(entry);
      if (selected.length >= normalizedLimit) break;
    }
    const hasMore = nextEventSeq < this.currentEventSeq;
    return {
      events: selected.map((entry) => entry.event),
      cursor: this.encodeCursor(hasMore ? nextEventSeq : this.currentEventSeq, scope),
      oldestCursor: this.encodeCursor(selected[0]?.eventSeq ?? cursor.eventSeq, scope),
      hasMore,
      hasOlder: false,
      historyTruncated: oldestAvailableEventSeq > 1,
      resetRequired: false,
    };
  }

  waitForEventsAfter(
    cursorValue: string,
    predicate: ((event: AgentEvent) => boolean) | undefined,
    scope: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const cursor = decodeEventCursor(cursorValue);
    const matches = predicate ?? (() => true);
    if (
      signal?.aborted ||
      !this.isCursorUsable(cursor, scope) ||
      this.entries.slice(this.startIndex).some((entry) => entry.eventSeq > cursor.eventSeq && matches(entry.event))
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        predicate: matches,
        finish: () => {
          if (!this.eventWaiters.delete(waiter)) return;
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener("abort", waiter.finish);
          resolve();
        },
      };
      this.eventWaiters.add(waiter);
      timeout = setTimeout(waiter.finish, Math.max(0, timeoutMs));
      timeout.unref?.();
      signal?.addEventListener("abort", waiter.finish, { once: true });
      if (signal?.aborted) waiter.finish();
    });
  }

  releaseEventWaiters(): void {
    for (const waiter of [...this.eventWaiters]) waiter.finish();
  }

  private isCursorUsable(cursor: ParsedEventCursor | undefined, scope: string): cursor is ParsedEventCursor {
    const oldestAvailableEventSeq = this.entries[this.startIndex]?.eventSeq ?? this.currentEventSeq + 1;
    return Boolean(
      cursor &&
        cursor.generation === this.generation &&
        cursor.scope === scope &&
        cursor.eventSeq <= this.currentEventSeq &&
        cursor.eventSeq + 1 >= oldestAvailableEventSeq,
    );
  }

  eventsBefore(
    cursorValue: string,
    limit: number,
    predicate: (event: AgentEvent) => boolean = () => true,
    scope = "",
  ): EventLogPage {
    const visible = this.entries.slice(this.startIndex);
    const oldestAvailableEventSeq = visible[0]?.eventSeq ?? this.currentEventSeq + 1;
    const cursor = decodeEventCursor(cursorValue);
    const resetRequired =
      !cursor ||
      cursor.generation !== this.generation ||
      cursor.scope !== scope ||
      cursor.eventSeq > this.currentEventSeq ||
      (this.currentEventSeq > 0 && cursor.eventSeq < oldestAvailableEventSeq);
    if (resetRequired) {
      return this.resetPage(oldestAvailableEventSeq, scope);
    }

    const normalizedLimit = Math.max(1, Math.floor(limit));
    const matching = visible.filter((entry) => entry.eventSeq < cursor.eventSeq && predicate(entry.event));
    const selected = matching.slice(-normalizedLimit);
    return {
      events: selected.map((entry) => entry.event),
      cursor: this.encodeCursor(this.currentEventSeq, scope),
      oldestCursor: this.encodeCursor(selected[0]?.eventSeq ?? cursor.eventSeq, scope),
      hasMore: false,
      hasOlder: matching.length > selected.length,
      historyTruncated: oldestAvailableEventSeq > 1,
      resetRequired: false,
    };
  }

  clear(): void {
    this.releaseEventWaiters();
    this.entries.length = 0;
    this.startIndex = 0;
    this.currentEventSeq = 0;
    this.generation = randomUUID();
  }

  private resetPage(oldestAvailableEventSeq: number, scope: string): EventLogPage {
    return {
      events: [],
      cursor: this.encodeCursor(this.currentEventSeq, scope),
      oldestCursor: this.encodeCursor(Math.min(oldestAvailableEventSeq, this.currentEventSeq), scope),
      hasMore: false,
      hasOlder: false,
      historyTruncated: oldestAvailableEventSeq > 1,
      resetRequired: true,
    };
  }

  private encodeCursor(eventSeq: number, scope = ""): string {
    return encodeEventCursor({ generation: this.generation, eventSeq, scope });
  }

  private trimToRetentionLimit(): void {
    if (this.retentionLimit === undefined) return;
    const retainedLength = this.entries.length - this.startIndex;
    if (retainedLength > this.retentionLimit) {
      this.startIndex += retainedLength - this.retentionLimit;
    }
    // Compact occasionally so discarded entries can be collected without an
    // O(window) array shift for every streamed token.
    if (this.startIndex >= 1_024 && this.startIndex * 2 >= this.entries.length) {
      this.entries.splice(0, this.startIndex);
      this.startIndex = 0;
    }
  }
}

function encodeEventCursor(cursor: ParsedEventCursor): string {
  return `evt1_${Buffer.from(JSON.stringify({ g: cursor.generation, s: cursor.eventSeq, q: cursor.scope }), "utf8").toString("base64url")}`;
}

function decodeEventCursor(value: string): ParsedEventCursor | undefined {
  if (!value.startsWith("evt1_")) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as {
      g?: unknown;
      s?: unknown;
      q?: unknown;
    };
    if (typeof decoded.g !== "string" || !decoded.g) return undefined;
    if (!Number.isSafeInteger(decoded.s) || (decoded.s as number) < 0) return undefined;
    if (typeof decoded.q !== "string") return undefined;
    return { generation: decoded.g, eventSeq: decoded.s as number, scope: decoded.q };
  } catch {
    return undefined;
  }
}
