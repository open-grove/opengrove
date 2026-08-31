import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, relative, resolve } from "node:path";
import { APP_VAULT_ROOT_NAME } from "../identity.js";

export const VISIBLE_KNOWLEDGE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);

export const IGNORED_VAULT_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".vite",
  ".cache",
  "cache",
  "tmp",
  "temp",
  "logs",
  "log",
  "sessions",
  "session-env",
  "todos",
  "telemetry",
  "usage-data",
  "statsig",
  "backups",
  "debug",
]);

export function safeVaultPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized === "..") return undefined;
  return normalized;
}

export function vaultPathContains(childPath: string, parentPath: string): boolean {
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

export function rootVaultPath(path: string): string {
  return safeVaultPath(path)?.split("/")[0] || APP_VAULT_ROOT_NAME;
}

export function relativeVaultPath(parentPath: string, childPath: string): string {
  if (childPath === parentPath) return "";
  return childPath.slice(parentPath.length + 1);
}

export function parentVaultPaths(vaultPath: string): string[] {
  const segments = vaultPath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

export function joinVaultPath(parentPath: string, childName: string): string {
  return [safeVaultPath(parentPath), safePathSegment(childName)].filter(Boolean).join("/");
}

export function ensureMarkdownFileName(name: string): string {
  return /\.(?:md|markdown|mdx)$/i.test(name) ? name : `${name}.md`;
}

export function uniqueFilePath(parentPath: string, fileName: string): string {
  const extension = extname(fileName) || ".md";
  const stem = fileName.slice(0, fileName.length - extension.length) || "Untitled";
  let candidate = resolve(parentPath, `${stem}${extension}`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = resolve(parentPath, `${stem} ${index}${extension}`);
    index += 1;
  }
  return candidate;
}

export function uniqueDirectoryPath(parentPath: string, folderName: string): string {
  const base = folderName || "New folder";
  let candidate = resolve(parentPath, base);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = resolve(parentPath, `${base} ${index}`);
    index += 1;
  }
  return candidate;
}

export function safeIdSegment(value: string): string {
  return safePathSegment(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .toLowerCase();
}

export function shortHash(value: string): string {
  return createHash("sha1").update(resolve(value)).digest("hex").slice(0, 12);
}

export function safePathSegment(value: string): string {
  const sanitized = value
    .replace(/[<>:"\\|?*\x00-\x1f]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 120);
  return sanitized || "untitled";
}

export function inferKnowledgeFileFormat(path: string): "markdown" | "json" | "plain" {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".mdx" || extension === ".markdown") return "markdown";
  if (extension === ".json") return "json";
  return "plain";
}

export function shouldIgnoreVaultDirectory(name: string): boolean {
  return IGNORED_VAULT_DIR_NAMES.has(name) || name.startsWith(".");
}

export function isVisibleKnowledgeFileName(name: string): boolean {
  return VISIBLE_KNOWLEDGE_EXTENSIONS.has(extname(name).toLowerCase());
}

export function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const root = resolve(rootPath);
  const file = resolve(filePath);
  const rel = relative(root, file);
  return rel === "" || Boolean(rel && !rel.startsWith("..") && !rel.startsWith("/"));
}
