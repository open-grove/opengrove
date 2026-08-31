import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceScope {
  kind: "local";
  appId: string;
  root: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  mimeType?: string;
  updatedAt?: string;
  children?: WorkspaceFileEntry[];
}

export interface WorkspaceListResult {
  entries: WorkspaceFileEntry[];
  count: number;
  truncated: boolean;
}

export interface WorkspaceFileReadResult {
  entry: WorkspaceFileEntry & { kind: "file" };
  content?: string;
  contentTruncated?: boolean;
}

export interface WorkspaceRawFileResult {
  entry: WorkspaceFileEntry & { kind: "file" };
  absolutePath: string;
}

export interface WorkspaceStore {
  ensureWorkspace(scope: WorkspaceScope): void;
  createRunWorkspace(scope: WorkspaceScope, runId: string): WorkspaceScope;
  listFiles(scope: WorkspaceScope, options?: WorkspaceListOptions): WorkspaceListResult;
  readFile(scope: WorkspaceScope, path: string, options?: WorkspaceReadOptions): WorkspaceFileReadResult | undefined;
  writeFile(scope: WorkspaceScope, path: string, data: string | Buffer): WorkspaceFileReadResult | undefined;
  openRawFile(scope: WorkspaceScope, path: string): WorkspaceRawFileResult | undefined;
}

export interface WorkspaceListOptions {
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
  ignoredNames?: readonly string[];
}

export interface WorkspaceReadOptions {
  textSizeLimit?: number;
}

const DEFAULT_MAX_TREE_DEPTH = 8;
const DEFAULT_MAX_TREE_ENTRIES = 1_200;
const DEFAULT_IGNORED_NAMES = new Set([
  ".DS_Store",
  ".gitkeep",
  ".story-seed",
  ".claude",
  ".git",
  ".env",
  ".cache",
  ".tmp",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "node_modules",
]);

export class LocalFilesystemWorkspaceStore implements WorkspaceStore {
  ensureWorkspace(scope: WorkspaceScope): void {
    mkdirSync(scope.root, { recursive: true });
  }

  createRunWorkspace(scope: WorkspaceScope, runId: string): WorkspaceScope {
    const runRoot = safeResolveInside(scope.root, join("runs", runId));
    if (!runRoot) {
      throw new Error("workspace_run_path_invalid");
    }
    mkdirSync(runRoot, { recursive: true });
    return {
      kind: scope.kind,
      appId: scope.appId,
      root: runRoot,
    };
  }

  listFiles(scope: WorkspaceScope, options: WorkspaceListOptions = {}): WorkspaceListResult {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_TREE_DEPTH;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_TREE_ENTRIES;
    const ignoredNames = new Set([...DEFAULT_IGNORED_NAMES, ...(options.ignoredNames ?? [])]);
    const state = { count: 0, truncated: false };
    const entries = this.readDirectoryEntries(scope.root, options.path ?? "", 0, {
      ignoredNames,
      maxDepth,
      maxEntries,
      state,
    });
    return {
      entries,
      count: state.count,
      truncated: state.truncated,
    };
  }

  readFile(
    scope: WorkspaceScope,
    path: string,
    options: WorkspaceReadOptions = {},
  ): WorkspaceFileReadResult | undefined {
    const filePath = resolveExistingContainedPath(scope.root, path);
    if (!filePath) return undefined;
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;

    const mimeType = contentTypeForPath(filePath);
    const entry = fileEntry(scope.root, filePath, stat.mtime.toISOString(), stat.size, mimeType);
    const textSizeLimit = options.textSizeLimit ?? 0;
    const isText = isTextMimeType(mimeType);
    const content = isText && stat.size <= textSizeLimit ? readFileSync(filePath, "utf8") : undefined;
    return {
      entry,
      content,
      contentTruncated: content === undefined && isText,
    };
  }

  writeFile(scope: WorkspaceScope, path: string, data: string | Buffer): WorkspaceFileReadResult | undefined {
    const filePath = resolveWritableContainedPath(scope.root, path);
    if (!filePath) return undefined;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, data);
    return this.readFile(scope, path, { textSizeLimit: Buffer.byteLength(data) });
  }

  openRawFile(scope: WorkspaceScope, path: string): WorkspaceRawFileResult | undefined {
    const filePath = resolveExistingContainedPath(scope.root, path);
    if (!filePath) return undefined;
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
    return {
      entry: fileEntry(scope.root, filePath, stat.mtime.toISOString(), stat.size, contentTypeForPath(filePath)),
      absolutePath: filePath,
    };
  }

  private readDirectoryEntries(
    root: string,
    relativePath: string,
    depth: number,
    options: {
      ignoredNames: Set<string>;
      maxDepth: number;
      maxEntries: number;
      state: { count: number; truncated: boolean };
    },
  ): WorkspaceFileEntry[] {
    if (depth > options.maxDepth || options.state.count >= options.maxEntries) {
      options.state.truncated = true;
      return [];
    }

    const directory = resolveExistingContainedPath(root, relativePath);
    if (!directory) return [];

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }

    const output: WorkspaceFileEntry[] = [];
    for (const entry of entries) {
      if (options.ignoredNames.has(entry.name)) continue;
      if (options.state.count >= options.maxEntries) {
        options.state.truncated = true;
        break;
      }
      const childRelativePath = normalizeRelativePath(join(relativePath, entry.name));
      const childPath = resolveExistingContainedPath(root, childRelativePath);
      if (!childPath) continue;

      try {
        const stat = statSync(childPath);
        options.state.count += 1;
        if (entry.isDirectory()) {
          output.push({
            name: entry.name,
            path: childRelativePath,
            kind: "directory",
            updatedAt: stat.mtime.toISOString(),
            children: this.readDirectoryEntries(root, childRelativePath, depth + 1, options),
          });
        } else if (entry.isFile()) {
          output.push(fileEntry(root, childPath, stat.mtime.toISOString(), stat.size, contentTypeForPath(childPath)));
        }
      } catch {
        // Ignore unreadable files while keeping the workbench usable.
      }
    }

    return output.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }
}

export function safeResolveInside(root: string, requestedPath: string): string | undefined {
  if (isAbsolute(requestedPath)) return undefined;
  const candidate = resolve(root, requestedPath || ".");
  const relation = relative(root, candidate);
  if (relation === "") return candidate;
  if (relation.startsWith("..") || relation.includes(`..${sep}`)) return undefined;
  return candidate;
}

export function resolveExistingContainedPath(root: string, requestedPath: string): string | undefined {
  const candidate = safeResolveInside(root, requestedPath);
  if (!candidate || !existsSync(candidate)) return undefined;

  let rootRealPath;
  let candidateRealPath;
  try {
    rootRealPath = realpathSync.native(root);
    candidateRealPath = realpathSync.native(candidate);
  } catch {
    return undefined;
  }

  const relation = relative(rootRealPath, candidateRealPath);
  if (relation === "") return candidate;
  if (relation.startsWith("..") || relation.includes(`..${sep}`)) return undefined;
  return candidate;
}

export function resolveWritableContainedPath(root: string, requestedPath: string): string | undefined {
  const candidate = safeResolveInside(root, requestedPath);
  if (!candidate) return undefined;
  if (existsSync(candidate)) return resolveExistingContainedPath(root, requestedPath);

  let existingAncestor = dirname(candidate);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return undefined;
    existingAncestor = parent;
  }
  try {
    const rootRealPath = realpathSync.native(root);
    const ancestorRealPath = realpathSync.native(existingAncestor);
    const relation = relative(rootRealPath, ancestorRealPath);
    if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return candidate;
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/toml" ||
    normalized === "application/sql" ||
    normalized === "application/x-subrip" ||
    normalized === "application/x-yaml" ||
    normalized === "application/xml"
  );
}

export function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".markdown":
    case ".mdx":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/x-yaml; charset=utf-8";
    case ".toml":
      return "application/toml; charset=utf-8";
    case ".ini":
    case ".env":
    case ".gitignore":
    case ".dockerignore":
    case ".editorconfig":
      return "text/plain; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".tsv":
      return "text/tab-separated-values; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
    case ".scss":
    case ".sass":
    case ".less":
      return "text/css; charset=utf-8";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
    case ".py":
    case ".rb":
    case ".go":
    case ".rs":
    case ".java":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".cs":
    case ".php":
    case ".swift":
    case ".kt":
    case ".kts":
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".fish":
      return "text/plain; charset=utf-8";
    case ".sql":
      return "application/sql; charset=utf-8";
    case ".srt":
      return "application/x-subrip; charset=utf-8";
    case ".vtt":
      return "text/vtt; charset=utf-8";
    case ".ass":
      return "text/plain; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".svg":
      return "image/svg+xml";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function fileEntry(
  root: string,
  absolutePath: string,
  updatedAt: string,
  size: number,
  mimeType: string,
): WorkspaceFileEntry & { kind: "file" } {
  return {
    name: basename(absolutePath),
    path: normalizeRelativePath(relative(root, absolutePath)),
    kind: "file",
    size,
    mimeType,
    updatedAt,
  };
}
