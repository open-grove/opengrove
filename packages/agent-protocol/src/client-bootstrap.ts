import { z } from "zod";
import { defineBridgeJsonContract } from "./bridge-contract.js";

export const clientBootstrapSchema = z.object({
  environment: z.object({
    preset: z.enum(["local-single", "web-single", "test"]),
    profile: z.enum(["local", "test"]),
    tenancy: z.literal("single-principal"),
    execution: z.enum(["local-process", "fake"]),
    workspace: z.enum(["host-local", "memory"]),
    stateStore: z.enum(["json", "sqlite", "memory"]),
    blobStore: z.enum(["filesystem", "memory"]),
    auth: z.enum(["bridge-token", "session"]),
  }),
  auth: z.object({
    mode: z.enum(["bridge-token", "session"]),
    tokenRequired: z.boolean(),
  }),
  hostId: z.string().regex(/^[0-9a-f]{16}$/u),
  mcpApps: z.object({
    sandboxOrigin: z.string().url().optional(),
  }),
});

export type ClientBootstrap = z.infer<typeof clientBootstrapSchema>;

export const clientBootstrapContract = defineBridgeJsonContract({
  id: "client.bootstrap",
  response: clientBootstrapSchema,
});
