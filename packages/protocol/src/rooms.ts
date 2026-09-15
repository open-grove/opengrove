import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";

const roomIdentifierSchema = z.string().trim().min(1);

const roomGeneratedTitleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numbered-group"), sequence: z.number().int().positive() }),
  z.object({ kind: z.literal("app-group"), appId: roomIdentifierSchema, sequence: z.number().int().positive() }),
]);

const appRoomScopeSchema = z.object({
  kind: z.literal("app"),
  appId: roomIdentifierSchema,
  role: z.enum(["default", "group", "direct"]).optional(),
});

function optionalRoomIdentifier(description: string) {
  return roomIdentifierSchema
    .nullish()
    .transform((value) => value ?? undefined)
    .describe(description);
}

function roomIdentifierList(description: string) {
  return z
    .array(z.string())
    .nullable()
    .default([])
    .transform((values) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))])
    .describe(description);
}

const roomMessageAttachmentsSchema = z
  .array(z.unknown())
  .nullable()
  .default([])
  .transform((value) => value ?? [])
  .describe("Structured message attachments; null is treated as an empty list.");

const roomSelectedFileSchema = z
  .object({ path: z.string() })
  .nullish()
  .transform((value) => {
    const path = value?.path.trim() ?? "";
    return path ? { path } : undefined;
  })
  .describe("Selected local file reference; null or an empty path means no selected file.");

const roomSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["group", "direct"]),
    title: z.string(),
    badge: z.string(),
    memberIds: z.array(z.string()),
    adminMemberIds: z.array(z.string()),
    updatedAt: z.string(),
    unread: z.number().int().nonnegative(),
    scope: appRoomScopeSchema.optional(),
    generatedTitle: roomGeneratedTitleSchema.optional(),
    removedMemberIds: z.array(z.string()).optional(),
    directMemberId: z.string().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    lastReadEventSeq: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const roomMessageSchema = z
  .object({
    id: z.string(),
    roomId: z.string(),
    channelSeq: z.number().int().nonnegative(),
    senderId: z.string(),
    senderName: z.string(),
    senderType: z.enum(["user", "agent", "system"]),
    text: z.string(),
    targetIds: z.array(z.string()),
    status: z.enum(["sent", "running", "done", "failed", "interrupted"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    attachments: z.array(z.unknown()).optional(),
    parts: z.array(z.record(z.string(), z.unknown())).optional(),
    inReplyToMessageId: z.string().optional(),
    rootMessageId: z.string().optional(),
    selectedFile: z.object({ path: z.string() }).passthrough().optional(),
  })
  .passthrough();

const bridgeErrorSchema = z
  .object({
    ok: z.literal(false).optional(),
    error: z.string(),
    code: z.string().optional(),
    traceId: z.string().optional(),
  })
  .passthrough();

export const createRoomMessageOperation = defineHostOperation({
  id: "room.message.create",
  summary: "Send a Room message",
  description: "Send a user message to a Room and schedule addressed Employees.",
  method: "POST",
  path: "/rooms/{roomId}/messages",
  risk: "write",
  params: z.object({
    roomId: roomIdentifierSchema.describe("Room identifier; surrounding whitespace is ignored."),
  }),
  body: z.object({
    text: z.string().default("").describe("Message text."),
    targetIds: roomIdentifierList(
      "Employee identifiers addressed by the message; surrounding whitespace is ignored, and empty or duplicate values are removed.",
    ),
    attachments: roomMessageAttachmentsSchema,
    selectedFile: roomSelectedFileSchema,
    userMessageId: optionalRoomIdentifier(
      "Caller-provided idempotent user message identifier; surrounding whitespace is ignored.",
    ),
    assistantMessageIds: roomIdentifierList(
      "Reserved assistant message identifiers; surrounding whitespace is ignored, and empty or duplicate values are removed.",
    ),
    inReplyToMessageId: optionalRoomIdentifier(
      "Parent message identifier for a reply; surrounding whitespace is ignored.",
    ),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      room: roomSchema,
      userMessage: roomMessageSchema,
      assistantMessages: z.array(roomMessageSchema),
      currentEventSeq: z.number().int().nonnegative(),
    }),
  },
  errors: [
    {
      status: 400,
      body: bridgeErrorSchema,
      description: "The request does not satisfy the operation contract.",
    },
    {
      status: 401,
      body: bridgeErrorSchema,
      description: "A valid Bridge session or token is required.",
    },
    {
      status: 403,
      body: bridgeErrorSchema,
      description: "The request origin is not allowed.",
    },
    {
      status: 404,
      body: bridgeErrorSchema,
      description: "The reply parent message does not exist.",
    },
    {
      status: 409,
      body: bridgeErrorSchema,
      description:
        "The message ID conflicts with an earlier message, or the remote conversation belongs to another account or sender.",
    },
    {
      status: 503,
      body: bridgeErrorSchema,
      description: "The authenticated session is temporarily unavailable.",
    },
  ],
});

export type CreateRoomMessageOperation = typeof createRoomMessageOperation;
export type CreateRoomMessageRequest = z.input<typeof createRoomMessageOperation.body>;
export type CreateRoomMessageResponse = z.output<NonNullable<typeof createRoomMessageOperation.success.body>>;

export const roomMessageOperations = [createRoomMessageOperation] as const;

export const createRoomOperation = defineHostOperation({
  id: "room.room.create",
  summary: "Create a Room",
  description:
    "Create a group Room, optionally scoped to an installed App. App-scoped rooms retain their authoritative employee roster.",
  method: "POST",
  path: "/rooms",
  risk: "write",
  body: z.object({
    id: roomIdentifierSchema.optional().describe("Optional caller-selected Room identifier."),
    title: z.string().trim().default("").describe("Room title."),
    badge: z.string().trim().default("").describe("Room badge."),
    memberIds: roomIdentifierList("Initial member identifiers."),
    adminMemberIds: z.array(roomIdentifierSchema).optional().describe("Members allowed to delegate work."),
    scope: z
      .object({ kind: z.literal("app"), appId: roomIdentifierSchema, role: z.enum(["default", "group"]).optional() })
      .optional(),
    generatedTitle: roomGeneratedTitleSchema.optional(),
  }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), room: roomSchema, currentEventSeq: z.number().int().nonnegative() }),
  },
  errors: createRoomMessageOperation.errors,
});

export type CreateRoomOperation = typeof createRoomOperation;

export const updateRoomOperation = defineHostOperation({
  id: "room.room.update",
  summary: "Update a Room",
  description:
    "Rename, pin, archive, or update the administrators of a Room. Rooms with active runs cannot be archived.",
  method: "PATCH",
  path: "/rooms/{roomId}",
  risk: "write",
  params: z.object({ roomId: roomIdentifierSchema }),
  body: z.object({
    title: z.string().trim().optional(),
    generatedTitle: roomGeneratedTitleSchema.nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    badge: z.string().trim().optional(),
    adminMemberIds: z.array(roomIdentifierSchema).optional(),
  }),
  success: createRoomOperation.success,
  errors: createRoomOperation.errors,
});

export const markRoomReadOperation = defineHostOperation({
  id: "room.room.read",
  summary: "Mark a Room as read",
  description:
    "Advance a Room's read cursor to an event sequence observed by this client. A cursor ahead of the Host is rejected.",
  method: "POST",
  path: "/rooms/{roomId}/read",
  risk: "write",
  params: z.object({ roomId: roomIdentifierSchema }),
  body: z.object({ observedEventSeq: z.number().int().nonnegative() }),
  success: createRoomOperation.success,
  errors: createRoomOperation.errors,
});

export type UpdateRoomOperation = typeof updateRoomOperation;
export type MarkRoomReadOperation = typeof markRoomReadOperation;

export const roomCollectionOperationResource = defineHostOperationResource({
  id: "room",
  title: "Rooms",
  description: "Room creation, discovery, and settings.",
  operations: [createRoomOperation, updateRoomOperation, markRoomReadOperation] as const,
});

export const roomMessageOperationResource = defineHostOperationResource({
  id: "message",
  title: "Messages",
  description: "Messages recorded in a Room ledger.",
  operations: roomMessageOperations,
});

export const roomOperationGroup = defineHostOperationGroup({
  id: "room",
  title: "Rooms",
  description: "Local Room collaboration and ledger operations.",
  resources: [roomCollectionOperationResource, roomMessageOperationResource] as const,
});
