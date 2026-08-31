import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";
import { APP_PROTOCOL_ID } from "../identity.js";
import type { BridgeState } from "./bridge-types.js";
import { KNOWLEDGE_FILE_SIZE_LIMIT } from "./bridge-types.js";
import type { KnowledgeFileSystemImportFolderPayload, KnowledgeWritableRootSpec } from "./knowledge-files.js";
import {
  PROTECTED_VAULT_ROOTS,
  ensureKnowledgeVaultRoot,
  knowledgeVaultRoot,
  knowledgeWritableRootSpecs,
  listKnowledgeInventoryDocuments,
  listKnowledgeVaultFolders,
} from "./knowledge-files.js";
import {
  inferKnowledgeFileFormat,
  isPathInsideRoot,
  isVisibleKnowledgeFileName,
  safePathSegment,
  safeVaultPath,
  shortHash,
  shouldIgnoreVaultDirectory,
  vaultPathContains,
} from "./knowledge-path-utils.js";

const IMPORTED_FOLDER_WATCH_DEBOUNCE_MS = 450;
const IMPORTED_FOLDER_FALLBACK_POLL_MS = 5_000;
interface ImportedFolderWatcher {
  watcher?: FSWatcher;
  state: BridgeState;
  spec: KnowledgeWritableRootSpec;
  timer?: ReturnType<typeof setTimeout>;
  poller?: ReturnType<typeof setInterval>;
}

const importedFolderWatchers = new Map<string, ImportedFolderWatcher>();
const dirtyImportedFolderRoots = new Set<string>();

export function closeImportedNativeFolderWatchers(state: BridgeState): void {
  for (const [key, entry] of importedFolderWatchers) {
    if (entry.state !== state) continue;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.poller) clearInterval(entry.poller);
    entry.watcher?.close();
    importedFolderWatchers.delete(key);
    dirtyImportedFolderRoots.delete(key);
  }
}

export function isProtectedVaultRoot(name: string): boolean {
  return PROTECTED_VAULT_ROOTS.has(name);
}

export function syncImportedNativeFolders(state: BridgeState): void {
  const specs = importedNativeRootSpecs(state);
  ensureImportedNativeFolderWatchers(state, specs);
  let changed = false;
  for (const spec of specs) {
    const key = importedFolderWatcherKey(spec);
    if (importedFolderWatchers.get(key)?.timer) continue;
    if (!dirtyImportedFolderRoots.delete(key)) continue;
    if (!isReadableDirectory(spec.path)) continue;
    if (syncImportedNativeFolderRoot(state, spec.path, spec.vaultPath)) {
      changed = true;
    }
  }
  if (changed) {
    state.store.saveFrom(state.app);
  }
}

function importedNativeRootSpecs(state: BridgeState): KnowledgeWritableRootSpec[] {
  return knowledgeWritableRootSpecs(state).filter(
    (spec) => spec.backing === "native" && Boolean(spec.originPath) && !PROTECTED_VAULT_ROOTS.has(spec.vaultPath),
  );
}

function ensureImportedNativeFolderWatchers(state: BridgeState, specs: KnowledgeWritableRootSpec[]): void {
  const nextKeys = new Set<string>();
  for (const spec of specs) {
    if (!isReadableDirectory(spec.path)) continue;
    const key = importedFolderWatcherKey(spec);
    nextKeys.add(key);
    const existing = importedFolderWatchers.get(key);
    if (existing) {
      existing.state = state;
      existing.spec = spec;
      continue;
    }
    try {
      const watcher = watch(spec.path, { recursive: true }, () => {
        scheduleImportedFolderSync(key);
      });
      importedFolderWatchers.set(key, { watcher, state, spec });
      scheduleImportedFolderSync(key);
    } catch {
      try {
        const watcher = watch(spec.path, () => {
          scheduleImportedFolderSync(key);
        });
        const poller = setInterval(() => {
          scheduleImportedFolderSync(key);
        }, IMPORTED_FOLDER_FALLBACK_POLL_MS);
        poller.unref?.();
        importedFolderWatchers.set(key, { watcher, state, spec, poller });
        scheduleImportedFolderSync(key);
      } catch {
        // Native watching is unavailable; keep the imported folder current with an explicit polling-only watcher.
        const poller = setInterval(() => {
          scheduleImportedFolderSync(key);
        }, IMPORTED_FOLDER_FALLBACK_POLL_MS);
        poller.unref?.();
        importedFolderWatchers.set(key, { state, spec, poller });
        dirtyImportedFolderRoots.add(key);
        scheduleImportedFolderSync(key);
      }
    }
  }

  for (const [key, entry] of importedFolderWatchers) {
    if (nextKeys.has(key)) continue;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.poller) clearInterval(entry.poller);
    entry.watcher?.close();
    importedFolderWatchers.delete(key);
    dirtyImportedFolderRoots.delete(key);
  }
}

function scheduleImportedFolderSync(key: string): void {
  dirtyImportedFolderRoots.add(key);
  const entry = importedFolderWatchers.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (!dirtyImportedFolderRoots.delete(key)) return;
    if (!isReadableDirectory(entry.spec.path)) return;
    if (syncImportedNativeFolderRoot(entry.state, entry.spec.path, entry.spec.vaultPath)) {
      entry.state.store.saveFrom(entry.state.app);
    }
  }, IMPORTED_FOLDER_WATCH_DEBOUNCE_MS);
}

function importedFolderWatcherKey(spec: KnowledgeWritableRootSpec): string {
  return `${spec.vaultPath}\0${resolve(spec.path)}`;
}

function isReadableDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function syncImportedNativeFolderRoot(state: BridgeState, rootPath: string, vaultRoot: string): boolean {
  const seenDocumentIds = new Set<string>();
  let changed = syncNativeFolderFiles(state, rootPath, vaultRoot, 0, seenDocumentIds);
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const metadata = document.metadata ?? {};
    if (metadata.createdBy !== "opengrove.import-folder" || metadata.importedFolderRoot) continue;
    const currentVaultPath = safeVaultPath(metadata.vaultPath);
    if (!currentVaultPath || !vaultPathContains(currentVaultPath, vaultRoot)) continue;
    // Only reap documents whose backing file physically lives under THIS root.
    // Two physical roots can share a vault prefix (e.g. ~/.codex/skills and
    // ~/.agents/skills both map to "Codex/skills"); without this guard, syncing
    // one root would delete the other root's documents, which the other root's
    // watcher immediately recreates — an unbounded create/delete churn that
    // bloats the knowledge ledgers and the state file.
    const originPath = typeof metadata.sourceFileOriginPath === "string" ? metadata.sourceFileOriginPath : "";
    if (!originPath || !isPathInsideRoot(originPath, rootPath)) continue;
    if (seenDocumentIds.has(document.id)) continue;
    if (state.app.knowledge.delete(document.id)) {
      changed = true;
    }
  }
  return changed;
}

function syncNativeFolderFiles(
  state: BridgeState,
  dirPath: string,
  vaultPrefix: string,
  depth: number,
  seenDocumentIds: Set<string>,
): boolean {
  if (depth > 8) return false;
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  let changed = false;
  for (const entry of entries) {
    if (entry.name.startsWith(".") || shouldIgnoreVaultDirectory(entry.name)) continue;
    const filePath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (
        syncNativeFolderFiles(
          state,
          filePath,
          `${vaultPrefix}/${safePathSegment(entry.name)}`,
          depth + 1,
          seenDocumentIds,
        )
      ) {
        changed = true;
      }
      continue;
    }
    if (!entry.isFile() || !isVisibleKnowledgeFileName(entry.name)) continue;
    const result = upsertImportedNativeFile(state, filePath, vaultPrefix);
    if (result.documentId) {
      seenDocumentIds.add(result.documentId);
    }
    changed = result.changed || changed;
  }
  return changed;
}

export function importLocalFolderToKnowledge(state: BridgeState, payload: KnowledgeFileSystemImportFolderPayload) {
  ensureKnowledgeVaultRoot();
  const folderPath = payload.folderPath;
  if (!folderPath || !existsSync(folderPath)) {
    throw new Error("import_folder_path_required");
  }
  const stat = statSync(folderPath);
  if (!stat.isDirectory()) {
    throw new Error("import_folder_not_a_directory");
  }
  const resolvedFolderPath = resolve(folderPath);
  const folderName = basename(resolvedFolderPath);
  const vaultRoot = uniqueImportedVaultRoot(state, resolvedFolderPath);

  // Always create a root marker document so the folder appears in the tree.
  // vaultPath is just the root name so resolveImportedRootPath can find it.
  const rootDocId = `native.import.root.${shortHash(resolvedFolderPath)}`;
  state.app.knowledge.upsert({
    id: rootDocId,
    slug: rootDocId.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
    type: "source",
    title: folderName,
    body: "",
    format: "markdown",
    tags: ["imported", "folder-root"],
    sourceRefs: [{ title: folderName, locator: resolvedFolderPath }],
    scope: "user",
    lifecycle: "active",
    metadata: {
      vaultPath: `${vaultRoot}/.imported-root`,
      kernelId: APP_PROTOCOL_ID,
      sourceId: `${APP_PROTOCOL_ID}.vault`,
      sourceFilePath: resolvedFolderPath,
      sourceFileBacking: "native",
      sourceFileOriginPath: resolvedFolderPath,
      nativeGlobalKnowledge: true,
      createdBy: "opengrove.import-folder",
      importedFolderRoot: true,
    },
  });

  syncImportedNativeFolderRoot(state, resolvedFolderPath, vaultRoot);
  ensureImportedNativeFolderWatchers(state, [
    { vaultPath: vaultRoot, path: resolvedFolderPath, backing: "native", originPath: resolvedFolderPath },
  ]);

  return {
    knowledge: listKnowledgeInventoryDocuments(state),
    knowledgeFolders: listKnowledgeVaultFolders(state),
    knowledgeLedgers: state.app.knowledge.snapshotLedgers(),
  };
}

function upsertImportedNativeFile(
  state: BridgeState,
  filePath: string,
  vaultPrefix: string,
): { changed: boolean; documentId?: string } {
  const docId = `native.import.${shortHash(filePath)}`;
  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile() || fileStat.size > KNOWLEDGE_FILE_SIZE_LIMIT) {
      return { changed: false };
    }
    const existing = state.app.knowledge.get(docId);
    const metadata = existing?.metadata ?? {};
    const sameSnapshot =
      existing?.lifecycle === "active" &&
      Number(metadata.sourceFileMtimeMs) === fileStat.mtimeMs &&
      Number(metadata.sourceFileSize) === fileStat.size;
    if (sameSnapshot) {
      return { changed: false, documentId: docId };
    }
    const fileVaultPath = `${vaultPrefix}/${safePathSegment(basename(filePath))}`;
    const title = basename(filePath).replace(/\.(?:md|markdown|mdx|txt)$/i, "");
    const body = readFileSync(filePath, "utf8");
    state.app.knowledge.upsert({
      id: docId,
      slug: docId.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
      type: "note",
      title,
      body,
      format: inferKnowledgeFileFormat(filePath),
      tags: ["imported"],
      sourceRefs: [{ title, locator: filePath }],
      scope: "user",
      lifecycle: "active",
      metadata: {
        vaultPath: fileVaultPath,
        kernelId: APP_PROTOCOL_ID,
        sourceId: `${APP_PROTOCOL_ID}.vault`,
        sourceFilePath: filePath,
        sourceFileBacking: "native",
        sourceFileOriginPath: filePath,
        sourceFileMtimeMs: fileStat.mtimeMs,
        sourceFileSize: fileStat.size,
        sourceFileSyncedAt: new Date().toISOString(),
        nativeGlobalKnowledge: true,
        createdBy: "opengrove.import-folder",
      },
    });
    return { changed: true, documentId: docId };
  } catch {
    return { changed: false };
  }
}

function uniqueImportedVaultRoot(state: BridgeState, folderPath: string): string {
  const existingRoot = importedRootForFolder(state, folderPath);
  if (existingRoot) return existingRoot;

  const base = safePathSegment(basename(folderPath));
  if (!isImportedVaultRootNameTaken(state, base, folderPath)) return base;

  const hash = shortHash(folderPath).slice(0, 6);
  let candidate = `${base}-${hash}`;
  let index = 2;
  while (isImportedVaultRootNameTaken(state, candidate, folderPath)) {
    candidate = `${base}-${hash}-${index}`;
    index += 1;
  }
  return candidate;
}

function importedRootForFolder(state: BridgeState, folderPath: string): string | undefined {
  const rootDoc = state.app.knowledge.get(`native.import.root.${shortHash(folderPath)}`);
  const vaultPath = safeVaultPath(rootDoc?.metadata?.vaultPath);
  return vaultPath?.split("/")[0];
}

function isImportedVaultRootNameTaken(state: BridgeState, rootName: string, folderPath: string): boolean {
  if (!rootName || PROTECTED_VAULT_ROOTS.has(rootName)) return true;
  if (existsSync(resolve(knowledgeVaultRoot(), rootName))) return true;
  const target = resolve(folderPath);
  for (const document of state.app.knowledge.list({ limit: 5_000 })) {
    const vaultPath = safeVaultPath(document.metadata?.vaultPath);
    if (vaultPath?.split("/")[0] !== rootName) continue;
    const originPath =
      typeof document.metadata?.sourceFileOriginPath === "string"
        ? resolve(document.metadata.sourceFileOriginPath)
        : "";
    if (originPath && (originPath === target || isPathInsideRoot(originPath, target))) {
      continue;
    }
    return true;
  }
  return false;
}
