import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppEnv } from "../identity.js";
import { resolveCommandPath } from "../kernel/discovery.js";

const runtimeRequire = createRequire(import.meta.url);

export interface BundledClaudeEngineProbe {
  platform?: NodeJS.Platform;
  arch?: string;
  requireResolve?: (id: string) => string;
  // Whether the current Linux runtime links against musl (Alpine) rather than
  // glibc. Injectable for tests; resolved from the running process otherwise.
  isMuslLibc?: boolean;
}

export type ClaudeCodeCliPathSource = "override" | "bundled" | "external";

export interface ClaudeCodeCliPathResolution {
  path: string;
  source: ClaudeCodeCliPathSource;
}

let bundledClaudeEngineCacheReady = false;
let bundledClaudeEngineCache: string | undefined;

export function resolveClaudeCodeCliPath(cwd: string = process.cwd()): string | undefined {
  return resolveClaudeCodeCliPathDetailed(cwd)?.path;
}

export function resolveClaudeCodeCliPathDetailed(cwd: string = process.cwd()): ClaudeCodeCliPathResolution | undefined {
  const envPath = readAppEnv("CLAUDE_CLI_PATH")?.trim();
  const resolvedEnvPath = resolveClaudeCliCandidate(envPath);
  if (envPath) {
    return resolvedEnvPath ? { path: resolvedEnvPath, source: "override" } : undefined;
  }

  const bundledEngine = resolveBundledClaudeEngine();
  if (bundledEngine) {
    return { path: bundledEngine, source: "bundled" };
  }

  const desktopClaude = resolveClaudeDesktopBundledCliPath();
  if (desktopClaude) {
    return { path: desktopClaude, source: "external" };
  }

  const systemClaude = resolveClaudeCliCandidate("claude");
  if (systemClaude) {
    return { path: systemClaude, source: "external" };
  }

  for (const candidate of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]) {
    if (existsSync(candidate)) {
      return { path: candidate, source: "external" };
    }
  }

  const candidates = new Set<string>();
  for (const base of ancestorDirs(cwd)) {
    candidates.add(
      resolve(base, "reference-projects", "reference-projects", "claude-code-sourcemap", "package", "cli.js"),
    );
    candidates.add(resolve(base, "claude-code-sourcemap", "package", "cli.js"));
  }

  const fileDir = dirname(fileURLToPath(import.meta.url));
  candidates.add(
    resolve(
      fileDir,
      "..",
      "..",
      "reference-projects",
      "reference-projects",
      "claude-code-sourcemap",
      "package",
      "cli.js",
    ),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, source: "external" };
    }
  }
  return undefined;
}

export function resolveBundledClaudeEngine(probe: BundledClaudeEngineProbe = {}): string | undefined {
  const useCache = !hasBundledClaudeEngineProbe(probe);
  if (useCache && bundledClaudeEngineCacheReady) {
    return bundledClaudeEngineCache;
  }
  const resolved = resolveBundledClaudeEngineUncached(probe);
  if (useCache) {
    bundledClaudeEngineCacheReady = true;
    bundledClaudeEngineCache = resolved;
  }
  return resolved;
}

function resolveBundledClaudeEngineUncached(probe: BundledClaudeEngineProbe): string | undefined {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const requireResolve = probe.requireResolve ?? runtimeRequire.resolve;
  const binaryName = platform === "win32" ? "claude.exe" : "claude";
  const packageIds = linuxOrSinglePackageIds(platform, arch, binaryName, probe);

  for (const packageId of packageIds) {
    try {
      const resolved = requireResolve(packageId);
      const executablePath = resolveAsarUnpackedPath(resolved);
      if (existsSync(executablePath)) {
        return executablePath;
      }
    } catch (error) {
      if (!isModuleMissingError(error)) {
        logBundledClaudeEngineResolveWarning(packageId, error);
      }
    }
  }

  return undefined;
}

// The Claude Agent SDK ships separate glibc and musl binaries for the same Linux
// arch, and npm installs both optional packages regardless of the host libc.
// Selecting purely by "file exists" picks whichever variant is listed first,
// which spawns a musl binary on a glibc host (its /lib/ld-musl-* loader is
// absent) and fails to launch. So on Linux we order the candidates by the host's
// actual libc and never fall back across the glibc/musl boundary — a mismatched
// variant is unrunnable, not a second choice.
function linuxOrSinglePackageIds(
  platform: NodeJS.Platform,
  arch: string,
  binaryName: string,
  probe: BundledClaudeEngineProbe,
): string[] {
  if (platform !== "linux") {
    return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${binaryName}`];
  }
  const muslId = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/${binaryName}`;
  const glibcId = `@anthropic-ai/claude-agent-sdk-linux-${arch}/${binaryName}`;
  const isMusl = probe.isMuslLibc ?? isMuslRuntime();
  return isMusl ? [muslId] : [glibcId];
}

// glibc builds expose a runtime version in the process report header; musl builds
// leave it undefined. This is the standard Node way to distinguish the two.
function isMuslRuntime(): boolean {
  const report = process.report?.getReport();
  const header = typeof report === "object" ? (report as { header?: unknown }).header : undefined;
  const glibcVersion =
    typeof header === "object" && header !== null
      ? (header as { glibcVersionRuntime?: unknown }).glibcVersionRuntime
      : undefined;
  return typeof glibcVersion !== "string";
}

function hasBundledClaudeEngineProbe(probe: BundledClaudeEngineProbe): boolean {
  return (
    probe.platform !== undefined ||
    probe.arch !== undefined ||
    probe.requireResolve !== undefined ||
    probe.isMuslLibc !== undefined
  );
}

function isModuleMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function logBundledClaudeEngineResolveWarning(packageId: string, error: unknown): void {
  const code = errorCode(error) ?? "unknown";
  console.warn(`[opengrove] bundled Claude engine resolve failed for ${packageId}; code=${code}`);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function resolveAsarUnpackedPath(path: string): string {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!path.includes(asarSegment)) {
    return path;
  }
  return path.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
}

function resolveClaudeDesktopBundledCliPath(): string | undefined {
  const root = join(homedir(), "Library", "Application Support", "Claude-3p", "claude-code");
  try {
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDesc);
    for (const version of versions) {
      const candidate = join(root, version, "claude.app", "Contents", "MacOS", "claude");
      const resolved = resolveClaudeCliCandidate(candidate);
      if (resolved) return resolved;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (diff) return diff;
  }
  return right.localeCompare(left);
}

function versionParts(value: string): number[] {
  return value
    .split(/[^0-9]+/g)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function resolveClaudeCliCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveCommandPath(trimmed);
}

function ancestorDirs(start: string): string[] {
  const result: string[] = [];
  let current = resolve(start || process.cwd());
  while (true) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return result;
}
