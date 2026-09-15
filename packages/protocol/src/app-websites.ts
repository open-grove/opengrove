import { z } from "zod";
import { defineHostOperation, defineHostOperationResource } from "./operation.js";

export const WEBSITE_PERMISSIONS = [
  "story-seed.read",
  "story-seed.write",
  "editorial.read",
  "editorial.write",
  "data.read",
  "data.write",
  "agreement.read",
  "agreement.write",
  "production.read",
  "production.write",
] as const;
export const websiteRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      utf8Length(value) <= 240 &&
      !/[\\\\\x00-\x1f?#%:]/.test(value) &&
      value !== "_og" &&
      !value.startsWith("_og/") &&
      value.split("/").every((part) => part !== "" && !part.startsWith(".")),
  );
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
const unique = (values: string[]) => new Set(values).size === values.length;
export const websiteAudienceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("public") }).strict(),
  z.object({ mode: z.literal("authenticated") }).strict(),
  z
    .object({
      mode: z.literal("roles"),
      roles: z
        .array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/))
        .min(1)
        .max(32)
        .refine(unique),
    })
    .strict(),
]);
export const appWebsiteConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    title: z.string().trim().min(1).max(160),
    mode: z.enum(["static", "http"]),
    output: websiteRelativePathSchema,
    entry: websiteRelativePathSchema.default("index.html"),
    audience: websiteAudienceSchema,
    permissions: z.array(z.enum(WEBSITE_PERMISSIONS)).max(WEBSITE_PERMISSIONS.length).refine(unique),
    includedFeatures: z.array(z.string().trim().min(1).max(240)).min(1).max(64),
    desktopOnlyFeatures: z.array(z.string().trim().min(1).max(240)).max(64),
  })
  .strict()
  .refine((value) => value.mode !== "static" || value.permissions.length === 0, {
    message: "Static websites cannot request Cloud API permissions",
  });
export const appWebsiteReviewInputSchema = z
  .object({
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(12).max(4000),
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(32),
  })
  .strict();
export const appWebsiteReviewSchema = appWebsiteReviewInputSchema.extend({
  schemaVersion: z.literal(1),
  reviewedAt: z.string().datetime(),
});
export const appWebsiteInspectionSchema = z.object({
  ready: z.boolean(),
  config: appWebsiteConfigSchema.optional(),
  findings: z.array(z.object({ code: z.string(), path: z.string().optional() })),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export const appWebsiteSiteSchema = z.object({
  appId: z.string(),
  host: z.string(),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string(),
});
export const appWebsiteStateSchema = z.object({
  inspection: appWebsiteInspectionSchema,
  artifactSha256: z.string().optional(),
  review: appWebsiteReviewSchema.optional(),
  reviewStatus: z.enum(["required", "stale", "current", "blocked"]),
  site: appWebsiteSiteSchema.optional(),
  remoteError: z.string().optional(),
  reviewTarget: z.object({ roomId: z.string(), memberId: z.string() }).optional(),
});
export type AppWebsiteConfig = z.output<typeof appWebsiteConfigSchema>;
export type AppWebsiteReviewInput = z.output<typeof appWebsiteReviewInputSchema>;
export type AppWebsiteInspection = z.output<typeof appWebsiteInspectionSchema>;
export type AppWebsiteState = z.output<typeof appWebsiteStateSchema>;
export type AppWebsiteSite = z.output<typeof appWebsiteSiteSchema>;
const params = z.object({ appId: z.string().min(1) });
const errors = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504].map((status) => ({
  status,
  body: z.object({ ok: z.literal(false), error: z.string() }),
  schemaId: "AppWebsiteError",
  description: "The website operation could not be completed.",
}));
const stateSuccess = {
  status: 200,
  body: z.object({ ok: z.literal(true), website: appWebsiteStateSchema }),
  schemaId: "AppWebsiteStateResponse",
} as const;
export const getAppWebsiteOperation = defineHostOperation({
  id: "app.website.get",
  summary: "Inspect an App website",
  description: "Inspect browser output, review freshness, and the currently published website.",
  method: "GET",
  path: "/apps/{appId}/website",
  risk: "read",
  params,
  success: stateSuccess,
  errors,
});
export const prepareAppWebsiteOperation = defineHostOperation({
  id: "app.website.prepare",
  summary: "Prepare an App website",
  description:
    "Create a browser publication configuration when possible and run deterministic checks. Existing configuration is preserved.",
  method: "POST",
  path: "/apps/{appId}/website/prepare",
  risk: "write",
  params,
  success: stateSuccess,
  errors,
});
export const configureAppWebsiteOperation = defineHostOperation({
  id: "app.website.configure",
  summary: "Set website audience",
  description: "Set the website audience independently of App Store visibility. Changing it requires a fresh review.",
  method: "PUT",
  path: "/apps/{appId}/website/audience",
  risk: "write",
  params,
  body: z.object({ audience: websiteAudienceSchema }),
  success: stateSuccess,
  errors,
});
export const publishAppWebsiteOperation = defineHostOperation({
  id: "app.website.publish",
  summary: "Publish an App website",
  description: "Publish the exact reviewed browser artifact and atomically replace the expected current version.",
  method: "POST",
  path: "/apps/{appId}/website/publish",
  risk: "high-risk-write",
  params,
  body: z.object({
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSha256: z.string().regex(/^(?:[a-f0-9]{64})?$/),
  }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), site: appWebsiteSiteSchema }),
    schemaId: "AppWebsitePublishResponse",
  },
  errors,
});
export const activateAppWebsiteOperation = defineHostOperation({
  id: "app.website.activate",
  summary: "Restore a published website version",
  description:
    "Atomically activate a previously accepted immutable website version, including its audience and permissions.",
  method: "POST",
  path: "/apps/{appId}/website/activate",
  risk: "high-risk-write",
  params,
  body: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), site: appWebsiteSiteSchema }),
    schemaId: "AppWebsitePublishResponse",
  },
  errors,
});
export const appWebsiteOperations = [
  getAppWebsiteOperation,
  prepareAppWebsiteOperation,
  configureAppWebsiteOperation,
  publishAppWebsiteOperation,
  activateAppWebsiteOperation,
] as const;
export const appWebsiteOperationResource = defineHostOperationResource({
  id: "website",
  title: "App websites",
  description: "Independent browser publication and access policy.",
  operations: appWebsiteOperations,
});
