import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";

const account = z.object({ id: z.string(), owner: z.string(), address: z.string(), name: z.string() });
const errors = [400, 401, 403, 409, 503].map((status) => ({
  status,
  body: z.object({ error: z.string(), ok: z.literal(false).optional() }).passthrough(),
}));

export const inspectNetworkAccountOperation = defineHostOperation({
  id: "network.account.inspect",
  summary: "Read whether this installation has an Agent Router configured",
  description: "Read local configuration only. Does not exchange credentials or create an account.",
  method: "GET",
  path: "/network/account",
  risk: "read",
  success: { status: 200, body: z.object({ ok: z.literal(true), configured: z.boolean() }) },
});
export const connectNetworkAccountOperation = defineHostOperation({
  id: "network.account.connect",
  summary: "Connect the signed-in admin's Agent network account",
  description:
    "Start native OIDC authorization or connect with the existing scoped grant. The main login token never reaches Router. Requires admin; credentials remain in Host memory.",
  method: "POST",
  path: "/network/account",
  risk: "write",
  body: z.object({}).strict(),
  success: {
    status: 200,
    body: z.union([
      z.object({ ok: z.literal(true), account }),
      z.object({
        ok: z.literal(true),
        authorizationUrl: z.string().url(),
        authorizationId: z.string(),
        expiresAt: z.number(),
      }),
    ]),
  },
  errors,
});
export const getNetworkAuthorizationOperation = defineHostOperation({
  id: "network.account.authorization",
  summary: "Read the current browser authorization attempt",
  description:
    "Read local attempt status for a previously verified product session. Does not contact WW or start a connection.",
  method: "GET",
  path: "/network/account/authorization",
  query: z.object({ authorizationId: z.string().min(1).max(256) }),
  risk: "read",
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      status: z.enum(["pending", "authorized", "canceled", "failed"]),
      expiresAt: z.number(),
      error: z.string().optional(),
    }),
  },
  errors,
});
export type GetNetworkAuthorizationOperation = typeof getNetworkAuthorizationOperation;
export const cancelNetworkAuthorizationOperation = defineHostOperation({
  id: "network.account.cancel",
  summary: "Cancel the pending browser authorization",
  description:
    "Cancel this attempt locally for a previously verified product session, including during WW outages. Does not change an existing connection or cancel a newer attempt.",
  method: "DELETE",
  path: "/network/account/authorization",
  query: z.object({ authorizationId: z.string().min(1).max(256) }),
  risk: "write",
  success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  errors,
});
export type CancelNetworkAuthorizationOperation = typeof cancelNetworkAuthorizationOperation;
export const addNetworkContactOperation = defineHostOperation({
  id: "network.contact.add",
  summary: "Add a remote Agent to Contacts",
  description: "Resolve an Agent network address and save a bound remote member for Room conversations.",
  method: "POST",
  path: "/network/contacts",
  risk: "write",
  body: z.object({ address: z.string().trim().min(1).max(512), name: z.string().trim().max(80).optional() }).strict(),
  success: { status: 200, body: z.object({ ok: z.literal(true), memberId: z.string() }) },
  errors,
});
export type ConnectNetworkAccountOperation = typeof connectNetworkAccountOperation;
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
      operations: [
        inspectNetworkAccountOperation,
        connectNetworkAccountOperation,
        getNetworkAuthorizationOperation,
        cancelNetworkAuthorizationOperation,
      ],
    }),
    defineHostOperationResource({
      id: "contact",
      title: "Contacts",
      description: "Remote Agents visible in the local directory.",
      operations: [addNetworkContactOperation],
    }),
  ],
});
