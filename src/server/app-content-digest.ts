import { createHash } from "node:crypto";
import { compareUtf8Bytes } from "./utf8-byte-order.js";

export function appCandidateContentDigest(packageManifest: Record<string, unknown>): string {
  const files = record(packageManifest.files);
  const canonicalFiles = Object.fromEntries(
    Object.entries(files)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => compareUtf8Bytes(left, right)),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: packageManifest.schemaVersion,
        packageKey: stringValue(packageManifest.packageKey),
        packageId: stringValue(packageManifest.packageId),
        appId: stringValue(packageManifest.appId),
        version: stringValue(packageManifest.version),
        workspacePath: stringValue(packageManifest.workspacePath),
        files: canonicalFiles,
      }),
    )
    .digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
