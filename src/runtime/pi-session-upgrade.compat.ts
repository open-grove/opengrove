import { constants } from "node:fs";
import { copyFile, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT as background,
  branchTip,
  insertEntry,
  JsonlSessionRepo,
  setValue,
  value,
  type ExecutionEnv,
  type NewEntry,
} from "@earendil-works/pi-agent-core";
import { z } from "zod";

// Supports: Pi 0.84.4 JSONL v4 sessions, imported into Pi 0.85.1.
// Remove when: the supported upgrade floor is Pi 0.85.1 and no 0.84.4 sessions remain.
// Pi 0.84.4 and 0.85.1 use incompatible formats both named v4. The upstream
// 0.85 reader only migrates v3 and silently skips 0.84 v4 headers. Import through
// public Session mutations, never rebuild model context. Retain this boundary
// while installations can contain pre-0.85 sessions (OpenGrove issue #63).
const headerSchema = z
  .object({
    kind: z.literal("header"),
    version: z.literal(4),
    id: z.string().min(1),
    createdAt: z.number().finite(),
    cwd: z.string().min(1),
    parentSessionId: z.string().optional(),
    metadata: z
      .object({ openGroveSessionId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const messageSchema = z
  .object({
    role: z.enum(["user", "assistant", "toolResult", "custom", "compactionSummary", "branchSummary", "bashExecution"]),
    timestamp: z.number().finite(),
  })
  .passthrough();
const entryBase = z.object({
  kind: z.literal("entry"),
  lane: z.string().min(1),
  id: z.string().min(1),
  parentId: z.string().nullable(),
  seq: z.number().int().positive(),
  timestamp: z.number().finite(),
});
const entrySchema = z.discriminatedUnion("type", [
  entryBase.extend({ type: z.literal("message"), message: messageSchema }),
  entryBase.extend({
    type: z.literal("compaction"),
    summary: z.string(),
    tokensBefore: z.number(),
    retainedTail: z.array(messageSchema),
    details: z.json().optional(),
    usage: z.json().optional(),
  }),
  entryBase.extend({ type: z.literal("custom"), customType: z.string(), data: z.json().optional() }),
  entryBase.extend({
    type: z.literal("branch_summary"),
    fromId: z.string().nullable(),
    summary: z.string(),
    details: z.json().optional(),
    usage: z.json().optional(),
  }),
]);

const activeMigrations = new Map<string, Promise<void>>();

export function migratePi084Sessions(root: string, env: ExecutionEnv): Promise<void> {
  const absoluteRoot = resolve(root);
  const active = activeMigrations.get(absoluteRoot);
  if (active) return active;
  const pending = importPi084Sessions(absoluteRoot, env).finally(() => activeMigrations.delete(absoluteRoot));
  activeMigrations.set(absoluteRoot, pending);
  return pending;
}

async function readHeader(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    for await (const line of file.readLines()) return JSON.parse(line) as unknown;
    return undefined;
  } finally {
    await file.close();
  }
}

async function importPi084Sessions(root: string, env: ExecutionEnv): Promise<void> {
  let directories;
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.name.startsWith(".pi085-migration-")) continue;
    for (const filename of await readdir(join(root, directory.name))) {
      if (!filename.endsWith(".jsonl")) continue;
      const path = join(root, directory.name, filename);
      const rawHeader = await readHeader(path);
      if (!rawHeader || typeof rawHeader !== "object" || !("version" in rawHeader) || rawHeader.version !== 4) continue;
      const content = await readFile(path, "utf8");
      const lines = content.trimEnd().split("\n");
      const header = headerSchema.parse(JSON.parse(lines[0]!));
      // Validate the whole log before creating a destination or touching the source.
      const records = lines.slice(1).map((line) => {
        const raw: unknown = JSON.parse(line);
        const record = z.object({ kind: z.string() }).passthrough().parse(raw);
        if (record.kind === "entry") return entrySchema.parse(raw);
        if (record.kind === "lane")
          return z
            .object({ kind: z.literal("lane"), lane: z.string(), leafId: z.string().nullable(), seq: z.number() })
            .parse(raw);
        if (record.kind === "fact")
          return z
            .discriminatedUnion("fact", [
              z.object({ kind: z.literal("fact"), fact: z.literal("name"), name: z.string().optional() }),
              z.object({
                kind: z.literal("fact"),
                fact: z.literal("label"),
                targetId: z.string(),
                label: z.string().optional(),
              }),
            ])
            .parse(raw);
        throw new Error(`pi_session_upgrade_unsupported_record: ${path}: ${record.kind}`);
      });
      const temporaryRoot = await mkdtemp(join(root, ".pi085-migration-"));
      let now = header.createdAt;
      const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: temporaryRoot, now: () => now });
      try {
        const session = await repo.create(
          { id: header.id, cwd: header.cwd, parentSessionId: header.parentSessionId },
          background,
        );
        for (const record of records) {
          if (record.kind === "entry") {
            now = record.timestamp;
            const { kind: _kind, lane, seq: _seq, timestamp: _timestamp, ...payload } = record;
            const entry = {
              ...payload,
              ...(payload.type === "compaction" || payload.type === "branch_summary" ? { fromHook: false } : {}),
            } as NewEntry;
            // Public Pi validation checks parent references, IDs and JSON storage invariants.
            await session.mutate(
              (mutation) => mutation.commit([insertEntry(entry), setValue(branchTip(lane), entry.id)], background),
              background,
            );
          } else if (record.kind === "lane") await session.setValue(branchTip(record.lane), record.leafId, background);
          else if (record.fact === "name") await session.setName(record.name, background);
          else await session.setLabel(record.targetId, record.label, background);
        }
        if (header.metadata?.openGroveSessionId) {
          await session.setValue(value<string>("opengrove.session.id"), header.metadata.openGroveSessionId, background);
        }
        // Keep otherwise opaque application metadata for lossless audit/rollback.
        await session.setValue(value("opengrove.pi084.header"), header, background);
        const output = session.metadata.path;
        await session.close(background);
        const backup = `${path}.pre-pi085`;
        try {
          await copyFile(path, backup, constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await readFile(backup, "utf8")) !== content)
            throw error;
        }
        if ((await readFile(path, "utf8")) !== content) throw new Error(`pi_session_upgrade_source_changed: ${path}`);
        await rename(output, path);
      } finally {
        await repo.close(background);
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}
