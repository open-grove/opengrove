import type { HostContextBlock } from "../core.js";

/** A delivery receipt belongs to a native session, never just to a Room. */
export class HostContextDelivery {
  private readonly sessions = new Map<string, { token: symbol; blocks?: HostContextBlock[] }>();

  begin(sessionId: string, blocks: readonly HostContextBlock[]) {
    const previous = this.sessions.get(sessionId)?.blocks;
    const current = blocks.map((block) => ({ ...block }));
    const previousById = new Map(previous?.map((block) => [block.id, block.text]));
    const delta = previous ? current.filter((block) => previousById.get(block.id) !== block.text) : current;
    for (const old of previous ?? []) {
      if (!current.some((block) => block.id === old.id)) delta.push({ id: old.id, text: "" });
    }
    const token = Symbol(sessionId);
    // Unacknowledged or overlapping sends must not suppress a later full snapshot.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, { token });
    if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value!);
    return {
      blocks: delta,
      fullState: previous === undefined,
      acknowledge: () => {
        if (this.sessions.get(sessionId)?.token === token) this.sessions.set(sessionId, { token, blocks: current });
      },
    };
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// Runtime instances may be rebuilt between turns. Receipts follow native
// session identity within this Host process; a Host restart sends full state.
export const hostContextDelivery = new HostContextDelivery();
