import { z } from "zod";

// Supports: OpenGrove 0.6.6 CLI contacts without product-account identity.
// Remove when: OpenGrove 0.7.0 or later supplies an explicit importer for their history.
// Keep history without adopting its sender into an SDK session; see docs/product/REMOTE_AGENTS.md.
export const legacyRemoteAgentBindingSchema = z
  .object({
    profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    senderAgentId: z.string().min(1),
    owner: z.string().min(1),
    address: z.string().min(1),
  })
  .strict();
