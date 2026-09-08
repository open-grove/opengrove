import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export class WorkspaceFileConflict extends Error {
  constructor(
    public readonly revision: string,
    public readonly status = 409,
  ) {
    super(status === 428 ? "workspace_file_revision_required" : "workspace_file_conflict");
  }
}

export function workspaceContentRevision(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function workspaceFileRevision(path: string): string {
  if (!existsSync(path)) return "missing";
  if (!statSync(path).isFile()) throw new Error("workspace_target_not_file");
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
    return `sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}

// Keep this check and the following rename synchronous: Host writers must not
// interleave between them. External programs can still write outside this Host operation.
export function assertWorkspaceFileRevision(path: string, expectedRevision?: string): void {
  const current = workspaceFileRevision(path);
  if (expectedRevision === undefined && current !== "missing") throw new WorkspaceFileConflict(current, 428);
  if (current !== (expectedRevision ?? "missing")) throw new WorkspaceFileConflict(current);
}
