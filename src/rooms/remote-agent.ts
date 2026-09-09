import { z } from "zod";

export const remoteAgentBindingSchema = z
  .object({
    profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    senderAgentId: z.string().min(1),
    owner: z.string().min(1),
    address: z.string().min(1),
  })
  .strict();
export type RemoteAgentBinding = z.infer<typeof remoteAgentBindingSchema>;

export const remoteRoomTaskSchema = z
  .object({
    contextId: z.string().min(1).optional(),
    messageId: z.string().min(1),
    triggerMessageId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    inputTaskId: z.string().min(1).optional(),
    sendStarted: z.boolean().optional(),
    needsInput: z.boolean().optional(),
    pending: z.boolean(),
    cancelRequested: z.boolean().optional(),
  })
  .strict();
export type RemoteRoomTask = z.infer<typeof remoteRoomTaskSchema>;
