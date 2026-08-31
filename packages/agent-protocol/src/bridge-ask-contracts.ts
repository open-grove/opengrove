import { z } from "zod";
import { defineBridgeJsonContract } from "./bridge-contract.js";

const runSelectorSchema = {
  runId: z.string().optional(),
  threadId: z.string().optional(),
};

export const askCancelContract = defineBridgeJsonContract({
  id: "ask.cancel",
  request: z.object(runSelectorSchema),
  response: z.object({
    ok: z.boolean(),
    cancelled: z.boolean(),
  }),
});

export const askGuideContract = defineBridgeJsonContract({
  id: "ask.guide",
  request: z.object({
    ...runSelectorSchema,
    instruction: z.string(),
  }),
  response: z.object({
    ok: z.boolean(),
    guided: z.boolean(),
    error: z.string().optional(),
  }),
});

export const askCompactContract = defineBridgeJsonContract({
  id: "ask.compact",
  request: z.object({
    threadId: z.string(),
    reason: z.string().optional(),
  }),
  response: z.object({
    ok: z.boolean(),
    compacted: z.boolean(),
    error: z.string().optional(),
  }),
});
