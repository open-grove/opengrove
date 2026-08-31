import { createHash } from "node:crypto";

export interface AppStorePublishIdempotencyInput {
  registryUrl: string;
  appId: string;
  version: string;
  packageKey?: string;
  packageId?: string;
  visibility?: string;
  publishKind?: string;
}

export function appStorePublishIdempotencyKey(input: AppStorePublishIdempotencyInput): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: input.registryUrl.trim().replace(/\/+$/g, ""),
        publishKind: input.publishKind?.trim() || "app",
        appId: input.appId.trim(),
        packageIdentity: input.packageKey?.trim() || input.packageId?.trim() || input.appId.trim(),
        version: input.version.trim(),
        visibility: input.visibility?.trim() || "restricted",
      }),
    )
    .digest("hex");
  return `og-app-publish-${digest}`;
}

export function appStorePublishRequestIdempotencyKey(publishKey: string, operation: "create" | "version"): string {
  const digest = createHash("sha256").update(`${publishKey}\n${operation}`).digest("hex");
  return `og-app-publish-request-${digest}`;
}
