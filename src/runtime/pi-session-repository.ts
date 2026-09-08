import {
  BACKGROUND_CONTEXT as background,
  JsonlSessionRepo,
  MemorySessionRepo,
  type ExecutionEnv,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentSessionInfo } from "../core.js";
// Pi 0.85 sessions use Host IDs directly so native list() needs only headers.
// Pre-0.85 hashed IDs are intentionally left untouched; upgrading starts fresh.
const SESSION_PREFIX = "opengrove-session:";

export function nativePiSessionId(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

/** Owns Host identity mapping; transcript and fork storage remain native Pi operations. */
export class NativePiSessionRepository {
  private readonly jsonl?: JsonlSessionRepo;
  private readonly memory = new MemorySessionRepo();
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(
    root?: string,
    private readonly cwd = process.cwd(),
    env: ExecutionEnv = new NodeExecutionEnv({ cwd }),
  ) {
    if (root?.trim()) {
      this.jsonl = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: root.trim() });
    }
  }

  private async open(id: string, create: boolean): Promise<Session | undefined> {
    const nativeId = nativePiSessionId(id);
    const cached = this.sessions.get(nativeId);
    if (cached) return cached;
    let session: Session | undefined;
    if (this.jsonl) {
      const metadata = (await this.jsonl.list({ cwd: this.cwd }, background)).find((item) => item.id === nativeId);
      session = metadata
        ? await this.remember(nativeId, () => this.jsonl!.open(metadata, background))
        : create
          ? await this.remember(nativeId, () => this.jsonl!.create({ id: nativeId, cwd: this.cwd }, background))
          : undefined;
    } else {
      const metadata = (await this.memory.list(undefined, background)).find((item) => item.id === nativeId);
      session = metadata
        ? await this.remember(nativeId, () => this.memory.open(metadata, background))
        : create
          ? await this.remember(nativeId, () => this.memory.create({ id: nativeId }, background))
          : undefined;
    }
    return session;
  }

  private remember(id: string, open: () => Promise<Session>): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const pending = open().catch((error) => {
      this.sessions.delete(id);
      throw error;
    });
    this.sessions.set(id, pending);
    return pending;
  }

  async openOrCreate(id: string): Promise<Session> {
    return (await this.open(id, true))!;
  }

  async list(): Promise<AgentSessionInfo[]> {
    const candidates = this.jsonl
      ? await this.jsonl.list({ cwd: this.cwd }, background)
      : await this.memory.list(undefined, background);
    return candidates
      .filter(({ id }) => id.startsWith(SESSION_PREFIX))
      .map(({ id }) => ({
        sessionId: id.slice(SESSION_PREFIX.length),
        nativeSessionId: id,
      }));
  }

  /** Drop only a handle whose Harness has already closed the native session. */
  release(id: string): void {
    this.sessions.delete(nativePiSessionId(id));
  }

  async delete(id: string): Promise<boolean> {
    const nativeId = nativePiSessionId(id);
    const session = await this.sessions.get(nativeId);
    await session?.close(background);
    this.sessions.delete(nativeId);
    if (this.jsonl) {
      const metadata = (await this.jsonl.list({ cwd: this.cwd }, background)).find((item) => item.id === nativeId);
      if (!metadata) return false;
      await this.jsonl.delete(metadata, background);
    } else {
      const metadata = (await this.memory.list(undefined, background)).find((item) => item.id === nativeId);
      if (!metadata) return false;
      await this.memory.delete(metadata, background);
    }
    return true;
  }

  async fork(sourceId: string, targetId: string): Promise<"forked" | "source_not_found" | "target_exists"> {
    const source = await this.open(sourceId, false);
    if (!source) return "source_not_found";
    if (await this.open(targetId, false)) return "target_exists";
    const id = nativePiSessionId(targetId);
    let fork: Session;
    if (this.jsonl) {
      const metadata = (await this.jsonl.list({ cwd: this.cwd }, background)).find(
        (item) => item.id === source.metadata.id,
      )!;
      fork = await this.jsonl.fork(metadata, { scope: "tree", id }, background);
    } else fork = await this.memory.fork(source.metadata, { scope: "tree", id }, background);
    this.sessions.set(id, Promise.resolve(fork));
    return "forked";
  }

  async close(): Promise<void> {
    try {
      await (this.jsonl ?? this.memory).close(background);
    } finally {
      this.sessions.clear();
    }
  }
}
