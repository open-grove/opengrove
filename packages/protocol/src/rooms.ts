import { z } from "zod";
import { roomMemberSchema, roomMemberInputSchema } from "./room-members.js";
import { remoteRoomTaskSchema } from "./remote-agent.js";
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
    duration: z.string().optional(),
    runId: z.string().optional(),
    remoteTask: remoteRoomTaskSchema.optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    audience: z.enum(["room", "internal"]).optional(),
    deliveryKind: z
      .enum(["user_direct", "user_broadcast", "pm_auto_route", "agent_delegation", "system_routine"])
      .optional(),
    notificationEventSeq: z.number().int().nonnegative().optional(),
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

export const listRoomMessagesOperation = defineHostOperation({
  id: "room.message.list",
  summary: "List Room messages",
  description:
    "Read visible Room messages with bounded pagination by channel sequence. Internal delegation messages remain private.",
  method: "GET",
  path: "/rooms/{roomId}/messages",
  risk: "read",
  params: z.object({ roomId: roomIdentifierSchema }),
  query: z.object({
    limit: z.number().int().positive().max(200).default(80),
    beforeSeq: z.number().int().nonnegative().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      messages: z.array(roomMessageSchema),
      currentEventSeq: z.number().int().nonnegative(),
    }),
  },
  errors: createRoomMessageOperation.errors,
});
export type ListRoomMessagesOperation = typeof listRoomMessagesOperation;
export const roomMessageOperations = [listRoomMessagesOperation, createRoomMessageOperation] as const;

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

export const listRoomsOperation = defineHostOperation({
  id: "room.room.list",
  summary: "List Rooms and Employees",
  description:
    "Read the Room snapshot, including Employees, recent messages, and the event cursor for subsequent changes.",
  method: "GET",
  path: "/rooms",
  risk: "read",
  query: z.object({
    limit: z.number().int().positive().max(200).default(80).describe("Recent messages per Room, at most 200."),
    totalLimit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .default(500)
      .describe("Total snapshot message limit, at most 1000."),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      rooms: z.array(roomSchema),
      members: z.array(roomMemberSchema),
      messages: z.array(roomMessageSchema),
      currentEventSeq: z.number().int().nonnegative(),
      deletedMemberIds: z.array(z.string()),
      messagesTruncated: z.boolean().optional(),
    }),
  },
  errors: createRoomOperation.errors,
});
export type ListRoomsOperation = typeof listRoomsOperation;

export const roomCollectionOperationResource = defineHostOperationResource({
  id: "room",
  title: "Rooms",
  description: "Room creation, discovery, and settings.",
  operations: [listRoomsOperation, createRoomOperation, updateRoomOperation, markRoomReadOperation] as const,
});

export const roomMessageOperationResource = defineHostOperationResource({
  id: "message",
  title: "Messages",
  description: "Messages recorded in a Room ledger.",
  operations: roomMessageOperations,
});

export const listRoomEventsOperation = defineHostOperation({
  id: "room.event.list",
  summary: "Read or wait for Room events",
  description:
    "Read changes after a global event cursor. Long-poll for up to 25 seconds when caught up; resetRequired means a fresh Room snapshot is needed.",
  method: "GET",
  path: "/rooms/events",
  risk: "read",
  query: z.object({
    afterEventSeq: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(1000).default(200),
    waitMs: z.number().int().nonnegative().max(25000).default(0),
    eventVersion: z.number().int().min(1).max(2).default(1),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      events: z.array(
        z.object({
          schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
          eventSeq: z.number().int().nonnegative(),
          type: z.enum([
            "room.created",
            "room.updated",
            "room.member.added",
            "room.member.updated",
            "room.member.removed",
            "room.message.created",
            "room.message.updated",
            "room.message.deleted",
          ]),
          roomId: z.string(),
          messageId: z.string().optional(),
          memberId: z.string().optional(),
          createdAt: z.string(),
          payload: z.object({
            room: roomSchema.optional(),
            member: roomMemberSchema.optional(),
            message: roomMessageSchema.optional(),
            messageId: z.string().optional(),
            memberId: z.string().optional(),
            audience: z.enum(["room", "internal"]).optional(),
            messagePatch: z
              .object({ set: roomMessageSchema.partial(), unset: z.array(z.string()).optional() })
              .optional(),
          }),
        }),
      ),
      currentEventSeq: z.number().int().nonnegative(),
      oldestAvailableEventSeq: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      resetRequired: z.boolean(),
      longPollSupported: z.literal(true),
    }),
  },
  errors: createRoomMessageOperation.errors,
});
export type ListRoomEventsOperation = typeof listRoomEventsOperation;
const roomEventOperationResource = defineHostOperationResource({
  id: "event",
  title: "Events",
  description: "Room change cursors and long polling.",
  operations: [listRoomEventsOperation] as const,
});

export const openDirectRoomOperation = defineHostOperation({
  id: "room.direct.open",
  summary: "Open an Employee conversation",
  description:
    "Open or resume a direct Room with an Employee, optionally within an installed App. Supply member metadata to restore a missing local Employee.",
  method: "POST",
  path: "/rooms/dm",
  risk: "write",
  body: z.object({
    memberId: roomIdentifierSchema,
    roomId: roomIdentifierSchema.optional(),
    appId: roomIdentifierSchema.optional(),
    title: z.string().trim().default(""),
    member: roomMemberInputSchema.optional(),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      room: roomSchema,
      member: roomMemberSchema.optional(),
      currentEventSeq: z.number().int().nonnegative(),
    }),
  },
  errors: createRoomMessageOperation.errors,
});
export type OpenDirectRoomOperation = typeof openDirectRoomOperation;
const roomDirectOperationResource = defineHostOperationResource({
  id: "direct",
  title: "Direct conversations",
  description: "Direct conversations with Employees.",
  operations: [openDirectRoomOperation] as const,
});

export const addRoomMemberOperation = defineHostOperation({
  id: "room.member.add",
  summary: "Add an Employee to a Room",
  description:
    "Add an existing Employee by id, preserving unspecified metadata, or supply metadata to create a local Employee. App scope restrictions still apply.",
  method: "POST",
  path: "/rooms/{roomId}/members",
  risk: "write",
  params: z.object({ roomId: roomIdentifierSchema }),
  body: roomMemberInputSchema,
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      member: roomMemberSchema,
      currentEventSeq: z.number().int().nonnegative(),
    }),
  },
  errors: createRoomMessageOperation.errors,
});
export const removeRoomMemberOperation = defineHostOperation({
  id: "room.member.remove",
  summary: "Remove a Room member",
  description: "Remove a member from this Room without deleting the Employee or message history.",
  method: "DELETE",
  path: "/rooms/{roomId}/members/{memberId}",
  risk: "write",
  params: z.object({ roomId: roomIdentifierSchema, memberId: roomIdentifierSchema }),
  success: createRoomOperation.success,
  errors: createRoomMessageOperation.errors,
});
export type AddRoomMemberOperation = typeof addRoomMemberOperation;
export type RemoveRoomMemberOperation = typeof removeRoomMemberOperation;
const roomMemberOperationResource = defineHostOperationResource({
  id: "member",
  title: "Members",
  description: "Manage membership within a Room.",
  operations: [addRoomMemberOperation, removeRoomMemberOperation] as const,
});

export const roomOperationGroup = defineHostOperationGroup({
  id: "room",
  title: "Rooms",
  description: "Local Room collaboration and ledger operations.",
  resources: [
    roomCollectionOperationResource,
    roomMessageOperationResource,
    roomEventOperationResource,
    roomDirectOperationResource,
    roomMemberOperationResource,
  ] as const,
});
