import { createHash } from "node:crypto";
import {
  BACKGROUND_CONTEXT as background,
  JsonlSessionRepo,
  MemorySessionRepo,
  value,
  type ExecutionEnv,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentSessionInfo } from "../core.js";
import { migratePi084Sessions } from "./pi-session-upgrade.compat.js";

export const openGroveSessionIdentity = value<string>("opengrove.session.id");

export function nativePiSessionId(id: string): string {
  return `opengrove-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** Owns Host identity mapping; transcript and fork storage remain native Pi operations. */
export class NativePiSessionRepository {
  private readonly jsonl?: JsonlSessionRepo;
  private readonly memory = new MemorySessionRepo();
  private readonly sessions = new Map<string, Promise<Session>>();
  private ready?: Promise<void>;

  constructor(
    private readonly root?: string,
    private readonly cwd = process.cwd(),
    private readonly env: ExecutionEnv = new NodeExecutionEnv({ cwd }),
  ) {
    if (root?.trim()) {
      this.jsonl = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: root.trim() });
    }
  }

  private async open(id: string, create: boolean): Promise<Session | undefined> {
    await (this.ready ??= this.root?.trim() ? migratePi084Sessions(this.root.trim(), this.env) : Promise.resolve());
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
    if (session) {
      if ((await session.getValue(openGroveSessionIdentity, background))?.value !== id) {
        await session.setValue(openGroveSessionIdentity, id, background);
      }
      this.sessions.set(nativeId, Promise.resolve(session));
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
    await (this.ready ??= this.root?.trim() ? migratePi084Sessions(this.root.trim(), this.env) : Promise.resolve());
    const candidates = this.jsonl
      ? (await this.jsonl.list({ cwd: this.cwd }, background)).map((metadata) => ({
          metadata,
          open: () => this.jsonl!.open(metadata, background),
        }))
      : (await this.memory.list(undefined, background)).map((metadata) => ({
          metadata,
          open: () => this.memory.open(metadata, background),
        }));
    const result: AgentSessionInfo[] = [];
    for (const { metadata, open } of candidates) {
      const session = await this.remember(metadata.id, open);
      const identity = (await session.getValue(openGroveSessionIdentity, background))?.value;
      result.push({ sessionId: identity ?? metadata.id, nativeSessionId: metadata.id });
    }
    return result;
  }

  /** Drop only a handle whose Harness has already closed the native session. */
  release(id: string): void {
    this.sessions.delete(nativePiSessionId(id));
  }

  async delete(id: string): Promise<boolean> {
    await (this.ready ??= this.root?.trim() ? migratePi084Sessions(this.root.trim(), this.env) : Promise.resolve());
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
    await fork.setValue(openGroveSessionIdentity, targetId, background);
    this.sessions.set(id, Promise.resolve(fork));
    return "forked";
  }
}
