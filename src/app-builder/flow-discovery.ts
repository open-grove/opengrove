import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { isFlowMarkdownPath, parseFlowMarkdown, type FlowFrontmatter } from "./flow.js";

const DEFAULT_MAX_FLOW_ENTRIES = 500;
const DEFAULT_MAX_TREE_DEPTH = 8;

export interface MountedAppFlowRecord {
  path: string;
  frontmatter?: FlowFrontmatter;
  rawFrontmatter?: Record<string, unknown>;
  valid: boolean;
  issues: string[];
  mtime: string;
}

export interface FlowApprovalReference {
  flowId: string;
  stepId: string;
}

export interface FlowDiscoveryOptions {
  maxEntries?: number;
  maxDepth?: number;
}

export function listMountedAppFlows(workspaceRoot: string, options: FlowDiscoveryOptions = {}): MountedAppFlowRecord[] {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    return [];
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_FLOW_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_TREE_DEPTH;
  const files: string[] = [];
  collectFlowFiles(root, "", 0, files, maxEntries, maxDepth);

  return files
    .flatMap((absolutePath) => {
      const relativePath = normalizeRelativePath(relative(root, absolutePath));
      let mtime = new Date(0).toISOString();
      let source: string;
      try {
        const stat = statSync(absolutePath);
        mtime = stat.mtime.toISOString();
        source = readFileSync(absolutePath, "utf8");
      } catch (error) {
        if (!existsSync(absolutePath)) {
          return [];
        }
        return [
          {
            path: relativePath,
            valid: false,
            issues: [`flow file unreadable: ${errorMessage(error)}`],
            mtime,
          },
        ];
      }
      const parsed = parseFlowMarkdown(source);
      return {
        path: relativePath,
        frontmatter: parsed.frontmatter,
        rawFrontmatter: parsed.valid ? undefined : parsed.rawFrontmatter,
        valid: parsed.valid,
        issues: parsed.issues,
        mtime,
      };
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime));
}

export function hasFlowApprovalStep(flows: readonly MountedAppFlowRecord[], reference: FlowApprovalReference): boolean {
  return flows.some((flow) => {
    if (!flow.valid || !flow.frontmatter || !flowIdentifierMatches(flow.path, reference.flowId)) {
      return false;
    }
    return flow.frontmatter.steps.some(
      (step) => step.id === reference.stepId && step.owner === "user" && step.blocking === true,
    );
  });
}

export function flowIdentifierMatches(flowPath: string, flowId: string): boolean {
  const normalizedPath = flowPath.replace(/\\/g, "/");
  const pathWithoutSuffix = normalizedPath.replace(/\.flow\.md$/i, "");
  const fileName = basename(normalizedPath);
  const fileNameWithoutSuffix = fileName.replace(/\.flow\.md$/i, "");
  return (
    flowId === normalizedPath || flowId === pathWithoutSuffix || flowId === fileName || flowId === fileNameWithoutSuffix
  );
}

function collectFlowFiles(
  root: string,
  relativePath: string,
  depth: number,
  output: string[],
  maxEntries: number,
  maxDepth: number,
): void {
  if (depth > maxDepth || output.length >= maxEntries) {
    return;
  }
  const current = resolveInside(root, relativePath);
  if (!current) {
    return;
  }
  let stat;
  try {
    stat = statSync(current);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (isFlowMarkdownPath(current)) {
      output.push(current);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= maxEntries) {
      break;
    }
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    collectFlowFiles(root, childRelativePath, depth + 1, output, maxEntries, maxDepth);
  }
}

function resolveInside(root: string, relativePath: string): string | undefined {
  const rootPath = resolve(root);
  const resolved = resolve(rootPath, relativePath);
  const rootPrefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  if (resolved !== rootPath && !resolved.startsWith(rootPrefix)) {
    return undefined;
  }
  return resolved;
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
