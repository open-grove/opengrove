import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appCliTargetKey, resolveAppCliTargetPath, validateAppCliTargetFile } from "../app-builder/cli-targets.js";
import {
  appCliNodeScriptArgument,
  isAppCliExplicitPath,
  normalizeAppCliDeclaration,
  type NormalizedAppCliDeclaration,
  resolveAppCliOwnedPath,
  splitAppCliCommandLine,
} from "../app-builder/cli-declaration.js";
import type { JsonObject } from "../core.js";
import { mountedAppMemberId } from "../rooms/room-pm.js";
import { hostMessage } from "../localization/host-messages.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../localization/locale-registry.js";
import { resolveHostCommandPath } from "../environment/command-path.js";
import { resolveCommandInvocation } from "../kernel/discovery.js";
import type { BridgeState } from "./bridge-types.js";
import { resolveMountedAppTarget } from "./mounted-apps.js";

export interface AppCliEnvResolution {
  appId: string;
  appRoot: string;
  env: NodeJS.ProcessEnv;
  injectedEnv: string[];
  missingEnv: AppCliMissingEnv[];
  doctors: AppCliDoctor[];
}

export interface AppCliMissingEnv {
  cliId: string;
  env: string[];
  doctor?: string;
}

export interface AppCliReadiness {
  ok: boolean;
  message?: string;
}

export interface AppCliHostRuntime {
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execPath: string;
  tempRoot: string;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface AppCliCommandInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface AppCliDeclaredCommandExecution {
  invocation: AppCliCommandInvocation;
  appCliEnv: AppCliEnvResolution;
  commandCliEnv: AppCliEnvResolution;
}

interface AppCliDoctor {
  cliId: string;
  invocation: CliDoctorInvocation;
}

type CliDoctorInvocation = { kind: "exec"; command: string; args: string[]; env?: NodeJS.ProcessEnv; display: string };

interface CliDeclaration {
  id: string;
  executable?: string;
  executableArgs: string[];
  declaredCommands: string[];
  resolutionError?: string;
  envNames: string[];
  doctor?: CliDoctorInvocation;
  employees: string[];
}

const DOCTOR_TIMEOUT_MS = 20_000;
const DOCTOR_CACHE_TTL_MS = 5 * 60_000;
const MAX_DOCTOR_CACHE_ENTRIES = 100;
const cliDoctorCache = new Map<string, { expiresAt: number; result: Promise<{ ok: boolean; detail: string }> }>();

export class AppCliCommandResolutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function resolveMountedAppCliEnv(
  state: BridgeState,
  appId: string | undefined,
  memberId?: string,
  baseEnv: NodeJS.ProcessEnv = {},
  hostRuntime: AppCliHostRuntime = currentHostRuntime(),
): AppCliEnvResolution | undefined {
  const requestedAppId = appId?.trim();
  if (!requestedAppId) return undefined;
  const target = resolveMountedAppTarget(state, requestedAppId);
  if (!target) return undefined;
  const declarations = readCliDeclarations(target.appRoot, target.manifest, hostRuntime).filter((declaration) =>
    cliDeclarationAppliesToMember(declaration, target.id, memberId),
  );
  return resolveAppCliEnv(target.id, target.appRoot, declarations, baseEnv, hostRuntime);
}

function scopeAppCliEnvResolution(resolution: AppCliEnvResolution, cliId: string): AppCliEnvResolution {
  const requestedCliId = cliId.trim();
  return {
    ...resolution,
    missingEnv: resolution.missingEnv.filter((item) => item.cliId === requestedCliId),
    doctors: resolution.doctors.filter((item) => item.cliId === requestedCliId),
  };
}

function resolveAppCliEnv(
  appId: string,
  appRoot: string,
  declarations: CliDeclaration[],
  baseEnv: NodeJS.ProcessEnv,
  hostRuntime: AppCliHostRuntime,
): AppCliEnvResolution | undefined {
  if (declarations.length === 0) return undefined;

  const env: NodeJS.ProcessEnv = {};
  const injectedEnv: string[] = [];
  const missingEnv: AppCliMissingEnv[] = [];
  const pathPrepends: string[] = [];

  for (const declaration of declarations) {
    if (declaration.executable && existsSync(declaration.executable)) {
      pathPrepends.push(dirname(declaration.executable));
    }
    const missing: string[] = [];
    for (const envName of declaration.envNames) {
      const value = baseEnv[envName]?.trim() || process.env[envName]?.trim();
      if (value) {
        env[envName] = value;
        injectedEnv.push(envName);
      } else {
        missing.push(envName);
      }
    }
    if (missing.length > 0) {
      missingEnv.push({
        cliId: declaration.id,
        env: missing,
        ...(declaration.doctor ? { doctor: declaration.doctor.display } : {}),
      });
    }
  }

  if (pathPrepends.length > 0) {
    const windowsCliShim =
      hostRuntime.platform === "win32" ? windowsNodeCliShimDir(appId, appRoot, declarations, hostRuntime) : undefined;
    if (windowsCliShim) pathPrepends.unshift(windowsCliShim);
    const basePath = baseEnv.PATH ?? hostRuntime.environment?.PATH ?? process.env.PATH ?? "";
    const nodeDir = nodeRuntimeDir(basePath, hostRuntime);
    if (nodeDir) pathPrepends.push(nodeDir);
    env.PATH = [...new Set(pathPrepends), basePath].filter(Boolean).join(pathDelimiter(hostRuntime.platform));
    injectedEnv.push("PATH");
  }

  return {
    appId,
    appRoot,
    env,
    injectedEnv: [...new Set(injectedEnv)].sort(),
    missingEnv,
    doctors: declarations
      .filter((declaration): declaration is CliDeclaration & { doctor: CliDoctorInvocation } =>
        Boolean(declaration.doctor),
      )
      .map((declaration) => ({ cliId: declaration.id, invocation: declaration.doctor })),
  };
}

export function resolveMountedAppCliCommand(
  state: BridgeState,
  appId: string,
  command: string,
  args: string[],
  hostRuntime: AppCliHostRuntime = currentHostRuntime(),
): AppCliCommandInvocation | undefined {
  const target = resolveMountedAppTarget(state, appId.trim());
  if (!target) return undefined;
  const requestedCommand = command.trim();
  const declaration = readCliDeclarations(target.appRoot, target.manifest, hostRuntime).find((candidate) =>
    candidate.declaredCommands.includes(requestedCommand),
  );
  return declarationInvocation(declaration, args, hostRuntime);
}

export function resolveMountedAppDeclaredCliCommand(
  state: BridgeState,
  appId: string,
  commandId: string,
  args: string[],
  hostRuntime: AppCliHostRuntime = currentHostRuntime(),
): AppCliCommandInvocation | undefined {
  const target = resolveMountedAppTarget(state, appId.trim());
  if (!target) return undefined;
  const declaration = readCliDeclarations(target.appRoot, target.manifest, hostRuntime).find(
    (candidate) => candidate.id === commandId.trim(),
  );
  return declarationInvocation(declaration, args, hostRuntime);
}

export function resolveMountedAppDeclaredCliExecution(
  state: BridgeState,
  appId: string,
  commandId: string,
  args: string[],
  baseEnv: NodeJS.ProcessEnv = {},
  hostRuntime: AppCliHostRuntime = currentHostRuntime(),
): AppCliDeclaredCommandExecution | undefined {
  const target = resolveMountedAppTarget(state, appId.trim());
  if (!target) return undefined;
  const declarations = readCliDeclarations(target.appRoot, target.manifest, hostRuntime);
  const requestedCommandId = commandId.trim();
  const declaration = declarations.find((candidate) => candidate.id === requestedCommandId);
  const invocation = declarationInvocation(declaration, args, hostRuntime);
  if (!invocation) return undefined;
  const appCliEnv = resolveAppCliEnv(target.id, target.appRoot, declarations, baseEnv, hostRuntime);
  if (!appCliEnv) return undefined;
  return {
    invocation,
    appCliEnv,
    commandCliEnv: scopeAppCliEnvResolution(appCliEnv, requestedCommandId),
  };
}

export function resolveMountedAppCliCommandId(
  state: BridgeState,
  appId: string,
  declaredCommand: string,
  hostRuntime: AppCliHostRuntime = currentHostRuntime(),
): string | undefined {
  const target = resolveMountedAppTarget(state, appId.trim());
  if (!target) return undefined;
  const requestedCommand = declaredCommand.trim();
  return readCliDeclarations(target.appRoot, target.manifest, hostRuntime).find((candidate) =>
    candidate.declaredCommands.includes(requestedCommand),
  )?.id;
}

function declarationInvocation(
  declaration: CliDeclaration | undefined,
  args: string[],
  hostRuntime: AppCliHostRuntime,
): AppCliCommandInvocation | undefined {
  if (!declaration) return undefined;
  if (declaration.resolutionError) throw new AppCliCommandResolutionError(declaration.resolutionError);
  if (!declaration.executable) return undefined;
  const invocationArgs = [...declaration.executableArgs, ...args];
  if (isNodeScript(declaration.executable)) {
    return embeddedNodeInvocation(declaration.executable, invocationArgs, hostRuntime);
  }
  return resolveCommandInvocation(declaration.executable, invocationArgs, {
    platform: hostRuntime.platform,
    environment: hostRuntime.environment,
  });
}

export async function ensureMountedAppCliReady(
  resolution: AppCliEnvResolution,
  language: SupportedLocale = DEFAULT_LOCALE,
): Promise<AppCliReadiness> {
  const failures: string[] = [];
  const doctorIds = new Set(resolution.doctors.map((doctor) => doctor.cliId));
  for (const missing of resolution.missingEnv) {
    if (!doctorIds.has(missing.cliId)) {
      failures.push(
        hostMessage(language, "app.cli.missing_env", {
          cliId: missing.cliId,
          env: missing.env.join(", "),
        }),
      );
    }
  }
  for (const doctor of resolution.doctors) {
    const result = await runCachedCliDoctor(resolution, doctor);
    if (result.ok) continue;
    const missing = resolution.missingEnv.find((item) => item.cliId === doctor.cliId);
    failures.push(
      missing
        ? hostMessage(language, "app.cli.missing_env_and_check_failed", {
            cliId: doctor.cliId,
            env: missing.env.join(", "),
            detail: result.detail,
          })
        : hostMessage(language, "app.cli.check_failed", {
            cliId: doctor.cliId,
            detail: result.detail,
          }),
    );
  }
  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    message: hostMessage(language, "app.cli.preflight_failed", {
      failures: failures.map((line) => `- ${line}`).join("\n"),
    }),
  };
}

async function runCachedCliDoctor(
  resolution: AppCliEnvResolution,
  doctor: AppCliDoctor,
): Promise<{ ok: boolean; detail: string }> {
  const now = Date.now();
  const key = cliDoctorCacheKey(resolution, doctor);
  const cached = cliDoctorCache.get(key);
  if (cached && cached.expiresAt > now) return await cached.result;
  if (cached) cliDoctorCache.delete(key);
  const result = runCliDoctor(doctor.invocation, resolution.appRoot, resolution.env);
  cliDoctorCache.set(key, { expiresAt: now + DOCTOR_CACHE_TTL_MS, result });
  pruneCliDoctorCache(now);
  return await result;
}

function cliDoctorCacheKey(resolution: AppCliEnvResolution, doctor: AppCliDoctor): string {
  const invocation = doctor.invocation;
  const environment = Object.entries({ ...process.env, ...resolution.env, ...(invocation.env ?? {}) })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  const source = JSON.stringify({
    appId: resolution.appId,
    appRoot: resolution.appRoot,
    cliId: doctor.cliId,
    command: invocation.command,
    args: invocation.args,
    environment,
    executable: doctorExecutableFingerprint(invocation, resolution.appRoot),
  });
  return createHash("sha256").update(source).digest("hex");
}

function doctorExecutableFingerprint(invocation: CliDoctorInvocation, appRoot: string): string[] {
  const commandName = basename(invocation.command).toLowerCase();
  const windowsShellScript =
    (commandName === "cmd" || commandName === "cmd.exe") &&
    invocation.args[0] === "/d" &&
    invocation.args[1] === "/s" &&
    invocation.args[2] === "/c"
      ? invocation.args[3]
      : undefined;
  const candidates = [
    invocation.command,
    invocation.env?.ELECTRON_RUN_AS_NODE === "1" ? invocation.args[0] : undefined,
    windowsShellScript,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.map((candidate) => {
    try {
      const stat = statSync(candidate);
      const relativePath = relative(appRoot, candidate);
      const appOwned = relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
      const content =
        appOwned && stat.isFile() ? createHash("sha256").update(readFileSync(candidate)).digest("hex") : "";
      return `${candidate}:${stat.size}:${stat.mtimeMs}:${content}`;
    } catch {
      return `${candidate}:missing`;
    }
  });
}

function pruneCliDoctorCache(now: number): void {
  for (const [key, cached] of cliDoctorCache) {
    if (cached.expiresAt <= now) cliDoctorCache.delete(key);
  }
  while (cliDoctorCache.size > MAX_DOCTOR_CACHE_ENTRIES) {
    const oldest = cliDoctorCache.keys().next().value as string | undefined;
    if (!oldest) return;
    cliDoctorCache.delete(oldest);
  }
}

async function runCliDoctor(
  invocation: CliDoctorInvocation,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const done = (error: Error | null, stdout: string, stderr: string) => {
      if (!error) {
        resolvePromise({ ok: true, detail: stdout.trim() });
        return;
      }
      const detail = (stderr.trim() || stdout.trim() || error.message).split("\n").slice(-3).join(" ");
      resolvePromise({ ok: false, detail });
    };
    const options = {
      timeout: DOCTOR_TIMEOUT_MS,
      cwd,
      env: { ...process.env, ...extraEnv, ...(invocation.env ?? {}) },
      encoding: "utf8" as const,
      windowsHide: true,
    };
    execFile(invocation.command, invocation.args, options, done);
  });
}

function readCliDeclarations(appRoot: string, manifest: JsonObject, hostRuntime: AppCliHostRuntime): CliDeclaration[] {
  const capabilities = recordValue(manifest.capabilities);
  const entries = Array.isArray(capabilities.cli) ? capabilities.cli : [];
  const declarations: CliDeclaration[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    const object = recordValue(entry);
    const { executable, executableArgs, resolutionError } = resolveCliExecutable(appRoot, object, hostRuntime);
    const id =
      stringValue(object.id) ||
      stringValue(object.name) ||
      stringValue(object.bin) ||
      stringValue(object.command).split(/\s+/)[0] ||
      (executable ? (executable.split("/").pop() ?? "") : "");
    if (!id) continue;
    const doctor = resolveDoctorInvocation(appRoot, object.doctor, executable, executableArgs, hostRuntime);
    declarations.push({
      id,
      ...(executable ? { executable } : {}),
      executableArgs,
      declaredCommands: [id, stringValue(object.command), stringValue(object.path), stringValue(object.bin)].filter(
        Boolean,
      ),
      ...(resolutionError ? { resolutionError } : {}),
      envNames: normalizeEnvNames([...rawStringArray(object.env), ...rawStringArray(object.envKeys)]),
      ...(doctor ? { doctor } : {}),
      employees: rawStringArray(object.employees),
    });
  }
  return declarations;
}

// Declarations name their CLI as `path`, `command` (possibly with base args), or a bare `bin`
// name expected under the app. All relative paths resolve against the app root.
function resolveCliExecutable(
  appRoot: string,
  object: Record<string, unknown>,
  hostRuntime: AppCliHostRuntime,
): { executable?: string; executableArgs: string[]; resolutionError?: string } {
  const fixedArgs = rawStringArray(object.args);
  const targets = recordValue(object.targets);
  if (Object.keys(targets).length > 0) {
    const runtimeArch = hostRuntime.arch ?? process.arch;
    const target = appCliTargetKey(hostRuntime.platform, runtimeArch);
    if (!target) {
      return {
        executableArgs: fixedArgs,
        resolutionError: `app_command_target_unsupported:${hostRuntime.platform}-${runtimeArch}`,
      };
    }
    const source = stringValue(targets[target]);
    if (!source) {
      return { executableArgs: fixedArgs, resolutionError: `app_command_target_missing:${target}` };
    }
    const executable = resolveAppCliTargetPath(appRoot, source);
    if (!executable) {
      return { executableArgs: fixedArgs, resolutionError: `app_command_target_outside_app:${target}` };
    }
    const issue = validateAppCliTargetFile(executable, target, {
      appRoot,
      hostPlatform: hostRuntime.platform,
    })[0];
    if (issue) {
      return {
        executableArgs: fixedArgs,
        resolutionError: `app_command_target_${issue.code}:${target}`,
      };
    }
    return { executable, executableArgs: fixedArgs };
  }
  const normalized = normalizeAppCliDeclaration(object);
  if (normalized?.source === "path") {
    const executable = resolveCliPath(appRoot, normalized.executable);
    const scriptResolution = resolveAppOwnedNodeScriptArgs(appRoot, normalized);
    return {
      ...(executable ? { executable } : {}),
      executableArgs: scriptResolution.args,
      ...(scriptResolution.error ? { resolutionError: scriptResolution.error } : {}),
    };
  }
  if (normalized?.source === "command") {
    const executable = resolveMountedAppCommand(appRoot, normalized.executable, hostRuntime);
    const scriptResolution = resolveAppOwnedNodeScriptArgs(appRoot, normalized);
    return {
      ...(executable ? { executable } : {}),
      executableArgs: scriptResolution.args,
      ...(scriptResolution.error ? { resolutionError: scriptResolution.error } : {}),
    };
  }
  if (normalized?.source === "bin" && !normalized.executable.includes("/")) {
    const bin = normalized.executable;
    for (const candidate of [join(appRoot, "bin", bin), join(appRoot, bin)]) {
      if (existsSync(candidate)) return { executable: candidate, executableArgs: normalized.fixedArgs };
    }
    const executable = resolveHostCommandPath(bin, {
      platform: hostRuntime.platform,
      path: hostRuntime.environment?.PATH,
      userHome: hostRuntime.userHome,
      execPath: hostRuntime.execPath,
      environment: hostRuntime.environment,
    });
    if (executable) return { executable, executableArgs: normalized.fixedArgs };
  }
  return { executableArgs: fixedArgs };
}

// `doctor: ["doctor"]` (and bare single words) are subcommands of the declared CLI —
// the established manifest shape (see app-builder/importer.ts). Strings with whitespace
// or a path prefix are standalone commands. They are always executed with an argv array.
function resolveDoctorInvocation(
  appRoot: string,
  value: unknown,
  executable: string | undefined,
  executableArgs: string[],
  hostRuntime: AppCliHostRuntime,
): CliDoctorInvocation | undefined {
  const stringDoctor = typeof value === "string";
  const entries = stringDoctor
    ? splitAppCliCommandLine(value.trim())
    : rawStringArray(value)
        .map((item) => item.trim())
        .filter(Boolean);
  const first = entries[0];
  if (!first) return undefined;

  const isStandaloneCommand = stringDoctor && (entries.length > 1 || isAppCliExplicitPath(first));
  if (isStandaloneCommand) {
    const command = isAppCliExplicitPath(first)
      ? resolveCliPath(appRoot, first)
      : resolveMountedAppCommand(appRoot, first, hostRuntime);
    if (!command) return undefined;
    const args = entries.slice(1);
    if (isNodeScript(command)) {
      const invocation = embeddedNodeInvocation(command, args, hostRuntime);
      return { kind: "exec", ...invocation, display: [command, ...args].join(" ") };
    }
    const invocation = resolveCommandInvocation(command, args, {
      platform: hostRuntime.platform,
      environment: hostRuntime.environment,
    });
    return { kind: "exec", ...invocation, display: [command, ...args].join(" ") };
  }

  if (!executable) return undefined;
  const args = [...executableArgs, ...entries];
  if (isNodeScript(executable)) {
    const invocation = embeddedNodeInvocation(executable, args, hostRuntime);
    return {
      kind: "exec",
      ...invocation,
      display: [executable, ...args].join(" "),
    };
  }
  const invocation = resolveCommandInvocation(executable, args, {
    platform: hostRuntime.platform,
    environment: hostRuntime.environment,
  });
  return { kind: "exec", ...invocation, display: [executable, ...args].join(" ") };
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_\-./]/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value;
}

// App CLI（如 story-seed）多为 `#!/usr/bin/env node` 脚本，但员工环境的 PATH 不一定
// 带 node（Finder 启动的打包版继承的是 launchd 的最小 PATH）。桥自己就跑在 Node 运行
// 时上，所以在 PATH 缺 node 时把它保证进去：纯 node 启动直接前置其目录；Electron 打包
// 版（execPath 是应用本体）落一个 ELECTRON_RUN_AS_NODE shim。
function nodeRuntimeDir(basePath: string, hostRuntime: AppCliHostRuntime): string | undefined {
  const nodeNames = hostRuntime.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];
  const hasNode = basePath
    .split(pathDelimiter(hostRuntime.platform))
    .some((dir) => dir && nodeNames.some((name) => existsSync(join(dir, name))));
  if (hasNode) return undefined;
  const execDir = dirname(hostRuntime.execPath);
  if (nodeNames.some((name) => existsSync(join(execDir, name)))) return execDir;
  return electronNodeShimDir(hostRuntime);
}

function electronNodeShimDir(hostRuntime: AppCliHostRuntime): string | undefined {
  try {
    const dir = join(hostRuntime.tempRoot, `opengrove-node-shim-${process.getuid?.() ?? "0"}`);
    const shim = join(dir, hostRuntime.platform === "win32" ? "node.cmd" : "node");
    const script =
      hostRuntime.platform === "win32"
        ? `@echo off\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${batchQuote(hostRuntime.execPath)} %*\r\n`
        : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(hostRuntime.execPath)} "$@"\n`;
    if (!existsSync(shim) || readFileSync(shim, "utf8") !== script) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(shim, script, { mode: 0o755 });
    }
    if (hostRuntime.platform !== "win32") {
      // 内容相同但权限被改坏的残留 shim 也要修回可执行。
      chmodSync(shim, 0o755);
    }
    return dir;
  } catch {
    return undefined;
  }
}

function windowsNodeCliShimDir(
  appId: string,
  appRoot: string,
  declarations: CliDeclaration[],
  hostRuntime: AppCliHostRuntime,
): string | undefined {
  const nodeDeclarations = declarations.filter(
    (declaration): declaration is CliDeclaration & { executable: string } =>
      Boolean(declaration.executable) && isNodeScript(declaration.executable!),
  );
  if (nodeDeclarations.length === 0) return undefined;
  try {
    const appKey = `${slug(appId) || "app"}-${createHash("sha256").update(appRoot).digest("hex").slice(0, 12)}`;
    const dir = join(hostRuntime.tempRoot, "opengrove-app-cli-shims", appKey);
    mkdirSync(dir, { recursive: true });
    for (const declaration of nodeDeclarations) {
      const aliases = new Set([declaration.id, basename(declaration.executable)]);
      const fixedArgs = declaration.executableArgs.map(batchQuote).join(" ");
      const script = [
        "@echo off",
        "chcp 65001 >nul",
        'set "ELECTRON_RUN_AS_NODE=1"',
        `${batchQuote(hostRuntime.execPath)} ${batchQuote(declaration.executable)}${fixedArgs ? ` ${fixedArgs}` : ""} %*`,
        "",
      ].join("\r\n");
      for (const alias of aliases) {
        if (!/^[A-Za-z0-9._-]+$/.test(alias)) continue;
        const shim = join(dir, `${alias}.cmd`);
        if (!existsSync(shim) || readFileSync(shim, "utf8") !== script) {
          writeFileSync(shim, script, "utf8");
        }
      }
    }
    return dir;
  } catch {
    return undefined;
  }
}

function embeddedNodeInvocation(
  script: string,
  args: string[],
  hostRuntime: AppCliHostRuntime,
): AppCliCommandInvocation {
  return {
    command: hostRuntime.execPath,
    args: [script, ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function resolveAppOwnedNodeScriptArgs(
  appRoot: string,
  declaration: NormalizedAppCliDeclaration,
): { args: string[]; error?: string } {
  const script = appCliNodeScriptArgument(declaration);
  if (!script) return { args: declaration.fixedArgs };
  const resolution = resolveAppCliOwnedPath(appRoot, script.value);
  if (!resolution.ok && resolution.error === "outside") {
    return { args: declaration.fixedArgs, error: "app_command_script_outside_app" };
  }
  if (!resolution.ok) {
    return { args: declaration.fixedArgs, error: "app_command_script_missing" };
  }
  const args = [...declaration.fixedArgs];
  args[script.index] = resolution.path;
  return { args };
}

function isNodeScript(file: string): boolean {
  try {
    return /^#![^\r\n]*\bnode\b/.test(readFileSync(file, "utf8").slice(0, 512));
  } catch {
    return false;
  }
}

function batchQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function currentHostRuntime(): AppCliHostRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    tempRoot: tmpdir(),
    userHome: homedir(),
    environment: process.env,
  };
}

function cliDeclarationAppliesToMember(
  declaration: CliDeclaration,
  appId: string,
  memberId: string | undefined,
): boolean {
  if (declaration.employees.length === 0) return true;
  if (!memberId) return true;
  return declaration.employees.some((employee) => {
    return memberId === employee || memberId === mountedAppMemberId(appId, employee);
  });
}

function resolveCliPath(appRoot: string, path: string): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? path : resolve(appRoot, path);
}

function resolveMountedAppCommand(
  appRoot: string,
  command: string,
  hostRuntime: AppCliHostRuntime,
): string | undefined {
  if (!command) return undefined;
  if (isAbsolute(command)) return command;
  if (command.startsWith(".") || command.includes("/")) return resolve(appRoot, command);
  const appBinCommand = join(appRoot, "bin", command);
  if (existsSync(appBinCommand)) return appBinCommand;
  return (
    resolveHostCommandPath(command, {
      platform: hostRuntime.platform,
      path: hostRuntime.environment?.PATH,
      userHome: hostRuntime.userHome,
      execPath: hostRuntime.execPath,
      environment: hostRuntime.environment,
    }) ?? command
  );
}

function rawStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeEnvNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
