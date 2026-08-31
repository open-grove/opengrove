import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative } from "node:path";
import type { JsonObject, SkillManifest } from "../core.js";
import { APP_NATIVE_SKILL_MARKER_FILE, APP_PRODUCT_NAME } from "../identity.js";
import { skillKnowledgeId } from "../knowledge/skill-view.js";
import type { KnowledgeDocumentInput } from "../knowledge/types.js";

interface SkillTreeMetadataNode extends JsonObject {
  name: string;
  kind: "folder" | "file";
  path: string;
  entry: boolean;
  children: SkillTreeMetadataNode[];
}

const SKILL_TREE_IGNORED_NAMES = new Set([
  ".DS_Store",
  ".git",
  APP_NATIVE_SKILL_MARKER_FILE,
  ".opengrove-native.json",
  "node_modules",
]);

export function skillTreeMetadata(skill: SkillManifest): JsonObject {
  const children = readSkillTreeChildren(skill.skillRoot, skill.skillRoot, skill.entry, 0, { remaining: 80 });
  return {
    skillTree: {
      root: skill.name,
      entry: "SKILL.md",
      children,
    },
  };
}

export function skillFileKnowledgeDocuments(skill: SkillManifest): Array<KnowledgeDocumentInput & { id: string }> {
  const parentId = skillKnowledgeId(skill.id);
  const nodes = readSkillTreeChildren(skill.skillRoot, skill.skillRoot, skill.entry, 0, { remaining: 80 });
  return flattenSkillTreeFiles(nodes).flatMap((node) => {
    if (node.entry || !isReadableSkillTextFile(node.path)) return [];
    const absolutePath = join(skill.skillRoot, node.path);
    let body: string;
    try {
      body = readFileSync(absolutePath, "utf8");
    } catch {
      return [];
    }
    const trimmedBody =
      body.length > 60000 ? `${body.slice(0, 60000)}\n\n[Truncated by ${APP_PRODUCT_NAME} skill file preview]` : body;
    const title = `${skill.title || skill.name} / ${skillTreeDisplayName(node.path)}`;
    return [
      {
        id: skillFileKnowledgeId(skill.id, node.path),
        slug: `skill-${skill.name}-${skillFileSlug(node.path)}`,
        type: "source",
        title,
        body: trimmedBody,
        format: skillFileKnowledgeFormat(node.path),
        tags: ["skill", "skill-file", skill.name, skillFileExtensionTag(node.path)].filter(Boolean),
        links: [
          {
            targetId: parentId,
            relation: "part_of_skill",
            title: skill.title || skill.name,
          },
        ],
        sourceRefs: [
          {
            title,
            locator: absolutePath,
          },
        ],
        scope: skill.source === "user" ? "user" : skill.source === "project" ? "project" : "global",
        confidence: 0.95,
        lifecycle: "active",
        metadata: {
          parentSkillId: parentId,
          skillId: skill.id,
          skillName: skill.name,
          skillFilePath: node.path,
          skillFileName: node.name,
          skillFileExtension: extname(node.path).replace(/^\./, ""),
          source: skill.source,
          trust: skill.trust,
        },
      },
    ];
  });
}

function flattenSkillTreeFiles(nodes: SkillTreeMetadataNode[]): SkillTreeMetadataNode[] {
  return nodes.flatMap((node) => (node.kind === "folder" ? flattenSkillTreeFiles(node.children) : [node]));
}

function skillFileKnowledgeId(skillId: string, path: string): string {
  const cleanSkillId = skillId.replace(/^skill\./, "");
  const digest = createHash("sha1").update(path).digest("hex").slice(0, 10);
  return `skill.${cleanSkillId}.file.${digest}`;
}

function skillFileSlug(path: string): string {
  return (
    path
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "file"
  );
}

function skillFileKnowledgeFormat(path: string): "markdown" | "json" | "plain" {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".mdx") return "markdown";
  if (extension === ".json") return "json";
  return "plain";
}

function skillFileExtensionTag(path: string): string {
  const extension = extname(path).replace(/^\./, "").toLowerCase();
  return extension ? `file:${extension}` : "";
}

function isReadableSkillTextFile(path: string): boolean {
  return new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml"]).has(extname(path).toLowerCase());
}

function readSkillTreeChildren(
  root: string,
  dir: string,
  entryPath: string,
  depth: number,
  budget: { remaining: number },
): SkillTreeMetadataNode[] {
  if (depth > 2 || budget.remaining <= 0) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => !SKILL_TREE_IGNORED_NAMES.has(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      if (left.name === "SKILL.md") return 1;
      if (right.name === "SKILL.md") return -1;
      return left.name.localeCompare(right.name);
    })
    .flatMap((entry) => {
      if (budget.remaining <= 0) return [];
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath);
      if (!isSafeSkillTreePath(relativePath)) return [];
      budget.remaining -= 1;
      const isDirectory = entry.isDirectory();
      return [
        {
          name: skillTreeDisplayName(entry.name),
          kind: isDirectory ? "folder" : "file",
          path: relativePath,
          entry: sameFilePath(absolutePath, entryPath),
          children: isDirectory ? readSkillTreeChildren(root, absolutePath, entryPath, depth + 1, budget) : [],
        },
      ];
    });
}

function isSafeSkillTreePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("..") && !path.includes("/../") && !path.includes("\\..\\");
}

function sameFilePath(left: string, right: string): boolean {
  try {
    return statSync(left).isFile() && statSync(right).isFile() && left === right;
  } catch {
    return left === right;
  }
}

function skillTreeDisplayName(name: string): string {
  if (name === "SKILL.md") return "SKILL";
  if (name.endsWith(".md")) return name.slice(0, -3);
  return name;
}
