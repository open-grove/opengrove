import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { assertAppReleaseEligibility } from "../app-builder/cli.js";
import { canonicalPortableRelativePath, portablePathCollisionKey } from "../app-builder/portable-path.js";
import type { MountedAppReleaseDraft } from "./app-release.js";
import { materializeAppReleaseDraftTree } from "./app-release-draft-tree.js";
import type { LocalAppDraftStore } from "./local-app-drafts.js";
import { appReleaseSourcePathExcluded } from "./app-release-source-exclusions.js";
import { compareUtf8Bytes } from "./utf8-byte-order.js";

const TAR_BLOCK_BYTES = 512;
const MAX_SOURCE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_APP_RELEASE_SOURCE_FILES = 5_000;

export interface AppReleaseSourceFile {
  path: string;
  sha256: string;
  size: number;
  mode: "100644" | "100755";
}

export interface AppReleaseSourceSnapshot {
  sha256: string;
  size: number;
  files: AppReleaseSourceFile[];
  bytes: Buffer;
}

export { canonicalAppReleasePackageKey } from "./app-release-draft-tree.js";

export function prepareAppReleaseSourceSnapshot(input: {
  draftStore: LocalAppDraftStore;
  localAppId: string;
  expectedDraftDigest: string;
  expectedDraftArchiveSha256: string;
  release: MountedAppReleaseDraft;
  packageKey?: string;
}): AppReleaseSourceSnapshot {
  const draftTree = materializeAppReleaseDraftTree(input);
  try {
    // Re-check only the product-level eligibility of the exact saved draft.
    // Builder owns the formal package plan and GitHub CI owns the only formal tgz.
    assertAppReleaseEligibility(draftTree.appRoot, {
      manifestOverride: draftTree.projectedManifest,
    });

    const workspacePath = normalizedRelativePath(
      draftTree.projectedManifest.ui?.workspace || draftTree.projectedManifest.workspace?.path || "workspace",
    );
    const files = collectSourceFiles(draftTree.appRoot, workspacePath);
    const tarBytes = writeCanonicalTar(
      files.map((file) => ({
        ...file,
        bytes: readFileSync(join(draftTree.appRoot, file.path)),
      })),
    );
    const bytes = gzipSync(tarBytes, { level: 9 });
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_SOURCE_SNAPSHOT_BYTES) {
      throw new Error("app_release_source_snapshot_too_large");
    }
    return {
      sha256: sha256(bytes),
      size: bytes.byteLength,
      files,
      bytes,
    };
  } finally {
    draftTree.dispose();
  }
}

function collectSourceFiles(root: string, workspacePath: string): AppReleaseSourceFile[] {
  const files: AppReleaseSourceFile[] = [];
  const portablePaths = new Map<string, string>();
  let totalBytes = 0;

  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      comparePath(left.name, right.name),
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (process.platform !== "win32" && relativePath.includes("\\")) {
        throw new Error(`app_release_source_path_invalid:${relativePath}`);
      }
      const path = normalizedRelativePath(relativePath);
      if (!path || appReleaseSourcePathExcluded(path, workspacePath)) continue;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`app_release_source_symlink:${path}`);
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`app_release_source_entry_type:${path}`);
      if (stat.size > MAX_SOURCE_FILE_BYTES) {
        throw new Error(`app_release_source_file_too_large:${path}`);
      }
      assertPortableSourcePath(path, portablePaths);
      const bytes = readFileSync(absolutePath);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES) {
        throw new Error("app_release_source_snapshot_too_large");
      }
      files.push({
        path,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        mode: stat.mode & 0o111 ? "100755" : "100644",
      });
      if (files.length > MAX_APP_RELEASE_SOURCE_FILES) {
        throw new Error("app_release_source_file_count_exceeded");
      }
    }
  };

  visit(root);
  files.sort((left, right) => comparePath(left.path, right.path));
  if (!files.some((file) => file.path === "opengrove.app.json")) {
    throw new Error("app_release_source_manifest_required");
  }
  return files;
}

function assertPortableSourcePath(path: string, paths: Map<string, string>): void {
  const canonical = canonicalPortableRelativePath(path);
  if (!canonical || canonical === "." || path.includes("\\") || canonical !== path) {
    throw new Error(`app_release_source_path_invalid:${path}`);
  }
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const spelling = segments.slice(0, index + 1).join("/");
    const key = portablePathCollisionKey(spelling);
    const existing = paths.get(key);
    if (existing && existing !== spelling) {
      throw new Error(`app_release_source_path_collision:${path}`);
    }
    paths.set(key, spelling);
  }
}

function writeCanonicalTar(files: Array<AppReleaseSourceFile & { bytes: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    if (file.bytes.byteLength !== file.size || sha256(file.bytes) !== file.sha256) {
      throw new Error(`app_release_source_file_changed:${file.path}`);
    }
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    const split = splitUstarPath(file.path);
    writeTarText(header, 0, 100, split.name);
    writeTarOctal(header, 100, 8, file.mode === "100755" ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, file.bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarText(header, 257, 6, "ustar\0");
    writeTarText(header, 263, 2, "00");
    writeTarOctal(header, 329, 8, 0);
    writeTarOctal(header, 337, 8, 0);
    if (split.prefix) writeTarText(header, 345, 155, split.prefix);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    writeTarText(header, 148, 6, checksumText);
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, file.bytes);
    const padding = (TAR_BLOCK_BYTES - (file.bytes.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(chunks);
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`app_release_source_path_too_long:${path}`);
}

function writeTarText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("app_release_source_tar_field_too_long");
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("app_release_source_tar_number_too_large");
  writeTarText(buffer, offset, length - 1, text);
  buffer[offset + length - 1] = 0;
}

function normalizedRelativePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function comparePath(left: string, right: string): number {
  return compareUtf8Bytes(left, right);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
