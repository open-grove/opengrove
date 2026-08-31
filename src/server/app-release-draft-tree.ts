import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenGroveAppManifest } from "../app-builder/manifest.js";
import { normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import type { JsonObject } from "../core.js";
import { mountedAppReleaseManifest, type MountedAppReleaseDraft } from "./app-release.js";
import { extractAppStoreAppArchive } from "./app-store.js";
import type { LocalAppDraftStore } from "./local-app-drafts.js";

export interface MaterializedAppReleaseDraftTree {
  appRoot: string;
  packageKey: string;
  projectedManifest: OpenGroveAppManifest;
  dispose(): void;
}

export function canonicalAppReleasePackageKey(appId: string, packageKey?: string): string {
  const canonical =
    normalizeAppStorePackageKey(packageKey) ?? normalizeAppStorePackageKey(`opengrove.${appId.toLowerCase()}`);
  if (!canonical) throw new Error("app_release_package_identity_invalid");
  return canonical;
}

export function materializeAppReleaseDraftTree(input: {
  draftStore: LocalAppDraftStore;
  localAppId: string;
  expectedDraftDigest: string;
  expectedDraftArchiveSha256: string;
  release: MountedAppReleaseDraft;
  packageKey?: string;
}): MaterializedAppReleaseDraftTree {
  const draft = input.draftStore.read(input.localAppId);
  if (!draft) throw new Error("local_app_draft_not_found");
  if (
    !/^[a-f0-9]{64}$/.test(input.expectedDraftDigest) ||
    draft.contentDigest !== input.expectedDraftDigest ||
    !/^[a-f0-9]{64}$/.test(input.expectedDraftArchiveSha256) ||
    draft.archiveSha256 !== input.expectedDraftArchiveSha256
  ) {
    throw new Error("app_store_publish_draft_changed");
  }
  const archivePath = input.draftStore.archivePath(input.localAppId);
  if (!archivePath) throw new Error("local_app_draft_not_found");
  const archiveBytes = readFileSync(archivePath);
  if (archiveBytes.byteLength !== draft.archiveSize || sha256(archiveBytes) !== draft.archiveSha256) {
    throw new Error("app_store_publish_draft_changed");
  }
  if (draft.appId !== input.release.identity.appId) {
    throw new Error("app_release_draft_identity_mismatch");
  }

  const packageKey = canonicalAppReleasePackageKey(draft.appId, input.packageKey ?? input.release.identity.packageKey);
  const temporaryContainer = mkdtempSync(join(tmpdir(), "opengrove-app-release-draft-"));
  const appRoot = join(temporaryContainer, "app");
  const capturedArchivePath = join(temporaryContainer, "draft.tgz");
  try {
    writeFileSync(capturedArchivePath, archiveBytes, { mode: 0o600 });
    extractAppStoreAppArchive({
      archivePath: capturedArchivePath,
      targetRoot: appRoot,
    });
    rmSync(join(appRoot, ".opengrove-package-manifest.json"), { force: true });
    rmSync(join(appRoot, ".opengrove-store-package.json"), { force: true });

    const manifestPath = join(appRoot, "opengrove.app.json");
    let sourceManifest: OpenGroveAppManifest;
    try {
      sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OpenGroveAppManifest;
    } catch {
      throw new Error("app_release_source_manifest_required");
    }
    if (sourceManifest.id !== draft.appId) {
      throw new Error("app_release_draft_identity_mismatch");
    }
    const projectedManifest = mountedAppReleaseManifest(sourceManifest as unknown as JsonObject, {
      ...input.release,
      identity: {
        ...input.release.identity,
        packageKey,
      },
    });
    writeFileSync(manifestPath, `${JSON.stringify(projectedManifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    return {
      appRoot,
      packageKey,
      projectedManifest,
      dispose: () => rmSync(temporaryContainer, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryContainer, { recursive: true, force: true });
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
