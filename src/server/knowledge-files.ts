import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { APP_PRODUCT_NAME, APP_PROTOCOL_ID, APP_VAULT_ROOT_NAME } from "../identity.js";
import type { BridgeState } from "./bridge-types.js";
import { KNOWLEDGE_FILE_SIZE_LIMIT, KNOWLEDGE_INVENTORY_LIMIT } from "./bridge-types.js";
import type { KnowledgeDocument } from "../knowledge/types.js";
import { syncImportedNativeFolders } from "./knowledge-imported-folders.js";
import { syncGlobalKernelKnowledgeDocumentsIfNeeded } from "./knowledge-native-sync.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { hostMessage } from "../localization/host-messages.js";
import type {
  KnowledgeFilePatchPayload,
  KnowledgeFileSystemCreatePayload,
  KnowledgeFileSystemDeletePayload,
  KnowledgeFileSystemMovePayload,
  KnowledgeFileSystemRenamePayload,
} from "./knowledge-payloads.js";
import {
  ensureMarkdownFileName,
  inferKnowledgeFileFormat,
  isPathInsideRoot,
  joinVaultPath,
  parentVaultPaths,
  relativeVaultPath,
  rootVaultPath,
  safePathSegment,
  safeVaultPath,
  shouldIgnoreVaultDirectory,
  uniqueDirectoryPath,
  uniqueFilePath,
  vaultPathContains,
} from "./knowledge-path-utils.js";
import {
  ensureKnowledgeVaultRoot,
  knowledgeVaultRoot,
  knowledgeWritableRootSpecs,
  scanKnowledgeFolderRoot,
} from "./knowledge-roots.js";
import { kernelIdForVaultPath, sourceIdForVaultPath } from "./knowledge-source-ids.js";

export { importLocalFolderToKnowledge } from "./knowledge-imported-folders.js";
export {
  ensureKnowledgeVaultRoot,
  knowledgeVaultRoot,
  knowledgeWritableRootSpecs,
  scanKnowledgeFolderRoot,
} from "./knowledge-roots.js";
export type { KnowledgeWritableRootSpec } from "./knowledge-roots.js";
export {
  normalizeKnowledgeFilePatchPayload,
  normalizeKnowledgeFileSystemCreatePayload,
  normalizeKnowledgeFileSystemDeletePayload,
  normalizeKnowledgeFileSystemImportFolderPayload,
  normalizeKnowledgeFileSystemMovePayload,
  normalizeKnowledgeFileSystemRenamePayload,
} from "./knowledge-payloads.js";
export type {
  KnowledgeFilePatchPayload,
  KnowledgeFileSystemCreatePayload,
  KnowledgeFileSystemDeletePayload,
  KnowledgeFileSystemImportFolderPayload,
  KnowledgeFileSystemMovePayload,
  KnowledgeFileSystemRenamePayload,
} from "./knowledge-payloads.js";
export {
  inferKnowledgeFileFormat,
  isPathInsideRoot,
  isVisibleKnowledgeFileName,
  safeIdSegment,
  safePathSegment,
  safeVaultPath,
  shortHash,
  shouldIgnoreVaultDirectory,
  vaultPathContains,
} from "./knowledge-path-utils.js";

export interface KnowledgeFileDescriptor {
  path: string;
  vaultPath: string;
  backing: "vault" | "native";
  format: "markdown" | "json" | "plain";
  originPath?: string;
}

export interface KnowledgeVaultFolder {
  path: string;
  backing: "vault" | "native";
  originPath?: string;
}

interface KnowledgeDirectoryTarget {
  path: string;
  vaultPath: string;
  backing: "vault" | "native";
  originPath?: string;
}

export function readKnowledgeFile(state: BridgeState, knowledgeId: string) {
  const document = requireKnowledgeDocument(state, knowledgeId);
  const descriptor = resolveKnowledgeFileDescriptor(document);
  ensureKnowledgeFileExists(document, descriptor);
  return {
    document,
    file: readKnowledgeFileSnapshot(descriptor),
  };
}

export function syncKnowledgeVaultFiles(state: BridgeState): void {
  ensureKnowledgeVaultRoot();
  syncGlobalKernelKnowledgeDocumentsIfNeeded(state);
  syncImportedNativeFolders(state);
  for (const document of listKnowledgeInventoryDocuments(state)) {
    try {
      const descriptor = resolveKnowledgeFileDescriptor(document);
      ensureKnowledgeFileExists(document, descriptor);
    } catch {
      // A broken source file should not make inventory unreadable.
    }
  }
}

export function listKnowledgeVaultFolders(state: BridgeState): KnowledgeVaultFolder[] {
  ensureKnowledgeVaultRoot();
  const folders = new Map<string, KnowledgeVaultFolder>();
  const addFolder = (folder: KnowledgeVaultFolder) => {
    const safePath = safeVaultPath(folder.path);
    if (!safePath) return;
    const existing = folders.get(safePath);
    if (existing && existing.backing === "native" && folder.backing === "vault") return;
    folders.set(safePath, {
      path: safePath,
      backing: folder.backing,
      originPath: folder.originPath,
    });
  };

  for (const root of knowledgeWritableRootSpecs(state)) {
    if (root.backing === "vault") {
      scanKnowledgeFolderRoot(root, addFolder);
    } else {
      addFolder({
        path: root.vaultPath,
        backing: "native",
        originPath: root.originPath ?? root.path,
      });
    }
  }

  // Also scan vault root for user-created subdirectories
  const vaultRoot = knowledgeVaultRoot();
  try {
    for (const entry of readdirSync(vaultRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || shouldIgnoreVaultDirectory(entry.name)) continue;
      if (PROTECTED_VAULT_ROOTS.has(entry.name)) continue;
      if (folders.has(entry.name)) continue;
      addFolder({ path: entry.name, backing: "vault" });
    }
  } catch {
    // non-critical-fallback: A failed optional vault scan contributes no folders.
  }

  for (const document of listKnowledgeInventoryDocuments(state)) {
    try {
      const descriptor = resolveKnowledgeFileDescriptor(document);
      const vaultPath = knowledgeVaultPath(document);
      for (const parentPath of parentVaultPaths(vaultPath)) {
        addFolder({
          path: parentPath,
          backing: descriptor.backing,
          originPath: descriptor.originPath
            ? resolvePhysicalParentFromVaultPath(descriptor.path, vaultPath, parentPath)
            : undefined,
        });
      }
    } catch {
      // Folder listing should stay best-effort when a source file is broken.
    }
  }

  return [...folders.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
}

export function createKnowledgeFileSystemEntry(state: BridgeState, payload: KnowledgeFileSystemCreatePayload) {
  const language = resolveHostLanguageSettings(state.settings);
  ensureKnowledgeVaultRoot();
  const parentPath = payload.parentPath === "" ? "" : safeVaultPath(payload.parentPath) || APP_VAULT_ROOT_NAME;
  const target =
    parentPath === ""
      ? { vaultPath: "", path: knowledgeVaultRoot(), backing: "vault" as const }
      : resolveKnowledgeDirectoryTarget(state, parentPath);
  mkdirSync(target.path, { recursive: true });

  if (payload.kind === "folder") {
    const folderName = safePathSegment(payload.name || hostMessage(language, "workspace.new_folder"));
    const folderPath = uniqueDirectoryPath(target.path, folderName);
    mkdirSync(folderPath, { recursive: true });
    return {
      entry: {
        kind: "folder",
        path: joinVaultPath(target.vaultPath, basename(folderPath)),
        backing: target.backing,
        originPath: target.backing === "native" ? folderPath : undefined,
      },
      knowledge: listKnowledgeInventoryDocuments(state),
      knowledgeFolders: listKnowledgeVaultFolders(state),
    };
  }

  const noteName = ensureMarkdownFileName(
    safePathSegment(payload.name || hostMessage(language, "workspace.untitled_note")),
  );
  const filePath = uniqueFilePath(target.path, noteName);
  const vaultPath = joinVaultPath(target.vaultPath, basename(filePath));
  const content = payload.content ?? "";
  writeFileSync(filePath, content, "utf8");
  const title = basename(filePath).replace(/\.(?:md|markdown|mdx)$/i, "");
  const document = state.app.knowledge.create({
    type: "note",
    title,
    body: content,
    format: "markdown",
    tags: [],
    scope: target.backing === "native" ? "user" : "project",
    lifecycle: "active",
    sourceRefs: [{ title, locator: filePath }],
    metadata: {
      vaultPath,
      kernelId: kernelIdForVaultPath(vaultPath),
      sourceId: sourceIdForVaultPath(vaultPath),
      sourceFilePath: filePath,
      sourceFileBacking: target.backing,
      sourceFileOriginPath: target.backing === "native" ? filePath : "",
      nativeGlobalKnowledge: target.backing === "native",
      createdBy: "opengrove.file-system",
    },
  });

  return {
    entry: {
      kind: "note",
      path: vaultPath,
      backing: target.backing,
      originPath: target.backing === "native" ? filePath : undefined,
    },
    document,
    file: readKnowledgeFileSnapshot({
      path: filePath,
      vaultPath,
      backing: target.backing,
      originPath: target.backing === "native" ? filePath : undefined,
      format: "markdown",
    }),
    knowledge: listKnowledgeInventoryDocuments(state),
    knowledgeFolders: listKnowledgeVaultFolders(state),
    knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
  };
}

export function moveKnowledgeFileSystemEntry(state: BridgeState, payload: KnowledgeFileSystemMovePayload) {
  ensureKnowledgeVaultRoot();
  const sourcePath = safeVaultPath(payload.sourcePath);
  const targetParentPath = safeVaultPath(payload.targetParentPath) || APP_VAULT_ROOT_NAME;
  if (!sourcePath) {
    throw new Error("knowledge_file_source_path_required");
  }
  if (sourcePath.split("/").length < 2) {
    throw new Error("knowledge_file_root_move_not_allowed");
  }
  if (rootVaultPath(sourcePath) !== rootVaultPath(targetParentPath)) {
    throw new Error("knowledge_file_cross_root_move_not_supported");
  }
  if (sourcePath === targetParentPath || vaultPathContains(targetParentPath, sourcePath)) {
    throw new Error("knowledge_file_move_into_self_not_allowed");
  }

  const source = resolveKnowledgeDirectoryTarget(state, sourcePath);
  const target = resolveKnowledgeDirectoryTarget(state, targetParentPath);
  if (!existsSync(source.path)) {
    throw new Error("knowledge_file_source_not_found");
  }
  mkdirSync(target.path, { recursive: true });
  const sourceStat = statSync(source.path);
  const sourceName = basename(source.path);
  const currentParent = dirname(source.path);
  if (resolve(currentParent) === resolve(target.path)) {
    return {
      entry: {
        kind: sourceStat.isDirectory() ? "folder" : "note",
        path: sourcePath,
        backing: source.backing,
        originPath: source.backing === "native" ? source.path : undefined,
      },
      knowledge: listKnowledgeInventoryDocuments(state),
      knowledgeFolders: listKnowledgeVaultFolders(state),
      knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
    };
  }

  const destinationPath = sourceStat.isDirectory()
    ? uniqueDirectoryPath(target.path, sourceName)
    : uniqueFilePath(target.path, sourceName);
  const destinationVaultPath = joinVaultPath(target.vaultPath, basename(destinationPath));
  renameSync(source.path, destinationPath);
  updateKnowledgeDocumentPathsAfterMove(state, {
    sourceVaultPath: sourcePath,
    destinationVaultPath,
    sourcePath: source.path,
    destinationPath,
  });

  return {
    entry: {
      kind: sourceStat.isDirectory() ? "folder" : "note",
      path: destinationVaultPath,
      backing: target.backing,
      originPath: target.backing === "native" ? destinationPath : undefined,
    },
    knowledge: listKnowledgeInventoryDocuments(state),
    knowledgeFolders: listKnowledgeVaultFolders(state),
    knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
  };
}

export function renameKnowledgeFileSystemEntry(state: BridgeState, payload: KnowledgeFileSystemRenamePayload) {
  ensureKnowledgeVaultRoot();
  const sourcePath = safeVaultPath(payload.sourcePath);
  if (!sourcePath) {
    throw new Error("knowledge_file_source_path_required");
  }
  if (sourcePath.split("/").length < 2) {
    throw new Error("knowledge_file_root_rename_not_allowed");
  }
  const source = resolveKnowledgeDirectoryTarget(state, sourcePath);
  if (!existsSync(source.path)) {
    throw new Error("knowledge_file_source_not_found");
  }
  const sourceStat = statSync(source.path);
  const requestedName = safePathSegment(payload.name || basename(source.path));
  const nextName = sourceStat.isDirectory() ? requestedName : ensureMarkdownFileName(requestedName);
  const parentPath = dirname(source.path);
  const destinationPath = sourceStat.isDirectory()
    ? uniqueDirectoryPath(parentPath, nextName)
    : uniqueFilePath(parentPath, nextName);
  const parentVaultPath = sourcePath.split("/").slice(0, -1).join("/");
  const destinationVaultPath = joinVaultPath(parentVaultPath, basename(destinationPath));
  if (resolve(source.path) !== resolve(destinationPath)) {
    renameSync(source.path, destinationPath);
  }
  updateKnowledgeDocumentPathsAfterMove(state, {
    sourceVaultPath: sourcePath,
    destinationVaultPath,
    sourcePath: source.path,
    destinationPath,
  });
  updateKnowledgeDocumentTitlesAfterRename(state, {
    sourceVaultPath: sourcePath,
    destinationVaultPath,
    destinationPath,
  });
  return {
    entry: {
      kind: sourceStat.isDirectory() ? "folder" : "note",
      path: destinationVaultPath,
      backing: source.backing,
      originPath: source.backing === "native" ? destinationPath : undefined,
    },
    knowledge: listKnowledgeInventoryDocuments(state),
    knowledgeFolders: listKnowledgeVaultFolders(state),
    knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
  };
}

export function deleteKnowledgeFileSystemEntry(state: BridgeState, payload: KnowledgeFileSystemDeletePayload) {
  ensureKnowledgeVaultRoot();
  const sourcePath = safeVaultPath(payload.sourcePath);
  if (!sourcePath) {
    throw new Error("knowledge_file_source_path_required");
  }
  const segments = sourcePath.split("/");
  if (segments.length < 2 && isProtectedVaultRoot(segments[0] ?? "")) {
    throw new Error("knowledge_file_root_delete_not_allowed");
  }
  const source = resolveKnowledgeDirectoryTarget(state, sourcePath);

  let entryKind: "folder" | "note" = "note";
  if (existsSync(source.path)) {
    const sourceStat = statSync(source.path);
    entryKind = sourceStat.isDirectory() ? "folder" : "note";
    // Only delete actual files for vault-backed entries (managed by the app).
    // Native-backed files must NEVER be deleted from disk — only unregistered.
    if (source.backing === "vault") {
      rmSync(source.path, { recursive: sourceStat.isDirectory(), force: true });
    }
  }

  const deletedKnowledgeIds = deleteKnowledgeDocumentsUnderVaultPath(state, sourcePath);
  return {
    entry: {
      kind: entryKind,
      path: sourcePath,
      backing: source.backing,
      originPath: source.backing === "native" ? source.path : undefined,
    },
    deletedKnowledgeIds,
    knowledge: listKnowledgeInventoryDocuments(state),
    knowledgeFolders: listKnowledgeVaultFolders(state),
    knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
  };
}

export function filterPrimaryKnowledgeDocuments(documents: KnowledgeDocument[]): KnowledgeDocument[] {
  return documents.filter(isPrimaryLibraryDocument);
}

export function listKnowledgeInventoryDocuments(
  state: BridgeState,
  limit = KNOWLEDGE_INVENTORY_LIMIT,
): KnowledgeDocument[] {
  const documents = filterPrimaryKnowledgeDocuments(state.app.knowledge.list({ lifecycle: "active" })).sort(
    compareKnowledgeInventoryDocuments,
  );
  return Number.isFinite(limit) && limit > 0 ? documents.slice(0, limit) : documents;
}

function compareKnowledgeInventoryDocuments(left: KnowledgeDocument, right: KnowledgeDocument): number {
  return (
    knowledgeInventoryPriority(left) - knowledgeInventoryPriority(right) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.title.localeCompare(right.title, "zh-CN")
  );
}

function knowledgeInventoryPriority(document: KnowledgeDocument): number {
  const metadata = document.metadata ?? {};
  if (safeVaultPath(metadata.vaultPath) || metadata.nativeGlobalKnowledge === true) return 0;
  if (document.type === "memory" || document.type === "artifact_ref") return 1;
  if (document.type === "skill" || metadata.parentSkillId) return 2;
  return 3;
}

export function writeKnowledgeFile(state: BridgeState, knowledgeId: string, payload: KnowledgeFilePatchPayload) {
  const document = requireKnowledgeDocument(state, knowledgeId);
  const descriptor = resolveKnowledgeFileDescriptor(document);
  ensureKnowledgeFileParent(document, descriptor.path);
  if (
    !isPathInsideRoot(descriptor.path, knowledgeVaultRoot()) &&
    !isAllowedKnowledgeSourcePath(document, descriptor.path)
  ) {
    throw new Error("knowledge_file_path_not_allowed");
  }
  writeFileSync(descriptor.path, payload.content, "utf8");

  const nextMetadata = {
    ...(document.metadata ?? {}),
    sourceFilePath: descriptor.path,
    sourceFileBacking: descriptor.backing,
    sourceFileOriginPath: descriptor.originPath ?? "",
    sourceFileSyncedAt: new Date().toISOString(),
  };
  const updated = state.app.knowledge.update(knowledgeId, {
    title: payload.title?.trim() || document.title,
    body: payload.content,
    format: descriptor.format,
    tags: payload.tags ?? document.tags,
    sourceRefs: upsertKnowledgeFileSourceRef(
      document.sourceRefs,
      descriptor.path,
      payload.title?.trim() || document.title,
    ),
    metadata: nextMetadata,
  });
  return {
    document: updated,
    file: readKnowledgeFileSnapshot(descriptor),
  };
}

export function requireKnowledgeDocument(state: BridgeState, knowledgeId: string): KnowledgeDocument {
  const document = state.app.knowledge.get(knowledgeId);
  if (!document) {
    throw new Error(`knowledge_document_not_found:${knowledgeId}`);
  }
  return document;
}

export function resolveKnowledgeFileDescriptor(document: KnowledgeDocument): KnowledgeFileDescriptor {
  const vaultPath = knowledgeVaultPath(document);
  const metadata = document.metadata ?? {};
  const declaredNativePath =
    typeof metadata.sourceFilePath === "string" ? normalizeKnowledgeLocalPath(metadata.sourceFilePath) : undefined;
  if (metadata.sourceFileBacking === "native" && declaredNativePath) {
    return {
      path: declaredNativePath,
      vaultPath,
      backing: "native",
      format: inferKnowledgeFileFormat(declaredNativePath),
      originPath: declaredNativePath,
    };
  }
  const originPath = resolveNativeKnowledgeFilePath(document);
  return {
    path: originPath ?? resolve(knowledgeVaultRoot(), vaultPath),
    vaultPath,
    backing: originPath ? "native" : "vault",
    format: inferKnowledgeFileFormat(originPath || vaultPath),
    originPath,
  };
}

export function resolveKnowledgeVaultFilePath(vaultPath: string, state?: BridgeState): string | undefined {
  const safePath = safeVaultPath(vaultPath);
  if (!safePath) return undefined;
  const specs = knowledgeWritableRootSpecs(state)
    .filter((spec) => vaultPathContains(safePath, spec.vaultPath))
    .sort((left, right) => right.vaultPath.length - left.vaultPath.length);
  const matched = specs[0];
  if (matched) {
    const relativePath = relativeVaultPath(matched.vaultPath, safePath);
    return resolve(matched.path, ...relativePath.split("/").filter(Boolean));
  }
  return resolve(knowledgeVaultRoot(), safePath);
}

export function knowledgeVaultPath(document: KnowledgeDocument): string {
  const metadata = document.metadata ?? {};
  const explicitVaultPath = safeVaultPath(metadata.vaultPath);
  if (explicitVaultPath) {
    return explicitVaultPath;
  }
  const sourceRoot = knowledgeSourceRoot(document);
  if (metadata.parentSkillId && typeof metadata.skillFilePath === "string") {
    return [
      sourceRoot,
      "skills",
      safePathSegment(String(metadata.skillName || metadata.skillId || "skill")),
      ...metadata.skillFilePath.split(/[\\/]/).map((part) => safePathSegment(part)),
    ].join("/");
  }
  if (document.type === "skill") {
    return `${sourceRoot}/skills/${safePathSegment(String(metadata.skillName || document.slug || document.id))}/SKILL.md`;
  }
  if (needsKnowledgeReviewForFile(document)) {
    return `${sourceRoot}/inbox/${knowledgeFileName(document)}`;
  }
  if (document.type === "memory") {
    return `${sourceRoot}/memories/${knowledgeFileName(document)}`;
  }
  if (document.type === "artifact_ref") {
    return `${sourceRoot}/artifacts/${knowledgeFileName(document)}`;
  }
  if (document.type === "project_doc") {
    return `${sourceRoot}/projects/${knowledgeFileName(document)}`;
  }
  if (document.type === "profile") {
    return `${sourceRoot}/profiles/${knowledgeFileName(document)}`;
  }
  if (document.type === "routine") {
    return `${sourceRoot}/routines/${knowledgeFileName(document)}`;
  }
  if (document.type === "source") {
    return `${sourceRoot}/sources/${knowledgeFileName(document)}`;
  }
  return `${sourceRoot}/notes/${knowledgeFileName(document)}`;
}

function knowledgeSourceRoot(document: KnowledgeDocument): string {
  const metadata = document.metadata ?? {};
  const explicit = stringValue(metadata.kernelId) || stringValue(metadata.kernel) || stringValue(metadata.sourceKernel);
  if (explicit) {
    return normalizeKnowledgeSourceRoot(explicit);
  }
  const haystack = [
    stringValue(metadata.skillRoot),
    stringValue(metadata.entry),
    stringValue(metadata.sourceFilePath),
    stringValue(metadata.sourceFileOriginPath),
    ...(document.sourceRefs ?? []).map((ref) => ref.locator || ""),
  ]
    .join("\n")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (haystack.includes("/.claude/") || haystack.includes("/claude.md")) return "Claude";
  if (haystack.includes("/.hermes/")) return "Hermes";
  if (haystack.includes("/.codex/") || haystack.includes("/.agents/skills/")) return "Codex";
  return APP_VAULT_ROOT_NAME;
}

function normalizeKnowledgeSourceRoot(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude-code" || normalized === "claude code") return "Claude";
  if (normalized === "codex") return "Codex";
  if (normalized === "hermes") return "Hermes";
  if (normalized === APP_PROTOCOL_ID || normalized === APP_PRODUCT_NAME.toLowerCase()) {
    return APP_VAULT_ROOT_NAME;
  }
  return APP_VAULT_ROOT_NAME;
}

function isPrimaryLibraryDocument(document: KnowledgeDocument): boolean {
  const metadata = document.metadata ?? {};
  if (metadata.nativeGlobalKnowledge === true || safeVaultPath(metadata.vaultPath)) {
    return true;
  }
  const root = knowledgeSourceRoot(document);
  const source = stringValue(metadata.source);
  const isSkillChild = Boolean(metadata.parentSkillId && typeof metadata.skillFilePath === "string");
  if (root === "OpenGrove") {
    if (document.type === "memory" || document.type === "artifact_ref") return true;
    if ((document.type === "skill" || (document.type === "source" && isSkillChild)) && source !== "project")
      return true;
    return false;
  }
  if (root === "Codex" || root === "Claude" || root === "Hermes") {
    return document.type === "skill" && source === "user";
  }
  return false;
}

function resolveKnowledgeDirectoryTarget(state: BridgeState, parentPath: string): KnowledgeDirectoryTarget {
  const safeParent = safeVaultPath(parentPath) || APP_VAULT_ROOT_NAME;
  const specs = knowledgeWritableRootSpecs(state)
    .filter((spec) => vaultPathContains(safeParent, spec.vaultPath))
    .sort((left, right) => right.vaultPath.length - left.vaultPath.length);
  const matched = specs[0];
  if (matched) {
    const relativePath = relativeVaultPath(matched.vaultPath, safeParent);
    return {
      vaultPath: safeParent,
      path: resolve(matched.path, ...relativePath.split("/").filter(Boolean)),
      backing: matched.backing,
      originPath:
        matched.backing === "native" ? resolve(matched.path, ...relativePath.split("/").filter(Boolean)) : undefined,
    };
  }
  return {
    vaultPath: safeParent,
    path: resolve(knowledgeVaultRoot(), safeParent),
    backing: "vault",
  };
}

function resolvePhysicalParentFromVaultPath(
  filePath: string,
  fileVaultPath: string,
  parentVaultPath: string,
): string | undefined {
  if (!vaultPathContains(fileVaultPath, parentVaultPath)) return undefined;
  const remainderSegments = relativeVaultPath(parentVaultPath, fileVaultPath).split("/").filter(Boolean);
  let parent = resolve(filePath);
  for (let index = 0; index < remainderSegments.length; index += 1) {
    parent = dirname(parent);
  }
  return parent;
}

function updateKnowledgeDocumentPathsAfterMove(
  state: BridgeState,
  input: {
    sourceVaultPath: string;
    destinationVaultPath: string;
    sourcePath: string;
    destinationPath: string;
  },
): void {
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const currentVaultPath = safeVaultPath(document.metadata?.vaultPath);
    if (!currentVaultPath || !vaultPathContains(currentVaultPath, input.sourceVaultPath)) continue;
    const nextVaultPath = replaceVaultPathPrefix(currentVaultPath, input.sourceVaultPath, input.destinationVaultPath);
    const nextMetadata = replaceMetadataPathPrefixes(document.metadata ?? {}, input.sourcePath, input.destinationPath);
    state.app.knowledge.update(document.id, {
      metadata: {
        ...nextMetadata,
        vaultPath: nextVaultPath,
        sourceFileSyncedAt: new Date().toISOString(),
      },
      sourceRefs: (document.sourceRefs ?? []).map((ref) => ({
        ...ref,
        locator: replaceLocatorPathPrefix(ref.locator, input.sourcePath, input.destinationPath),
      })),
    });
  }
}

function updateKnowledgeDocumentTitlesAfterRename(
  state: BridgeState,
  input: {
    sourceVaultPath: string;
    destinationVaultPath: string;
    destinationPath: string;
  },
): void {
  const isSingleFileRename = !input.sourceVaultPath.endsWith("/") && extname(input.destinationPath);
  if (!isSingleFileRename) return;
  const nextTitle = basename(input.destinationPath).replace(/\.(?:md|markdown|mdx|txt)$/i, "");
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const currentVaultPath = safeVaultPath(document.metadata?.vaultPath);
    if (currentVaultPath !== input.destinationVaultPath) continue;
    state.app.knowledge.update(document.id, {
      title: nextTitle,
      sourceRefs: upsertKnowledgeFileSourceRef(document.sourceRefs, input.destinationPath, nextTitle),
    });
  }
}

function deleteKnowledgeDocumentsUnderVaultPath(state: BridgeState, sourceVaultPath: string): string[] {
  const deletedIds: string[] = [];
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const currentVaultPath = safeVaultPath(document.metadata?.vaultPath);
    if (!currentVaultPath || !vaultPathContains(currentVaultPath, sourceVaultPath)) continue;
    if (state.app.knowledge.delete(document.id)) {
      deletedIds.push(document.id);
    }
  }
  return deletedIds;
}

function replaceVaultPathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix;
  return joinVaultPath(newPrefix, relativeVaultPath(oldPrefix, path));
}

function replaceMetadataPathPrefixes(
  metadata: Record<string, unknown>,
  oldPrefix: string,
  newPrefix: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  for (const key of ["sourceFilePath", "sourceFileOriginPath", "skillRoot", "entry"]) {
    const value = metadata[key];
    if (typeof value === "string") {
      next[key] = replaceLocalPathPrefix(value, oldPrefix, newPrefix);
    }
  }
  return next;
}

function replaceLocatorPathPrefix(
  locator: string | undefined,
  oldPrefix: string,
  newPrefix: string,
): string | undefined {
  if (!locator) return locator;
  return replaceLocalPathPrefix(locator, oldPrefix, newPrefix);
}

function replaceLocalPathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  const localPath = normalizeKnowledgeLocalPath(path);
  if (!localPath || !isPathInsideRoot(localPath, oldPrefix)) return path;
  return resolve(newPrefix, relative(resolve(oldPrefix), localPath));
}

function resolveNativeKnowledgeFilePath(document: KnowledgeDocument): string | undefined {
  const metadata = document.metadata ?? {};
  const candidates: string[] = [];
  const skillRoot = typeof metadata.skillRoot === "string" ? metadata.skillRoot : "";
  const skillFilePath = typeof metadata.skillFilePath === "string" ? metadata.skillFilePath : "";
  if (skillRoot && skillFilePath) {
    candidates.push(resolve(skillRoot, skillFilePath));
  }
  if (typeof metadata.entry === "string") {
    candidates.push(metadata.entry);
  }
  if (typeof metadata.sourceFilePath === "string") {
    candidates.push(metadata.sourceFilePath);
  }
  for (const ref of document.sourceRefs ?? []) {
    if (ref.locator) {
      candidates.push(ref.locator);
    }
  }

  for (const candidate of candidates) {
    const path = normalizeKnowledgeLocalPath(candidate);
    if (!path || !existsSync(path) || !isAllowedKnowledgeSourcePath(document, path)) continue;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      // non-critical-fallback: A disappearing candidate is skipped while the resolver tries remaining declared paths.
      continue;
    }
    return path;
  }

  return undefined;
}

function normalizeKnowledgeLocalPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    if (!trimmed.startsWith("file://")) return undefined;
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  return resolve(process.cwd(), trimmed);
}

function isAllowedKnowledgeSourcePath(document: KnowledgeDocument, filePath: string): boolean {
  const metadata = document.metadata ?? {};
  const roots = [process.cwd(), homedir(), typeof metadata.skillRoot === "string" ? metadata.skillRoot : ""].filter(
    Boolean,
  );
  return roots.some((root) => isPathInsideRoot(filePath, root));
}

function ensureKnowledgeFileExists(document: KnowledgeDocument, descriptor: KnowledgeFileDescriptor): void {
  if (!existsSync(descriptor.path)) {
    if (descriptor.backing === "native") {
      throw new Error("knowledge_file_source_not_found");
    }
    ensureKnowledgeFileParent(document, descriptor.path);
    const seedContent =
      descriptor.originPath && existsSync(descriptor.originPath)
        ? readFileSync(descriptor.originPath, "utf8")
        : knowledgeDocumentToMarkdownFile(document);
    writeFileSync(descriptor.path, seedContent, "utf8");
  } else {
    repairStaleManagedKnowledgeFile(document, descriptor);
  }
  const stat = statSync(descriptor.path);
  if (!stat.isFile()) {
    throw new Error("knowledge_file_not_a_file");
  }
  if (stat.size > KNOWLEDGE_FILE_SIZE_LIMIT) {
    throw new Error("knowledge_file_too_large");
  }
}

function repairStaleManagedKnowledgeFile(document: KnowledgeDocument, descriptor: KnowledgeFileDescriptor): void {
  if (document.type !== "artifact_ref" || descriptor.format !== "markdown") return;
  const content = readFileSync(descriptor.path, "utf8");
  const trimmed = content.trim();
  const titleOnly = Boolean(document.title && trimmed === document.title.trim());
  const missingArtifactData = document.body.includes("Data:") && !trimmed.includes("Data:") && trimmed.length < 240;
  const missingArtifactImage = document.body.includes("![") && !trimmed.includes("![") && trimmed.length < 1_200;
  if (!titleOnly && !missingArtifactData && !missingArtifactImage) return;
  writeFileSync(descriptor.path, knowledgeDocumentToMarkdownFile(document), "utf8");
}

function ensureKnowledgeFileParent(document: KnowledgeDocument, filePath: string): void {
  const parent = dirname(filePath);
  const root = knowledgeVaultRoot();
  if (!isPathInsideRoot(filePath, root) && !isAllowedKnowledgeSourcePath(document, filePath)) {
    throw new Error("knowledge_file_path_not_allowed");
  }
  mkdirSync(parent, { recursive: true });
}

function readKnowledgeFileSnapshot(descriptor: KnowledgeFileDescriptor) {
  const stat = statSync(descriptor.path);
  if (stat.size > KNOWLEDGE_FILE_SIZE_LIMIT) {
    throw new Error("knowledge_file_too_large");
  }
  return {
    path: descriptor.path,
    uri: pathToFileURL(descriptor.path).href,
    vaultPath: descriptor.vaultPath,
    backing: descriptor.backing,
    originPath: descriptor.originPath,
    format: descriptor.format,
    size: stat.size,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    content: readFileSync(descriptor.path, "utf8"),
  };
}

function upsertKnowledgeFileSourceRef(
  refs: KnowledgeDocument["sourceRefs"],
  filePath: string,
  title: string,
): KnowledgeDocument["sourceRefs"] {
  const normalized = resolve(filePath);
  return [
    { title, locator: normalized },
    ...(refs ?? []).filter((ref) => {
      if (!ref.locator) return true;
      const refPath = normalizeKnowledgeLocalPath(ref.locator);
      return !refPath || resolve(refPath) !== normalized;
    }),
  ];
}

function knowledgeFileName(document: KnowledgeDocument): string {
  const base = safePathSegment(document.slug || document.title || document.id);
  const extension = document.format === "json" ? ".json" : ".md";
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

function knowledgeDocumentToMarkdownFile(document: KnowledgeDocument): string {
  if (document.format === "markdown" && document.body.trimStart().startsWith("---\n")) {
    return document.body.endsWith("\n") ? document.body : `${document.body}\n`;
  }
  const tags = document.tags.length ? ["tags:", ...document.tags.map((tag) => `  - ${yamlScalar(tag)}`)] : ["tags: []"];
  const header = [
    "---",
    `title: ${yamlScalar(document.title || document.id)}`,
    `type: ${yamlScalar(document.type)}`,
    `status: ${yamlScalar(document.lifecycle)}`,
    ...tags,
    "---",
  ].join("\n");
  const body = document.body.trim();
  return `${header}\n\n${body}${body ? "\n" : ""}`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function needsKnowledgeReviewForFile(document: KnowledgeDocument): boolean {
  if (document.lifecycle && document.lifecycle !== "active") return true;
  if (document.type === "source" && document.metadata?.organizerRole === "raw_evidence") return true;
  if (typeof document.confidence === "number" && document.confidence < 0.55) return true;
  return false;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const PROTECTED_VAULT_ROOTS = new Set(["OpenGrove", "Codex", "Claude", "Hermes"]);

export function isProtectedVaultRoot(name: string): boolean {
  return PROTECTED_VAULT_ROOTS.has(name);
}
