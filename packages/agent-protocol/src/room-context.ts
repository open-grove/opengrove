import { z } from "zod";

export interface RoomContextPageRequest {
  limit?: number;
  cursor?: string;
  beforeSeq?: number;
  afterSeq?: number;
}

export interface LocalRoomContextRef {
  kind: "local-room";
  sourceRoomId: string;
}

export interface LocalHttpRoomContextRef {
  kind: "local-http-capability";
  sourceRoomId: string;
  readUrl: string;
  token: string;
  expiresAt: string;
}

export type RoomContextRef = LocalRoomContextRef | LocalHttpRoomContextRef;

export interface RoomLedgerCapability {
  sourceRoomId: string;
  readUrl: string;
  token: string;
  expiresAt: string;
}

export const roomContextPageRequestSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
  beforeSeq: z.number().int().nonnegative().optional(),
  afterSeq: z.number().int().nonnegative().optional(),
});

export const localRoomContextRefSchema = z.object({
  kind: z.literal("local-room"),
  sourceRoomId: z.string().min(1),
});

export const localHttpRoomContextRefSchema = z.object({
  kind: z.literal("local-http-capability"),
  sourceRoomId: z.string().min(1),
  readUrl: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const roomContextRefSchema = z.discriminatedUnion("kind", [
  localRoomContextRefSchema,
  localHttpRoomContextRefSchema,
]);

export const roomLedgerCapabilitySchema = z.object({
  sourceRoomId: z.string().min(1),
  readUrl: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
});
