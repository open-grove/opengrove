import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";

const authErrorSchema = z
  .object({
    ok: z.literal(false).optional(),
    error: z.string(),
    code: z.string().optional(),
    requestId: z.string().optional(),
    incidentId: z.string().optional(),
    traceId: z.string().optional(),
    retryAfter: z.number().nonnegative().optional(),
  })
  .passthrough();

const authErrorStatuses = [400, 401, 403, 408, 409, 413, 425, 429, 500, 502, 503, 504] as const;

function authErrors(description: string) {
  return authErrorStatuses.map((status) => ({ status, body: authErrorSchema, description, schemaId: "AuthError" }));
}

const accountUserSchema = z
  .object({
    userId: z.string(),
    email: z.string(),
    countryCode: z.string().optional(),
    displayName: z.string(),
    avatarUrl: z.string().optional(),
    profileUpdatedAt: z.string().optional(),
    profileStatus: z.enum(["available", "missing", "unavailable"]).optional(),
    role: z.string(),
    roles: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    lastLoginAt: z.string().optional(),
  })
  .passthrough();

const providerProvisioningSchema = z
  .object({
    status: z.enum(["configured", "already-configured", "skipped", "failed"]),
    providerId: z.string().optional(),
    createdApiKey: z.boolean().optional(),
    retryable: z.boolean().optional(),
    retryAt: z.iso.datetime().optional(),
    defaultedKernels: z.array(z.string()).optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const createAuthEmailCodeOperation = defineHostOperation({
  id: "auth.email-code.create",
  summary: "Send an account login code",
  description: "Send an email verification code for the existing OpenGrove account login flow.",
  method: "POST",
  path: "/auth/email-codes",
  risk: "write",
  body: z.object({
    email: z.string().trim().min(1).describe("OpenGrove account email address."),
  }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      requiresInvite: z.boolean().optional(),
      requiresCountry: z.boolean().optional(),
    }),
  },
  errors: authErrors("The login code could not be sent."),
});

export const createAuthSessionOperation = defineHostOperation({
  id: "auth.session.create",
  summary: "Create an account session",
  description: "Exchange an email verification code for an OpenGrove account session.",
  method: "POST",
  path: "/auth/login",
  risk: "write",
  body: z.object({
    email: z.string().trim().min(1).describe("OpenGrove account email address."),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u)
      .describe("Six-digit email verification code."),
    inviteCode: z.string().optional().describe("Invite code when account registration requires one."),
    countryCode: z.string().optional().describe("ISO country or region code for a new account."),
    deviceName: z.string().optional().describe("Human-readable name for this client session."),
    platform: z.string().optional().describe("Client platform identifier."),
    languagePreference: z.enum(["system", "zh-CN", "en"]).optional(),
    systemLanguage: z.enum(["zh-CN", "en"]).optional(),
  }),
  success: {
    status: 200,
    body: z
      .object({
        user: accountUserSchema,
        isNewUser: z.boolean().optional(),
        providerProvisioning: providerProvisioningSchema.optional(),
        defaultStoreApps: z.unknown().optional(),
        appUpdates: z.unknown().optional(),
      })
      .passthrough(),
  },
  errors: authErrors("The account session could not be created."),
});

export const getAuthSessionOperation = defineHostOperation({
  id: "auth.session.get",
  summary: "Get the current account session",
  description: "Verify and return the current OpenGrove account session.",
  method: "GET",
  path: "/auth/session",
  risk: "read",
  success: {
    status: 200,
    body: z.union([
      z
        .object({
          status: z.literal("authenticated"),
          authenticated: z.literal(true),
          verification: z.enum(["verified", "cached", "stale"]),
          user: accountUserSchema,
        })
        .passthrough(),
      z
        .object({
          status: z.literal("unauthenticated"),
          authenticated: z.literal(false),
          reason: z.string(),
        })
        .passthrough(),
      z
        .object({
          status: z.literal("temporarily_unavailable"),
          error: z.string(),
          incidentId: z.string().optional(),
          traceId: z.string().optional(),
        })
        .passthrough(),
    ]),
  },
  errors: authErrors("The account session could not be read."),
});

export const deleteAuthSessionOperation = defineHostOperation({
  id: "auth.session.delete",
  summary: "Delete the current account session",
  description: "Log out the current OpenGrove account session and clear its credentials.",
  method: "POST",
  path: "/auth/logout",
  risk: "write",
  success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  errors: authErrors("The account session could not be deleted."),
});

export type CreateAuthEmailCodeOperation = typeof createAuthEmailCodeOperation;
export type CreateAuthSessionOperation = typeof createAuthSessionOperation;
export type GetAuthSessionOperation = typeof getAuthSessionOperation;
export type DeleteAuthSessionOperation = typeof deleteAuthSessionOperation;

export const authEmailCodeOperationResource = defineHostOperationResource({
  id: "email-code",
  title: "Email codes",
  description: "Email verification codes for OpenGrove account authentication.",
  operations: [createAuthEmailCodeOperation] as const,
});

export const authSessionOperationResource = defineHostOperationResource({
  id: "session",
  title: "Sessions",
  description: "OpenGrove account sessions used by Host clients.",
  operations: [createAuthSessionOperation, getAuthSessionOperation, deleteAuthSessionOperation] as const,
});

export const authOperationGroup = defineHostOperationGroup({
  id: "auth",
  title: "Authentication",
  description: "OpenGrove account authentication and session operations.",
  resources: [authEmailCodeOperationResource, authSessionOperationResource] as const,
});
