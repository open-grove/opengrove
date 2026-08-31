import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { APP_CONFIG_DIR, APP_ENV_PREFIX } from "../identity.js";
import { packageRoot } from "../package-root.js";
import type {
  ActivitySpace,
  JsonObject,
  LoadedSkill,
  SkillCatalog,
  SkillExecutionContext,
  SkillManifest,
  SkillSource,
  SkillTrust,
} from "../core.js";
import { validateAppManifestFile } from "../app-builder/manifest.js";

interface SkillRoot {
  dir: string;
  source: SkillSource;
  trust: SkillTrust;
  packId?: string;
}

interface ExternalMountedApp {
  id?: string;
  path: string;
  enabled?: boolean;
  title?: string;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface CreateSkillCatalogOptions {
  cwd?: string;
  workspaceRoot?: string;
  userHome?: string;
  includeCodexSkills?: boolean;
  mountedApps?: ExternalMountedApp[];
}

interface SkillInterfaceMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
}

export function createSkillCatalog(options: CreateSkillCatalogOptions = {}): SkillCatalog {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceRoot = resolve(options.workspaceRoot ?? cwd);
  const loaded = loadSkillManifests(cwd, {
    workspaceRoot,
    userHome: options.userHome ?? homedir(),
    includeCodexSkills: options.includeCodexSkills === true,
    mountedApps: options.mountedApps ?? [],
  });
  const byId = new Map<string, SkillManifest>();
  const byName = new Map<string, SkillManifest>();
  const ambiguousNames = new Set<string>();

  for (const skill of loaded) {
    byId.set(skill.id, skill);
    for (const lookupName of [skill.name, ...(skill.aliases ?? [])]) {
      const normalized = normalizeSkillLookup(lookupName);
      if (!normalized || ambiguousNames.has(normalized)) continue;
      const existing = byName.get(normalized);
      if (existing && existing.id !== skill.id) {
        byName.delete(normalized);
        ambiguousNames.add(normalized);
      } else {
        byName.set(normalized, skill);
      }
    }
  }

  return {
    list() {
      return loaded.map((skill) => cloneSkill(skill));
    },
    get(idOrName) {
      const normalized = normalizeSkillLookup(idOrName);
      const skill = byId.get(idOrName) ?? byId.get(`skill.${normalized}`) ?? byName.get(normalized);
      return skill ? cloneSkill(skill) : undefined;
    },
    resolve(name, resolveOptions = {}) {
      const normalized = normalizeSkillLookup(name);
      const skill = byName.get(normalized) ?? byId.get(normalized) ?? byId.get(`skill.${normalized}`);
      if (!skill) {
        return undefined;
      }
      if (!resolveOptions.includeDisabled && !skill.userInvocable && skill.disableModelInvocation) {
        return undefined;
      }
      return cloneSkill(skill);
    },
    load(name, args, sessionId) {
      const normalized = normalizeSkillLookup(name);
      const manifest = byId.get(name) ?? byId.get(`skill.${normalized}`) ?? byName.get(normalized);
      if (!manifest) {
        throw new Error(`unknown_skill:${name}`);
      }
      return loadSkillContent(manifest, args, sessionId);
    },
  };
}

export function renderSkillIndex(skills: SkillManifest[]): string {
  const lines = skills.map((skill) => {
    const meta = [
      skill.name,
      skill.whenToUse ? `when: ${skill.whenToUse}` : "",
      skill.allowedTools.length ? `allowed-tools: ${skill.allowedTools.join(", ")}` : "",
      skill.context === "fork" ? "context: fork" : "",
      skill.disableModelInvocation ? "model-invocation: disabled" : "",
    ]
      .filter(Boolean)
      .join(" | ");
    return [`- ${skill.name}: ${skill.description}`, meta ? `  ${meta}` : ""].filter(Boolean).join("\n");
  });
  return lines.join("\n");
}

export function estimateSkillFrontmatterText(skill: SkillManifest): string {
  return [skill.name, skill.description, skill.whenToUse ?? ""].filter(Boolean).join(" ");
}

function loadSkillManifests(
  _cwd: string,
  options: { workspaceRoot: string; userHome: string; includeCodexSkills: boolean; mountedApps: ExternalMountedApp[] },
): SkillManifest[] {
  const roots = collectSkillRoots(options);
  const seen = new Set<string>();
  const seenSkillKeys = new Set<string>();
  const skills: SkillManifest[] = [];

  for (const root of roots) {
    if (!existsSync(root.dir)) {
      continue;
    }

    const entries = readdirSync(root.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const skillRoot = join(root.dir, entry.name);
      const skillFile = join(skillRoot, "SKILL.md");
      if (!existsSync(skillFile)) {
        continue;
      }

      let fileIdentity = skillFile;
      try {
        fileIdentity = realpathSync(skillFile);
      } catch {
        // non-critical-fallback: A missing realpath only disables deduplication; the declared skill is still read below.
        fileIdentity = skillFile;
      }
      if (seen.has(fileIdentity)) {
        continue;
      }

      const markdown = readFileSync(skillFile, "utf8");
      const parsed = parseFrontmatter(markdown);
      const interfaceMetadata = readSkillInterfaceMetadata(skillRoot);
      const manifest = createSkillManifest({
        skillFile,
        skillRoot,
        skillName: entry.name,
        source: root.source,
        trust: root.trust,
        packId: parsed.frontmatter.pack ? String(parsed.frontmatter.pack) : root.packId,
        frontmatter: parsed.frontmatter,
        interfaceMetadata,
        body: parsed.body,
      });
      if (seenSkillKeys.has(manifest.id)) {
        seen.add(fileIdentity);
        continue;
      }
      skills.push(manifest);
      seenSkillKeys.add(manifest.id);
      seen.add(fileIdentity);
    }
  }

  return skills;
}

function collectSkillRoots(options: {
  workspaceRoot: string;
  userHome: string;
  includeCodexSkills: boolean;
  mountedApps: ExternalMountedApp[];
}): SkillRoot[] {
  // OpenGrove-owned source and the current App must win over stale mirrors in
  // project/user Kernel directories. Those directories remain discoverable for
  // user-authored optional skills, but cannot shadow an Employee's source Skill.
  const roots: SkillRoot[] = [
    {
      dir: resolve(packageRoot(), "src", "skills", "bundled"),
      source: "bundled",
      trust: "trusted",
    },
  ];

  for (const mountedApp of options.mountedApps) {
    if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
    const appRoot = resolvePathLike(mountedApp.path);
    for (const dir of mountedAppSkillRoots(appRoot)) {
      roots.push({
        dir,
        source: "pack",
        trust: "trusted",
        packId: mountedApp.id ? `app.${mountedApp.id}` : `app.${basename(appRoot)}`,
      });
    }
  }

  const ancestry = collectAncestry(options.workspaceRoot);
  for (const dir of ancestry) {
    roots.push({
      dir: join(dir, APP_CONFIG_DIR, "skills"),
      source: "project",
      trust: "trusted",
    });
    roots.push({
      dir: join(dir, ".claude", "skills"),
      source: "project",
      trust: "trusted",
    });
    roots.push({
      dir: join(dir, ".agents", "skills"),
      source: "project",
      trust: "trusted",
    });
    if (options.includeCodexSkills) {
      roots.push({
        dir: join(dir, ".codex", "skills"),
        source: "project",
        trust: "trusted",
      });
      roots.push({
        dir: join(dir, ".codex", "skills", ".system"),
        source: "bundled",
        trust: "trusted",
      });
    }
  }

  const home = options.userHome;
  roots.push({
    dir: join(home, APP_CONFIG_DIR, "skills"),
    source: "user",
    trust: "trusted",
  });
  roots.push({
    dir: join(home, ".claude", "skills"),
    source: "user",
    trust: "trusted",
  });
  roots.push({
    dir: join(home, ".agents", "skills"),
    source: "user",
    trust: "trusted",
  });
  if (options.includeCodexSkills) {
    roots.push({
      dir: join(home, ".codex", "skills"),
      source: "user",
      trust: "trusted",
    });
    roots.push({
      dir: join(home, ".codex", "skills", ".system"),
      source: "bundled",
      trust: "trusted",
    });
    for (const dir of collectCodexPluginSkillRoots(join(home, ".codex", "plugins", "cache"))) {
      roots.push({
        dir,
        source: "pack",
        trust: "trusted",
        packId: inferCodexPluginPackId(dir),
      });
    }
  }

  const bundledPackRoot = resolve(packageRoot(), "src", "packs", "bundled");
  if (existsSync(bundledPackRoot)) {
    const packDirs = readdirSync(bundledPackRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const packDir of packDirs) {
      const dir = join(bundledPackRoot, packDir.name, "skills");
      roots.push({
        dir,
        source: "pack",
        trust: "trusted",
        packId: `pack.${packDir.name}`,
      });
    }
  }

  return roots.filter((root, index, list) => list.findIndex((candidate) => candidate.dir === root.dir) === index);
}

function mountedAppSkillRoots(appRoot: string): string[] {
  const manifest = readMountedAppManifest(appRoot);
  const declaredRoots = [
    ...stringArray(recordValue(manifest.skills).roots),
    ...stringArray(recordValue(manifest.capabilities).skillRoots),
    ...stringArray(manifest.skillRoots),
  ];
  if (declaredRoots.length) {
    return uniqueStrings(declaredRoots.map((dir) => resolveAppPath(appRoot, dir)));
  }
  return collectSkillCollectionRoots(join(appRoot, "skills"), 0, 4);
}

function collectSkillCollectionRoots(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: string[] = [];
  const hasDirectSkills = entries.some((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")));
  if (hasDirectSkills) roots.push(dir);
  if (depth >= maxDepth) return roots;

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipSkillSearchDirectory(entry.name)) continue;
    roots.push(...collectSkillCollectionRoots(join(dir, entry.name), depth + 1, maxDepth));
  }
  return uniqueStrings(roots);
}

function readMountedAppManifest(appRoot: string): JsonObject {
  const result = validateAppManifestFile(appRoot);
  return result.manifest ? (result.manifest as JsonObject) : {};
}

function resolveAppPath(appRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(appRoot, path);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shouldSkipSkillSearchDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".venv" || name === "__pycache__";
}

function collectCodexPluginSkillRoots(root: string): string[] {
  const skillRoots: string[] = [];
  collectNestedSkillRoots(root, 0, 7, skillRoots);
  return skillRoots.sort((left, right) => left.localeCompare(right));
}

function collectNestedSkillRoots(dir: string, depth: number, maxDepth: number, output: string[]) {
  if (depth > maxDepth || !existsSync(dir)) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (dir.endsWith(`${pathSeparator()}skills`)) {
    output.push(dir);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    collectNestedSkillRoots(join(dir, entry.name), depth + 1, maxDepth, output);
  }
}

function inferCodexPluginPackId(skillDir: string): string | undefined {
  const marker = `${pathSeparator()}.codex${pathSeparator()}plugins${pathSeparator()}cache${pathSeparator()}`;
  const index = skillDir.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const relativePath = skillDir.slice(index + marker.length);
  const parts = relativePath.split(pathSeparator()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return `codex.${parts[1]}`;
}

function collectAncestry(cwd: string): string[] {
  const roots: string[] = [];
  const home = resolve(homedir());
  let current = resolve(cwd);

  while (true) {
    roots.push(current);
    if (current === home) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function createSkillManifest(input: {
  skillFile: string;
  skillRoot: string;
  skillName: string;
  source: SkillSource;
  trust: SkillTrust;
  packId?: string;
  frontmatter: Record<string, unknown>;
  interfaceMetadata?: SkillInterfaceMetadata;
  body: string;
}): SkillManifest {
  const canonicalName = readString(input.frontmatter.name) || input.skillName;
  const description = readDescription(input.frontmatter, input.body, canonicalName);
  const title =
    readString(input.frontmatter.title) || input.interfaceMetadata?.displayName || titleFromName(canonicalName);
  const whenToUse = readString(input.frontmatter.when_to_use) || readString(input.frontmatter["when-to-use"]);
  const context = readSkillContext(input.frontmatter.context);
  const packId = input.packId || readString(input.frontmatter.pack) || undefined;
  const declaredId = readString(input.frontmatter.id) || `skill.${canonicalName}`;
  const appId = packId?.startsWith("app.") ? packId.slice("app.".length) : "";
  const id = appId ? `skill.app.${appId}.${canonicalName}` : declaredId;
  const capabilityId = readString(input.frontmatter.capability) || undefined;
  const aliases = uniqueStrings([
    ...(canonicalName === input.skillName ? [] : [input.skillName]),
    ...(id === declaredId ? [] : [declaredId]),
    ...(appId ? [`app:${appId}/${canonicalName}`, `app:${appId}/${input.skillName}`] : []),
  ]);

  return {
    id,
    name: canonicalName,
    aliases: aliases.length ? aliases : undefined,
    title,
    description,
    whenToUse: whenToUse || undefined,
    format: "markdown-v2",
    entry: input.skillFile,
    skillRoot: input.skillRoot,
    activities: readActivitySpaces(input.frontmatter.activities),
    toolIds: readStringList(input.frontmatter["tool-ids"]),
    memoryHooks: [],
    allowedTools: readStringList(input.frontmatter["allowed-tools"]),
    argumentHint: readString(input.frontmatter["argument-hint"]) || undefined,
    arguments: readStringList(input.frontmatter.arguments),
    userInvocable: readBoolean(input.frontmatter["user-invocable"], true),
    disableModelInvocation: readBoolean(input.frontmatter["disable-model-invocation"], false),
    model: readString(input.frontmatter.model) || undefined,
    effort: readString(input.frontmatter.effort) || undefined,
    context,
    shell: readSkillScopedStringList(input.frontmatter.shell, input.skillRoot),
    paths: readSkillScopedStringList(input.frontmatter.paths, input.skillRoot),
    hooks: isJsonObject(input.frontmatter.hooks) ? input.frontmatter.hooks : undefined,
    source: input.source,
    trust: input.trust,
    packId,
    capabilityId,
    contentLength: input.body.length,
    tags: readStringList(input.frontmatter.tags),
  };
}

function readSkillScopedStringList(value: unknown, skillRoot: string): string[] {
  return readStringList(value).map((item) => resolveSkillScopedValue(item, skillRoot));
}

function resolveSkillScopedValue(value: string, skillRoot: string): string {
  const resolved = value
    .replace(new RegExp(`\\$\\{${APP_ENV_PREFIX}_SKILL_DIR\\}`, "g"), skillRoot)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillRoot);
  if (/^[^\s]+$/.test(resolved) && (resolved.startsWith("/") || resolved === "~" || resolved.startsWith("~/"))) {
    return resolvePathLike(resolved);
  }
  return resolved;
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function readSkillInterfaceMetadata(skillRoot: string): SkillInterfaceMetadata | undefined {
  const file = join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const text = readFileSync(file, "utf8");
    return {
      displayName: readYamlInterfaceString(text, "display_name"),
      shortDescription: readYamlInterfaceString(text, "short_description"),
      defaultPrompt: readYamlInterfaceString(text, "default_prompt"),
    };
  } catch {
    return undefined;
  }
}

function readYamlInterfaceString(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s{2}${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m");
  const match = text.match(pattern);
  if (!match) {
    return undefined;
  }
  const value = stripQuotes((match[1] ?? "").trim());
  return value || undefined;
}

function loadSkillContent(manifest: SkillManifest, args: string | undefined, sessionId: string): LoadedSkill {
  const markdown = readFileSync(manifest.entry, "utf8");
  const parsed = parseFrontmatter(markdown);
  let content = `Base directory for this skill: ${manifest.skillRoot}\n\n${parsed.body.trim()}`;
  const normalizedArgs = args?.trim() || "";
  const namedArguments = extractNamedArguments(manifest.arguments, normalizedArgs);

  content = content
    .replace(new RegExp(`\\$\\{${APP_ENV_PREFIX}_SKILL_DIR\\}`, "g"), manifest.skillRoot)
    .replace(new RegExp(`\\$\\{${APP_ENV_PREFIX}_SESSION_ID\\}`, "g"), sessionId)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, manifest.skillRoot)
    .replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)
    .replace(/\$\{ARGUMENTS\}/g, normalizedArgs)
    .replace(/\$ARGUMENTS/g, normalizedArgs);

  for (const [key, value] of Object.entries(namedArguments)) {
    content = content
      .replace(new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, "g"), value)
      .replace(new RegExp(`\\$${escapeRegExp(key)}\\b`, "g"), value);
  }

  return {
    manifest: cloneSkill(manifest),
    content,
    sourcePath: manifest.entry,
    args: normalizedArgs || undefined,
  };
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
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
  const lines = rawFrontmatter.split("\n");
  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";
  let currentList: string[] | undefined;

  const flushList = () => {
    if (currentKey && currentList) {
      frontmatter[currentKey] = [...currentList];
    }
    currentList = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
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
    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]!.trimEnd();
        if (!nextLine.trim()) {
          blockLines.push("");
          index += 1;
          continue;
        }
        if (!/^\s+/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine);
        index += 1;
      }
      frontmatter[currentKey] = parseFrontmatterBlock(rawValue, blockLines);
      currentKey = "";
      continue;
    }
    frontmatter[currentKey] = parseFrontmatterValue(rawValue);
    currentKey = "";
  }

  flushList();
  return { frontmatter, body };
}

function parseFrontmatterBlock(style: string, lines: string[]): string {
  const nonEmptyLines = lines.filter((line) => line.trim());
  const indent = nonEmptyLines.reduce((minimum, line) => {
    const leadingWhitespace = line.match(/^\s*/)?.[0].length ?? 0;
    return Math.min(minimum, leadingWhitespace);
  }, Number.POSITIVE_INFINITY);
  const dedentBy = Number.isFinite(indent) ? indent : 0;
  const dedented = lines.map((line) => (line.trim() ? line.slice(dedentBy).trimEnd() : ""));
  if (style === ">") {
    return dedented.join(" ").replace(/\s+/g, " ").trim();
  }
  return dedented.join("\n").trim();
}

function parseFrontmatterValue(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => stripQuotes(entry.trim()))
      .filter(Boolean);
  }
  return stripQuotes(value);
}

function readDescription(frontmatter: Record<string, unknown>, body: string, skillName: string): string {
  const explicit = readString(frontmatter.description);
  if (explicit) {
    return explicit;
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));
  return lines[0] || `${titleFromName(skillName)} skill`;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function readSkillContext(value: unknown): SkillExecutionContext {
  return value === "fork" ? "fork" : "inline";
}

function readActivitySpaces(value: unknown): ActivitySpace[] {
  return readStringList(value).filter(
    (item): item is ActivitySpace =>
      item === "browser" || item === "chat" || item === "local" || item === "api" || item === "computer",
  );
}

function titleFromName(name: string): string {
  return name
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeSkillLookup(value: string): string {
  return value
    .trim()
    .replace(/^\//, "")
    .replace(/^skill\./, "");
}

function cloneSkill(skill: SkillManifest): SkillManifest {
  return {
    ...skill,
    aliases: skill.aliases ? [...skill.aliases] : undefined,
    allowedTools: [...skill.allowedTools],
    arguments: skill.arguments ? [...skill.arguments] : undefined,
    shell: skill.shell ? [...skill.shell] : undefined,
    paths: skill.paths ? [...skill.paths] : undefined,
    tags: skill.tags ? [...skill.tags] : undefined,
  };
}

function extractNamedArguments(argumentNames: string[] | undefined, args: string): Record<string, string> {
  if (!argumentNames || argumentNames.length === 0 || !args) {
    return {};
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  return Object.fromEntries(argumentNames.map((name, index) => [name, tokens[index] ?? ""]));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
