import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec } from "../core.js";

export interface AppCommandTarget {
  id: string;
  appRoot: string;
}

export interface AppCommandRunContext {
  resolveApp(appId: string): AppCommandTarget | undefined;
  resolveRuntimeEnv?(appId: string): NodeJS.ProcessEnv | undefined;
  resolveCommand(
    appId: string,
    commandId: string,
    args: string[],
  ): { command: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined;
}

export interface AppCommandProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnError: string;
  stdoutBytes: number;
  stderrBytes: number;
  capturedStdoutBytes: number;
  capturedStderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  resolvedCommand: string;
  resolvedArgs: string[];
}

export type AppCommandOutputResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: "command_output_not_json" | "structured_output_too_large" };

interface AppCommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  capturedStdoutBytes?: number;
  capturedStderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

interface AppCommandProcessOptions {
  platform?: NodeJS.Platform;
  execute?: (
    command: string,
    args: string[],
    cwd: string,
    runtimeEnv: NodeJS.ProcessEnv | undefined,
    spawnPolicy: { windowsHide: boolean },
  ) => Promise<AppCommandExecutionResult>;
}

const COMMAND_TIMEOUT_MS = 60 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const COMMAND_FAILURE_MAX_CHARS = 2_000;
const COMMAND_FAILURE_TRUNCATION_MARKER = "…[command_failure_truncated]";

export function createAppCommandRunTool(
  spec: ToolSpec,
  context: AppCommandRunContext,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input): Promise<ToolResult<JsonValue>> {
      const appId = stringValue(input.appId);
      const commandId = stringValue(input.commandId);
      const args = Array.isArray(input.args) ? input.args.map(String) : [];
      const cwdInput = stringValue(input.cwd);
      const parseJson = input.parseJson !== false;
      if (!appId) return { ok: false, error: "app_id_required" };
      if (!commandId) return { ok: false, error: "command_id_required" };
      if (args.length > 100 || args.some((arg) => Buffer.byteLength(arg) > 16_384)) {
        return { ok: false, error: "command_arguments_too_large" };
      }
      const app = context.resolveApp(appId);
      if (!app) return { ok: false, error: `app_not_found:${appId}` };
      const cwd = cwdInput ? resolveInside(app.appRoot, cwdInput) : app.appRoot;
      if (!cwd) return { ok: false, error: "cwd_outside_app" };
      let resolved;
      try {
        resolved = context.resolveCommand(app.id, commandId, args);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!resolved) return { ok: false, error: "app_command_not_declared" };
      const runtimeEnv = {
        ...(context.resolveRuntimeEnv?.(app.id) ?? {}),
        ...(resolved.env ?? {}),
      };
      const result = await runAppCommandProcess(resolved.command, resolved.args, cwd, runtimeEnv);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: formatAppCommandFailure(result),
        };
      }
      const output = buildAppCommandOutput(result, parseJson);
      if (!output.ok) return output;
      const value: JsonObject = {
        appId: app.id,
        commandId,
        args,
        cwd,
        ...output.value,
      };
      value.resolvedCommand = result.resolvedCommand;
      value.resolvedArgs = result.resolvedArgs;
      return { ok: true, value };
    },
  };
}

export function buildAppCommandOutput(result: AppCommandProcessResult, parseJson: boolean): AppCommandOutputResult {
  if (parseJson && result.stdoutTruncated) {
    return { ok: false, error: "structured_output_too_large" };
  }
  const value: JsonObject = {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    capturedStdoutBytes: result.capturedStdoutBytes,
    capturedStderrBytes: result.capturedStderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
  if (!parseJson) {
    value.stdout = result.stdout;
    return { ok: true, value };
  }
  if (!result.stdout.trim()) return { ok: true, value };
  try {
    value.json = JSON.parse(result.stdout) as JsonValue;
    return { ok: true, value };
  } catch {
    return { ok: false, error: "command_output_not_json" };
  }
}

export function formatAppCommandFailure(result: AppCommandProcessResult): string {
  const prefix = `command_failed:${result.exitCode}:`;
  const detail = result.spawnError || result.stderr || result.stdout;
  const captureMarker = result.spawnError
    ? ""
    : result.stderr
      ? result.stderrTruncated
        ? "…[stderr_capture_truncated]"
        : ""
      : result.stdoutTruncated
        ? "…[stdout_capture_truncated]"
        : "";
  if (prefix.length + detail.length + captureMarker.length <= COMMAND_FAILURE_MAX_CHARS) {
    return `${prefix}${detail}${captureMarker}`;
  }
  const detailBudget = Math.max(
    0,
    COMMAND_FAILURE_MAX_CHARS - prefix.length - COMMAND_FAILURE_TRUNCATION_MARKER.length - captureMarker.length,
  );
  return `${prefix}${detail.slice(0, detailBudget)}${COMMAND_FAILURE_TRUNCATION_MARKER}${captureMarker}`;
}

export async function runAppCommandProcess(
  command: string,
  args: string[],
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
  options: AppCommandProcessOptions = {},
): Promise<AppCommandProcessResult> {
  const execute = options.execute ?? spawnCommand;
  const candidates = commandCandidates(command, args, options.platform ?? process.platform);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const rawResult = await execute(candidate.command, candidate.args, cwd, runtimeEnv, { windowsHide: true });
    const result = normalizeExecutionResult(rawResult);
    if (result.exitCode === 0 || index === candidates.length - 1 || !commandWasUnavailable(candidate.command, result)) {
      return {
        ...result,
        resolvedCommand: candidate.command,
        resolvedArgs: candidate.args,
      };
    }
  }
  throw new Error("app_command_candidates_exhausted");
}

function commandCandidates(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): Array<{ command: string; args: string[] }> {
  const declared = { command, args };
  if (platform !== "win32" || command.toLowerCase() !== "python3") return [declared];
  return [declared, { command: "py", args: ["-3", ...args] }, { command: "python", args }];
}

function commandWasUnavailable(
  command: string,
  result: { exitCode: number; stdout: string; stderr: string; spawnError: string },
): boolean {
  const launchFailure = result.spawnError || result.stderr;
  if (result.exitCode === -1 && /\bENOENT\b|not found|cannot find/i.test(launchFailure)) return true;
  if (command.toLowerCase() === "python3") {
    return result.exitCode === 9009 && /python was not found/i.test(result.stderr);
  }
  return (
    command.toLowerCase() === "py" &&
    /no suitable python runtime|requested python version.+not installed/i.test(result.stderr)
  );
}

function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
  spawnPolicy: { windowsHide: boolean },
): Promise<AppCommandExecutionResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(runtimeEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: spawnPolicy.windowsHide,
    });
    const stdout = new BoundedByteCollector(MAX_OUTPUT_BYTES);
    const stderr = new BoundedByteCollector(MAX_OUTPUT_BYTES);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise(executionResult(-1, stdout, stderr, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise(executionResult(code ?? -1, stdout, stderr));
    });
  });
}

class BoundedByteCollector {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.retainedBytes = this.maxBytes;
      return;
    }
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0]!;
      const overflow = this.retainedBytes - this.maxBytes;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }

  finish(): { text: string; totalBytes: number; capturedBytes: number; truncated: boolean } {
    const bytes = Buffer.concat(this.chunks, this.retainedBytes);
    const truncated = this.totalBytes > bytes.length;
    return {
      text: decodeUtf8(bytes, truncated).trim(),
      totalBytes: this.totalBytes,
      capturedBytes: bytes.length,
      truncated,
    };
  }
}

function decodeUtf8(bytes: Buffer, mayStartMidCharacter: boolean): string {
  if (!mayStartMidCharacter) return bytes.toString("utf8");
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function executionResult(
  exitCode: number,
  stdoutCollector: BoundedByteCollector,
  stderrCollector: BoundedByteCollector,
  spawnError = "",
): AppCommandExecutionResult {
  const stdout = stdoutCollector.finish();
  const stderr = stderrCollector.finish();
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    spawnError,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    capturedStdoutBytes: stdout.capturedBytes,
    capturedStderrBytes: stderr.capturedBytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function normalizeExecutionResult(result: AppCommandExecutionResult): Required<AppCommandExecutionResult> {
  const stdoutBytes = result.stdoutBytes ?? Buffer.byteLength(result.stdout, "utf8");
  const stderrBytes = result.stderrBytes ?? Buffer.byteLength(result.stderr, "utf8");
  return {
    ...result,
    spawnError: result.spawnError ?? "",
    stdoutBytes,
    stderrBytes,
    capturedStdoutBytes: result.capturedStdoutBytes ?? stdoutBytes,
    capturedStderrBytes: result.capturedStderrBytes ?? stderrBytes,
    stdoutTruncated: result.stdoutTruncated ?? false,
    stderrTruncated: result.stderrTruncated ?? false,
  };
}

function resolveInside(root: string, input: string): string | undefined {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
