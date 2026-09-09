import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";

const account = z.object({ id: z.string(), owner: z.string(), address: z.string(), name: z.string() });
const errors = [400, 401, 403, 409, 503].map((status) => ({
  status,
  body: z.object({ error: z.string(), ok: z.literal(false).optional() }).passthrough(),
}));

export const inspectNetworkAccountOperation = defineHostOperation({
  id: "network.account.inspect",
  summary: "Connect the signed-in admin's Agent network account",
  description:
    "Exchange the current OpenGrove login at the operator's trusted Agent Router node and return public sender identity. Requires admin; credentials remain in Host memory.",
  method: "POST",
  path: "/network/account",
  risk: "read",
  body: z.object({}).strict(),
  success: { status: 200, body: z.object({ ok: z.literal(true), account }) },
  errors,
});
export const addNetworkContactOperation = defineHostOperation({
  id: "network.contact.add",
  summary: "Add a remote Agent to Contacts",
  description: "Resolve an Agent network address and save a bound remote member for direct conversations.",
  method: "POST",
  path: "/network/contacts",
  risk: "write",
  body: z.object({ address: z.string().trim().min(1).max(512), name: z.string().trim().max(80).optional() }).strict(),
  success: { status: 200, body: z.object({ ok: z.literal(true), memberId: z.string() }) },
  errors,
});
export type InspectNetworkAccountOperation = typeof inspectNetworkAccountOperation;
export type AddNetworkContactOperation = typeof addNetworkContactOperation;

export const networkOperationGroup = defineHostOperationGroup({
  id: "network",
  title: "Agent network",
  description: "Remote Agent contacts and account connections.",
  resources: [
    defineHostOperationResource({
      id: "account",
      title: "Accounts",
      description: "Communication identity for the current OpenGrove admin account.",
      operations: [inspectNetworkAccountOperation],
    }),
    defineHostOperationResource({
      id: "contact",
      title: "Contacts",
      description: "Remote Agents visible in the local directory.",
      operations: [addNetworkContactOperation],
    }),
  ],
});
