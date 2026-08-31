import { z } from "zod";

export type AppStorePackageVisibility = "private" | "unlisted";

export type AppStoreTokenScope = "read" | "publish";

export interface AppStoreRequirements {
  providers: string[];
  env: string[];
  system: string[];
}

export interface AppStorePackageIndexEntry {
  packageKey: string;
  packageId: string;
  appId: string;
  title: string;
  description?: string;
  version: string;
  minHostReleaseNumber?: number;
  publisher?: string;
  namespace: string;
  archiveSha256?: string;
  archiveSize?: number;
  publishedAt: string;
  visibility: AppStorePackageVisibility;
  requirements: AppStoreRequirements;
}

export interface AppStorePackageVersionEntry {
  version: string;
  archiveSha256: string;
  archiveSize: number;
  packageManifestSha256?: string;
  publishedAt: string;
  fileName: string;
  revokedAt?: string;
}

export interface AppStorePackageDetail extends AppStorePackageIndexEntry {
  archiveSha256: string;
  archiveSize: number;
  versions: AppStorePackageVersionEntry[];
}

export interface AppStoreDownloadUrlResponse {
  url: string;
  expiresAt: string;
  archiveSha256: string;
  archiveSize: number;
  fileName: string;
}

export interface PackageProvenance {
  vcs: "git";
  commit: string;
  dirty: boolean;
  branch?: string;
  remote?: string;
}

export interface OpenGrovePackageManifest {
  schemaVersion: 1;
  packageKey?: string;
  packageId: string;
  appId: string;
  version: string;
  workspacePath?: string;
  files: Record<string, string>;
  excluded: string[];
  provenance?: PackageProvenance;
}

export interface RegistryInstallMarker {
  schemaVersion: 1;
  source: "registry";
  registryUrl: string;
  packageRef: string;
  packageKey: string;
  packageId: string;
  appId: string;
  version: string;
  archiveSha256: string;
  packageManifestSha256?: string;
  installedAt: string;
}

export const appStorePackageVisibilitySchema = z.enum(["private", "unlisted"]);

export const appStoreTokenScopeSchema = z.enum(["read", "publish"]);

export const appStoreRequirementsSchema = z.object({
  providers: z.array(z.string()),
  env: z.array(z.string()),
  system: z.array(z.string()),
});

export const appStorePackageIndexEntrySchema = z.object({
  packageKey: z.string().min(1),
  packageId: z.string().min(1),
  appId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  minHostReleaseNumber: z.number().int().positive().optional(),
  publisher: z.string().optional(),
  namespace: z.string().min(1),
  archiveSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  archiveSize: z.number().int().nonnegative().optional(),
  publishedAt: z.string().min(1),
  visibility: appStorePackageVisibilitySchema,
  requirements: appStoreRequirementsSchema,
});

export const appStorePackageVersionEntrySchema = z.object({
  version: z.string().min(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSize: z.number().int().nonnegative(),
  packageManifestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  publishedAt: z.string().min(1),
  fileName: z.string().min(1),
  revokedAt: z.string().optional(),
});

export const appStorePackageDetailSchema = appStorePackageIndexEntrySchema.extend({
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSize: z.number().int().nonnegative(),
  versions: z.array(appStorePackageVersionEntrySchema),
});

export const appStoreDownloadUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().min(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSize: z.number().int().nonnegative(),
  fileName: z.string().min(1),
});

export const packageProvenanceSchema = z.object({
  vcs: z.literal("git"),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  dirty: z.boolean(),
  branch: z.string().min(1).optional(),
  remote: z.string().min(1).optional(),
});

export const openGrovePackageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  packageKey: z.string().min(1).optional(),
  packageId: z.string().min(1),
  appId: z.string().min(1),
  version: z.string().min(1),
  workspacePath: z.string().optional(),
  files: z.record(z.string(), z.string()),
  excluded: z.array(z.string()),
  provenance: packageProvenanceSchema.optional(),
});

export const registryInstallMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("registry"),
  registryUrl: z.string().url(),
  packageRef: z.string().min(1),
  packageKey: z.string().min(1),
  packageId: z.string().min(1),
  appId: z.string().min(1),
  version: z.string().min(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  packageManifestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  installedAt: z.string().min(1),
});
