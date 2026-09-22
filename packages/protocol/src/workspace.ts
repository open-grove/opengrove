import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostErrorSchema, hostRequestErrors } from "./host-errors.js";

export const workspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  updatedAt: z.string().optional(),
  get children() {
    return z.array(workspaceFileEntrySchema).optional();
  },
});
export const workspaceFileSchema = z.object({
  entry: workspaceFileEntrySchema,
  revision: z.string().optional(),
  content: z.string().optional(),
  contentTruncated: z.boolean().optional(),
});
const params = z.object({ sessionId: z.string().min(1) });
const errors = [
  ...hostRequestErrors,
  { status: 404, body: hostErrorSchema },
  { status: 409, body: hostErrorSchema },
  { status: 428, body: hostErrorSchema },
] as const;
export const listWorkspaceFilesOperation = defineHostOperation({
  id: "workspace.file.list",
  summary: "List session workspace files",
  description:
    "List files under the workspace bound to an independent session. A session identifier does not grant authority independently of Host authentication.",
  method: "GET",
  path: "/sessions/{sessionId}/files",
  risk: "read",
  params,
  query: z.object({
    path: z.string().default(""),
    maxDepth: z.number().int().min(0).max(10).default(2),
    maxEntries: z.number().int().min(1).max(1200).default(200),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      entries: z.array(workspaceFileEntrySchema),
      count: z.number(),
      truncated: z.boolean(),
    }),
  },
  errors,
});
export const readWorkspaceFileOperation = defineHostOperation({
  id: "workspace.file.read",
  summary: "Read a session workspace file",
  description:
    "Read bounded text content and its revision. Paths and symlinks must remain inside the session workspace.",
  method: "GET",
  path: "/sessions/{sessionId}/file",
  risk: "read",
  params,
  query: z.object({ path: z.string().min(1), maxBytes: z.number().int().min(1).max(5_000_000).default(500_000) }),
  success: { status: 200, body: z.object({ ok: z.literal(true), file: workspaceFileSchema }) },
  errors,
});
export const writeWorkspaceFileOperation = defineHostOperation({
  id: "workspace.file.write",
  summary: "Write a session workspace file",
  description:
    "Atomically write a text file. Send the revision from read to replace an existing file, or missing to create one. Conflicting writes are rejected.",
  method: "PUT",
  path: "/sessions/{sessionId}/file",
  risk: "write",
  params,
  body: z.object({
    path: z.string().min(1),
    content: z.string().max(5_000_000),
    expectedRevision: z.string().min(1).default("missing"),
  }),
  success: { status: 200, body: z.object({ ok: z.literal(true), file: workspaceFileSchema }) },
  errors,
});
export const workspaceOperationGroup = defineHostOperationGroup({
  id: "workspace",
  title: "Workspaces",
  description: "Access explicitly bound local project files.",
  resources: [
    defineHostOperationResource({
      id: "file",
      title: "Files",
      description: "Revision-aware project file access.",
      operations: [listWorkspaceFilesOperation, readWorkspaceFileOperation, writeWorkspaceFileOperation] as const,
    }),
  ] as const,
});
