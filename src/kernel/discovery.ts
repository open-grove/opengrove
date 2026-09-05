import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, resolve } from "node:path";
import type {
  KernelExecutableProbe,
  KernelExecutableProbeSource,
  KernelExecutableRole,
  KernelHealth,
  KernelInstallAction,
  KernelKnowledgeSource,
  KernelKnowledgeSourceKind,
  KernelKnowledgeSourceScope,
} from "./types.js";

export interface CommandProbeResult {
  status: "ok" | "timeout" | "failed";
  version?: string;
  exitCode?: number;
  errorCode?: string;
}

export interface CommandDiscoveryProbe {
  requestedCommand?: string;
  resolvedPath?: string;
  probe: CommandProbeResult;
}

const COMMAND_PROBE_CACHE = new Map<string, CommandProbeResult>();

export interface KernelSourceInput {
  id: string;
  title: string;
  kind: KernelKnowledgeSourceKind;
  scope: KernelKnowledgeSourceScope;
  path?: string;
  native?: boolean;
  userVisible?: boolean;
  knowledgeLike?: boolean;
  enabledByDefault?: boolean;
  syncMode?: KernelKnowledgeSource["syncMode"];
  description?: string;
  notes?: string[];
}

export interface CommandPathProbe {
  path?: string;
  platform?: NodeJS.Platform;
}

export interface CommandInvocationProbe {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  nodeScript?: boolean;
  nodePath?: string;
}

export function directorySource(input: KernelSourceInput): KernelKnowledgeSource {
  return pathSource(input, "directory");
}

export function fileSource(input: KernelSourceInput): KernelKnowledgeSource {
  return pathSource(input, "file");
}

export function plannedInstallAction(input: KernelInstallAction): KernelInstallAction {
  return {
    status: "manual",
    requiresConfirmation: true,
    ...input,
  };
}

export function resolveHomePath(...parts: string[]): string {
  return resolve(homedir(), ...parts);
}

export function resolveCommandPath(command: string | undefined, probe: CommandPathProbe = {}): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  const platform = probe.platform ?? process.platform;
  if (isPathLike(trimmed)) {
    return resolveExistingCommandPath(trimmed, platform);
  }
  return resolveCommandOnPath(trimmed, probe.path ?? process.env.PATH, platform);
}

export function resolveCommandInvocation(
  command: string,
  args: string[] = [],
  probe: CommandInvocationProbe = {},
): { command: string; args: string[] } {
  const platform = probe.platform ?? process.platform;
  const environment = probe.environment ?? process.env;
  const resolvedCommand =
    platform === "win32" && WINDOWS_PACKAGE_MANAGER_COMMANDS.has(command.toLowerCase()) ? `${command}.cmd` : command;
  const nodeScript = probe.nodeScript ?? NODE_SCRIPT_EXTENSIONS.has(extname(resolvedCommand).toLowerCase());
  if (nodeScript) {
    return {
      command: probe.nodePath || process.execPath,
      args: [resolvedCommand, ...args],
    };
  }
  if (platform === "win32" && WINDOWS_SHELL_EXTENSIONS.has(extname(resolvedCommand).toLowerCase())) {
    // Windows command scripts require cmd.exe after Node's CVE-2024-27980
    // hardening. This selects the required executable but does not escape cmd
    // metacharacters; each caller owns the trust and escaping policy for argv.
    return {
      command: environment.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", resolvedCommand, ...args],
    };
  }
  return { command: resolvedCommand, args };
}

export function commandVersion(command: string | undefined, args: string[] = ["--version"]): string | undefined {
  return commandProbe(command, args).version;
}

export function resolveUsableCommandPath(
  command: string | undefined,
  args: string[] = ["--version"],
  pathProbe: CommandPathProbe = {},
): string | undefined {
  const result = probeCommandPath(command, args, pathProbe);
  return result.resolvedPath && result.probe.status !== "failed" ? result.resolvedPath : undefined;
}

export function probeCommandPath(
  command: string | undefined,
  args: string[] = ["--version"],
  pathProbe: CommandPathProbe = {},
): CommandDiscoveryProbe {
  const requestedCommand = command?.trim() || undefined;
  const resolvedPath = resolveCommandPath(command, pathProbe);
  return {
    ...(requestedCommand ? { requestedCommand } : {}),
    resolvedPath,
    probe: resolvedPath ? commandProbe(resolvedPath, args) : { status: "failed" },
  };
}

export function commandProbeFailureText(probe: CommandProbeResult): string {
  if (probe.exitCode !== undefined) return `--version exited with code ${probe.exitCode}`;
  if (probe.errorCode) return `--version failed with ${probe.errorCode}`;
  return "--version probe failed";
}

export function kernelExecutableProbe(
  result: CommandDiscoveryProbe,
  options: {
    role: KernelExecutableRole;
    source?: KernelExecutableProbeSource;
    sourceName?: string;
  },
): KernelExecutableProbe {
  return {
    role: options.role,
    status: !result.resolvedPath ? "missing" : result.probe.status === "ok" ? "available" : result.probe.status,
    ...(result.resolvedPath ? { path: result.resolvedPath } : {}),
    ...(result.requestedCommand ? { requestedCommand: result.requestedCommand } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.sourceName ? { sourceName: options.sourceName } : {}),
    ...(result.probe.version ? { version: result.probe.version } : {}),
    ...(result.probe.exitCode !== undefined ? { exitCode: result.probe.exitCode } : {}),
    ...(result.probe.errorCode ? { errorCode: result.probe.errorCode } : {}),
  };
}

export function commandDiscoveryHealth(
  result: CommandDiscoveryProbe,
  options: {
    title: string;
    role: KernelExecutableRole;
    source?: KernelExecutableProbeSource;
    sourceName?: string;
    missingMessage?: string;
    runtimeStillAvailable?: string;
  },
): KernelHealth {
  const executableProbe = kernelExecutableProbe(result, options);
  const metadata = { executableProbe: { ...executableProbe } };
  const optional = options.role === "optional-diagnostic";
  const runtimeNote = options.runtimeStillAvailable ? ` ${options.runtimeStillAvailable}` : "";
  const explicitSource = options.source === "configured" || options.source === "environment";
  const sourceName =
    options.sourceName || (options.source === "configured" ? `Configured ${options.title} command` : undefined);
  const requestedCommand = result.requestedCommand;
  if (!result.resolvedPath) {
    if (optional) {
      const message =
        explicitSource && sourceName && requestedCommand
          ? `${sourceName} points to ${requestedCommand}, but that optional CLI could not be resolved.${runtimeNote}`
          : `${options.missingMessage ?? `The optional ${options.title} CLI was not found.`}${runtimeNote}`;
      return {
        status: "ok",
        message,
        metadata,
      };
    }
    const message =
      explicitSource && sourceName && requestedCommand
        ? `${sourceName} points to ${requestedCommand}, but that command could not be resolved. PATH fallback was intentionally not used.`
        : (options.missingMessage ?? `${options.title} CLI was not found.`);
    return { status: "unavailable", message, metadata };
  }
  if (result.probe.status === "failed") {
    const sourcePrefix =
      explicitSource && sourceName
        ? `${sourceName} resolved to ${result.resolvedPath}`
        : `${options.title} CLI was found at ${result.resolvedPath}`;
    const fallbackNote = explicitSource && !optional ? " PATH fallback was intentionally not used." : "";
    return {
      status: optional ? "degraded" : "unavailable",
      message: `${sourcePrefix}, but ${commandProbeFailureText(result.probe)}.${fallbackNote}${runtimeNote}`,
      metadata,
    };
  }
  if (result.probe.status === "timeout") {
    const message =
      explicitSource && sourceName
        ? `${sourceName} resolved to ${result.resolvedPath}, but its version check timed out; the command remains available.${runtimeNote}`
        : `${options.title} CLI version check timed out; the command remains available.${runtimeNote}`;
    return {
      status: "ok",
      message,
      metadata,
    };
  }
  return { status: "ok", message: `${options.title} CLI detected.`, metadata };
}

export function commandProbe(command: string | undefined, args: string[] = ["--version"]): CommandProbeResult {
  const resolvedCommand = resolveCommandPath(command) ?? command?.trim();
  if (!resolvedCommand) return { status: "failed" };
  const invocation = resolveCommandInvocation(resolvedCommand, args);
  const cacheKey = JSON.stringify([invocation.command, invocation.args, commandFileFingerprint(resolvedCommand)]);
  const cached = COMMAND_PROBE_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const version = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const probe: CommandProbeResult = timedOut
      ? { status: "timeout", ...(version ? { version } : {}) }
      : result.status === 0
        ? { status: "ok", ...(version ? { version } : {}) }
        : {
            status: "failed",
            ...(typeof result.status === "number" ? { exitCode: result.status } : {}),
            ...(errorCode ? { errorCode } : {}),
          };
    COMMAND_PROBE_CACHE.set(cacheKey, probe);
    return probe;
  } catch {
    const probe: CommandProbeResult = { status: "failed" };
    COMMAND_PROBE_CACHE.set(cacheKey, probe);
    return probe;
  }
}

function commandFileFingerprint(path: string): string | undefined {
  const stats = safeStat(path);
  if (!stats) return undefined;
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

export function clearCommandVersionCache(): void {
  COMMAND_PROBE_CACHE.clear();
}

function pathSource(input: KernelSourceInput, expected: "file" | "directory"): KernelKnowledgeSource {
  const path = input.path ? expandHome(input.path) : undefined;
  const exists = path ? existsSync(path) : false;
  const stats = exists && path ? safeStat(path) : undefined;
  const readable = Boolean(stats && (expected === "file" ? stats.isFile() : stats.isDirectory()));
  return {
    id: input.id,
    title: input.title,
    kind: input.kind,
    scope: input.scope,
    path,
    exists,
    readable,
    writable: Boolean(path && (stats?.isDirectory() || stats?.isFile() || existsSync(resolve(path, "..")))),
    native: input.native ?? true,
    userVisible: input.userVisible ?? true,
    knowledgeLike: input.knowledgeLike ?? true,
    enabledByDefault: input.enabledByDefault ?? true,
    syncMode: input.syncMode ?? "index",
    description: input.description,
    notes: input.notes,
  };
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_PACKAGE_MANAGER_COMMANDS = new Set(["corepack", "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"]);
const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function resolveExistingCommandPath(candidate: string, platform: NodeJS.Platform): string | undefined {
  const resolvedCandidate = resolve(candidate);
  const extension = extname(resolvedCandidate);
  if (extension) {
    return isFile(resolvedCandidate) ? resolvedCandidate : undefined;
  }
  if (platform === "win32") {
    for (const candidateWithExtension of candidateExtensions(resolvedCandidate, platform)) {
      if (isFile(candidateWithExtension)) {
        return candidateWithExtension;
      }
    }
  }
  return isFile(resolvedCandidate) ? resolvedCandidate : undefined;
}

function resolveCommandOnPath(
  command: string,
  path: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const pathEntries = path?.split(delimiter).filter(Boolean) ?? [];
  for (const entry of pathEntries) {
    const baseCandidate = resolve(entry, command);
    const extension = extname(baseCandidate);
    if (extension) {
      if (isExecutableFile(baseCandidate, platform)) {
        return baseCandidate;
      }
      continue;
    }
    if (platform === "win32") {
      for (const candidateWithExtension of candidateExtensions(baseCandidate, platform)) {
        if (isExecutableFile(candidateWithExtension, platform)) {
          return candidateWithExtension;
        }
      }
    }
    if (isExecutableFile(baseCandidate, platform)) {
      return baseCandidate;
    }
  }
  return undefined;
}

function candidateExtensions(command: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? windowsExecutableExtensions().map((extension) => `${command}${extension}`) : [command];
}

function windowsExecutableExtensions(): string[] {
  const configured = process.env.PATHEXT?.split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured?.length ? configured : [".com", ".exe", ".bat", ".cmd"];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  if (!isFile(path)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
