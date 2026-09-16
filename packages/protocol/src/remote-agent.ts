import { z } from "zod";

export const accountRemoteAgentBindingSchema = z
  .object({
    accountIssuer: z.string().url(),
    accountUserId: z.string().min(1),
    serviceUrl: z.string().url(),
    matrixId: z.string().min(1),
    provider: z.string().min(1),
    senderAgentId: z.string().min(1),
    owner: z.string().min(1),
    address: z.string().min(1),
  })
  .strict();
export type AccountRemoteAgentBinding = z.infer<typeof accountRemoteAgentBindingSchema>;
export const remoteAgentBindingSchema = accountRemoteAgentBindingSchema;
export type RemoteAgentBinding = z.infer<typeof remoteAgentBindingSchema>;

export const remoteRoomTaskSchema = z
  .object({
    contextId: z.string().min(1).optional(),
    messageId: z.string().min(1),
    requestText: z.string().min(1).max(32000).optional(),
    triggerMessageId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    inputTaskId: z.string().min(1).optional(),
    sendStarted: z.boolean().optional(),
    needsInput: z.boolean().optional(),
    pending: z.boolean(),
    cancelRequested: z.boolean().optional(),
    statusText: z.string().optional(),
  })
  .strict();
export type RemoteRoomTask = z.infer<typeof remoteRoomTaskSchema>;
