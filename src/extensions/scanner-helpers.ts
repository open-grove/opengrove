import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonObject } from "../core.js";
import { isExecutableFile, resolveHostCommandPath } from "../environment/command-path.js";
import { APP_NATIVE_SKILL_MARKER_FILE } from "../identity.js";
import type { BridgeKernelId } from "../server/bridge-types.js";
import type {
  ExtensionCommandUsage,
  ExtensionDeployment,
  ExtensionInventorySummary,
  ExtensionKind,
  ExtensionPermission,
  ManagedExtensionRecord,
} from "./types.js";

export interface ParsedSkill {
  name: string;
  title: string;
  description: string;
  tags: string[];
  allowedTools: string[];
  shell: string[];
  paths: string[];
  frontmatter: Record<string, unknown>;
}

export interface HookEntry {
  name: string;
  event?: string;
  matcher?: string;
  command?: string;
  args: string[];
  envKeys: string[];
  entry: JsonObject;
}

export function parseSkillFile(path: string, fallbackName: string): ParsedSkill {
  try {
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    const name = stringValue(parsed.frontmatter.name) || fallbackName;
    const bodyDescription = firstBodyParagraph(parsed.body);
    const skillRoot = dirname(path);
    return {
      name,
      title: stringValue(parsed.frontmatter.title) || titleFromName(name),
      description: stringValue(parsed.frontmatter.description) || bodyDescription || "",
      tags: arrayOfStrings(parsed.frontmatter.tags),
      allowedTools: arrayOfStrings(parsed.frontmatter["allowed-tools"] ?? parsed.frontmatter.allowed_tools),
      shell: arrayOfStrings(parsed.frontmatter.shell).map((item) => resolveSkillScopedValue(item, skillRoot)),
      paths: arrayOfStrings(parsed.frontmatter.paths).map((item) => resolveSkillScopedValue(item, skillRoot)),
      frontmatter: parsed.frontmatter,
    };
  } catch {
    return {
      name: fallbackName,
      title: titleFromName(fallbackName),
      description: "",
      tags: [],
      allowedTools: [],
      shell: [],
      paths: [],
      frontmatter: {},
    };
  }
}

export function resolveSkillScopedValue(value: string, skillRoot: string): string {
  const resolved = value.replace(/\$\{OPENGROVE_SKILL_DIR\}/g, skillRoot).replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillRoot);
  if (/^[^\s]+$/.test(resolved) && (resolved.startsWith("/") || resolved === "~" || resolved.startsWith("~/"))) {
    return resolvePathLike(resolved);
  }
  return resolved;
}

export function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    return { frontmatter: {}, body: normalized };
  }
  const rawFrontmatter = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5);
  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";
  let currentList: string[] | undefined;
  const flushList = () => {
    if (currentKey && currentList) frontmatter[currentKey] = [...currentList];
    currentList = undefined;
  };
  for (const rawLine of rawFrontmatter.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      currentList ??= [];
      currentList.push(stripQuotes((listMatch[1] ?? "").trim()));
      continue;
    }
    flushList();
    const separator = line.indexOf(":");
    if (separator < 0) {
      currentKey = "";
      continue;
    }
    currentKey = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!rawValue) {
      currentList = [];
      continue;
    }
    frontmatter[currentKey] = parseScalar(rawValue);
    currentKey = "";
  }
  flushList();
  return { frontmatter, body };
}

export function parseSimpleToml(text: string): JsonObject {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = root;
      for (const part of (sectionMatch[1] ?? "").split(".")) {
        const key = stripQuotes(part.trim());
        const next = record(current[key]);
        current[key] = next;
        current = next;
      }
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    current[key] = parseTomlValue(line.slice(separator + 1).trim());
  }
  return root as JsonObject;
}

export function parseTomlValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitCsvLike(inner).map((part) => stripQuotes(part.trim()));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const numberValue = Number(value);
  if (Number.isFinite(numberValue) && /^-?\d+(\.\d+)?$/.test(value)) return numberValue;
  return stripQuotes(value);
}

export function extractClaudeStyleHooks(hooks: Record<string, unknown>): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const [event, rawEventEntries] of Object.entries(hooks)) {
    const eventEntries = Array.isArray(rawEventEntries) ? rawEventEntries : [rawEventEntries];
    for (const rawEntry of eventEntries) {
      const entry = record(rawEntry);
      const matcher = stringValue(entry.matcher);
      const nestedHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const nested of nestedHooks) {
        const nestedRecord = record(nested);
        const command = stringValue(nestedRecord.command) ?? stringValue(nestedRecord.cmd);
        if (!command) continue;
        const name = safeName([event, matcher ?? "all", command].join("-"));
        entries.push({
          name,
          event,
          matcher,
          command,
          args: arrayOfStrings(nestedRecord.args),
          envKeys: Object.keys(record(nestedRecord.env)),
          entry: nestedRecord as JsonObject,
        });
      }
    }
  }
  return uniqueBy(entries, (entry) => entry.name);
}

export function extractGenericHookCommands(config: JsonObject): HookEntry[] {
  const entries: HookEntry[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    const item = record(value);
    if (!Object.keys(item).length) return;
    const command = stringValue(item.command) ?? stringValue(item.cmd) ?? stringValue(item.run);
    if (command) {
      const event = stringValue(item.event) ?? path[path.length - 1];
      const matcher = stringValue(item.matcher) ?? stringValue(item.match);
      const name = safeName([event ?? "hook", matcher ?? "all", command].join("-"));
      entries.push({
        name,
        event,
        matcher,
        command,
        args: arrayOfStrings(item.args),
        envKeys: Object.keys(record(item.env)),
        entry: item as JsonObject,
      });
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === "mcpServers" || key === "mcp_servers" || key === "servers") continue;
      visit(child, [...path, key]);
    }
  };
  visit(config, []);
  return uniqueBy(entries, (entry) => entry.name);
}

export function extractCommandUsagesFromObject(
  input: JsonObject,
  parentKind: ExtensionKind,
  parentId: string,
  kernelId: BridgeKernelId | undefined,
  configPath: string,
): ExtensionCommandUsage[] {
  const commands: ExtensionCommandUsage[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = record(value);
    if (!Object.keys(item).length) return;
    const command = stringValue(item.command) ?? stringValue(item.cmd) ?? stringValue(item.run);
    if (command) {
      commands.push(
        commandUsage({
          command,
          args: arrayOfStrings(item.args),
          envKeys: Object.keys(record(item.env)),
          parentKind,
          parentId,
          kernelId,
          configPath,
          risk: commandRisk(command, arrayOfStrings(item.args)),
        }),
      );
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(input);
  return uniqueCommandUsages(commands);
}

export function skillPermissions(skill: ParsedSkill): ExtensionPermission[] {
  const permissions: ExtensionPermission[] = [];
  if (skill.allowedTools.length) permissions.push({ type: "unknown", values: skill.allowedTools });
  if (skill.shell.length) permissions.push({ type: "shell", values: skill.shell });
  if (skill.paths.length) permissions.push({ type: "filesystem", values: skill.paths });
  return permissions;
}

export function skillCommandUsages(
  skill: ParsedSkill,
  deploymentIdValue: string,
  kernelId?: BridgeKernelId,
): ExtensionCommandUsage[] {
  return skill.shell.map((command) =>
    commandUsage({
      command,
      args: [],
      envKeys: [],
      parentKind: "skill",
      parentId: deploymentIdValue,
      kernelId,
      risk: commandRisk(command, []),
    }),
  );
}

export function commandsToPermissions(commands: ExtensionCommandUsage[]): ExtensionPermission[] {
  const permissions: ExtensionPermission[] = [];
  const shellValues = uniqueStrings(commands.map((usage) => usage.command));
  const envValues = uniqueStrings(commands.flatMap((usage) => usage.envKeys));
  if (shellValues.length) permissions.push({ type: "shell", values: shellValues });
  if (envValues.length) permissions.push({ type: "env", values: envValues });
  return permissions;
}

export function readManagedMarker(skillRoot: string): { managedBy?: string; sourceRoot?: string } | undefined {
  const markerPath = join(skillRoot, APP_NATIVE_SKILL_MARKER_FILE);
  if (!existsSync(markerPath)) return undefined;
  try {
    return record(JSON.parse(readFileSync(markerPath, "utf8"))) as { managedBy?: string; sourceRoot?: string };
  } catch {
    return undefined;
  }
}

export function skillDirectoryDigest(skillRoot: string | undefined): string | undefined {
  if (!skillRoot || !existsSync(skillRoot)) return undefined;
  try {
    const root = realpathSync(skillRoot);
    const hash = createHash("sha256");
    for (const file of comparableSkillFiles(root)) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(readFileSync(file.absolutePath));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

export function comparableSkillFiles(root: string, base = root): { absolutePath: string; relativePath: string }[] {
  const files: { absolutePath: string; relativePath: string }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === APP_NATIVE_SKILL_MARKER_FILE || entry.name === ".opengrove-skill-origin.json") continue;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...comparableSkillFiles(absolutePath, base));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      absolutePath,
      relativePath: absolutePath.slice(base.length + 1).replace(/\\/g, "/"),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function commandUsage(
  input: Omit<ExtensionCommandUsage, "resolvedPath"> & { resolvedPath?: string },
): ExtensionCommandUsage {
  return {
    ...input,
    resolvedPath: input.resolvedPath ?? resolveExecutable(input.command),
  };
}

export function commandRisk(command: string, args: string[]): "low" | "medium" | "high" {
  const text = [command, ...args].join(" ").toLowerCase();
  if (/\b(rm|sudo|chmod|chown|mkfs|dd|curl|wget|ssh|scp|docker|kubectl)\b/.test(text)) {
    return "high";
  }
  if (/\b(npx|uvx|python|node|bash|sh|zsh|powershell|pwsh)\b/.test(text)) {
    return "medium";
  }
  return "low";
}

export function resolveExecutable(command: string | undefined): string | undefined {
  return resolveHostCommandPath(command);
}

export function isExecutable(path: string): boolean {
  return isExecutableFile(path);
}

export function summarizeInventory(
  items: ManagedExtensionRecord[],
  deployments: ExtensionDeployment[],
): ExtensionInventorySummary {
  const byKind: Record<string, number> = {};
  const byKernel: Record<string, number> = {};
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  }
  for (const deployment of deployments) {
    if (deployment.kernelId) {
      byKernel[deployment.kernelId] = (byKernel[deployment.kernelId] ?? 0) + 1;
    }
  }
  return {
    itemCount: items.length,
    deploymentCount: deployments.length,
    byKind,
    byKernel,
    managedCount: items.filter((item) => item.managedByOpenGrove).length,
    systemCount: items.filter((item) => item.system).length,
  };
}

export function parseScalar(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitCsvLike(inner).map((part) => stripQuotes(part.trim())) : [];
  }
  return stripQuotes(value);
}

export function splitCsvLike(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function firstBodyParagraph(body: string): string | undefined {
  const line = body
    .split(/\r?\n/g)
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#"));
  return line || undefined;
}

export function itemId(kind: ExtensionKind, name: string): string {
  return `${kind}.${safeName(name)}`;
}

export function deploymentId(
  kind: ExtensionKind,
  kernelId: BridgeKernelId | undefined,
  path: string,
  name: string,
): string {
  return `deployment.${kind}.${kernelId ?? "host"}.${safeName(name)}.${hashText(`${path}\n${name}`)}`;
}

export function safeName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

export function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const output: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

export function uniqueCommandUsages(values: ExtensionCommandUsage[]): ExtensionCommandUsage[] {
  return uniqueBy(values, (usage) =>
    [
      usage.parentKind,
      usage.parentId,
      usage.kernelId ?? "",
      usage.command,
      usage.args.join(" "),
      usage.configPath ?? "",
    ].join("\n"),
  );
}

export function dedupePermissions(values: ExtensionPermission[]): ExtensionPermission[] {
  const byType = new Map<ExtensionPermission["type"], Set<string>>();
  for (const value of values) {
    const set = byType.get(value.type) ?? new Set<string>();
    for (const item of value.values) set.add(item);
    byType.set(value.type, set);
  }
  return Array.from(byType.entries()).map(([type, set]) => ({
    type,
    values: Array.from(set).sort((left, right) => left.localeCompare(right)),
  }));
}

export function compareItems(left: ManagedExtensionRecord, right: ManagedExtensionRecord): number {
  return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}

export function compareDeployments(left: ExtensionDeployment, right: ExtensionDeployment): number {
  return (
    left.kind.localeCompare(right.kind) ||
    (left.kernelId ?? "").localeCompare(right.kernelId ?? "") ||
    (left.targetPath ?? left.configPath ?? "").localeCompare(right.targetPath ?? right.configPath ?? "")
  );
}

export function shouldSkipDirectory(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === "web-dist";
}

export function titleFromName(name: string): string {
  return name
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
