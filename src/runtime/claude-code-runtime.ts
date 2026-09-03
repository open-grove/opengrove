import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppEnv } from "../identity.js";
import { resolveCommandPath, resolveCommandInvocation } from "../kernel/discovery.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentTurnRequest,
  JsonObject,
  JsonValue,
  RuntimeAccessMode,
  ToolResult,
} from "../core.js";
import {
  agentTurnHostContextPromptBlock,
  agentTurnReplyLanguageInstruction,
  turnReplyLanguagePreference,
} from "../core.js";
import { DEFAULT_LOCALE, localizedValue, type SupportedLocale } from "../localization/locale-registry.js";
import {
  createClaudeCodeStreamCaptureRecorder,
  type ClaudeCodeStreamCaptureOptions,
} from "./claude-code-stream-capture.js";
import {
  applyClaudeBedrockHelperEnv,
  applyClaudeHostManagedProviderEnv,
  isClaudeProviderManagedByHost,
} from "./claude-bedrock-env.js";
import { normalizeClaudeRuntimeModelId, resolveClaudeRuntimeModel } from "./claude-model-normalize.js";
import { resolveRuntimeRunId } from "./run-id.js";
import {
  claudePlanningEventsForToolFinished,
  claudePlanningEventsForToolStarted,
  createClaudePlanningState,
  type ClaudePlanningState,
} from "./claude-planning.js";

export interface ClaudeCodeRuntimeOptions {
  cliPath: string;
  cliKind?: "node-script" | "native-executable";
  cwd?: string;
  nodePath?: string;
  permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan" | "auto";
  configuredBaseUrl?: string;
  configuredAuthToken?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  modelAliases?: Record<string, string>;
  streamCapture?: ClaudeCodeStreamCaptureOptions;
  env?: NodeJS.ProcessEnv;
}

type ClaudeStreamEvent = JsonObject;

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

interface ClaudeToolCallRecord {
  toolId: string;
  toolName: string;
  input: JsonValue;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  private isolatedHome: string | undefined;

  constructor(private readonly options: ClaudeCodeRuntimeOptions) {}

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = resolveRuntimeRunId(request.runId);
    const requestedModel = resolveClaudeRuntimeModel(
      request.requestedModelId,
      this.options.configuredModel,
      this.options.modelAliases,
    );
    const systemPrompt = buildClaudeSystemPrompt(request);
    const permissionMode = resolveClaudePermissionMode(request.accessMode, this.options.permissionMode);
    const capture = createClaudeCodeStreamCaptureRecorder(this.options.streamCapture);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const cwd = this.options.cwd ?? process.cwd();
    const nativeSession = resolveClaudeNativeSession(request, this.options.runtimeBindingFingerprint, {
      cwd,
      configDir: runtimeEnv?.CLAUDE_CONFIG_DIR ?? this.options.env?.CLAUDE_CONFIG_DIR,
    });
    const claudeSessionId = nativeSession.sessionId;
    const sessionTrace: AgentSessionTrace = {
      provider: "claude-code",
      sessionId: claudeSessionId,
      persistent: true,
      priorMessageCount: nativeSession.resuming ? 1 : 0,
      priorMessages: [],
    };
    capture?.recordLifecycle("turn.started", {
      runId,
      sessionId: claudeSessionId,
      model: requestedModel,
      cwd,
      permissionMode,
    });
    capture?.recordTurnInput({
      runId,
      sessionId: claudeSessionId,
      model: requestedModel,
      userInput: request.input,
      appendSystemPrompt: systemPrompt,
    });

    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.assembledContext) {
      yield { type: "context.assembled", runId, context: request.assembledContext };
    }
    yield {
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "claude.host_tools.configured",
      data: {
        runtimeMode: "cli",
        available: false,
        transport: "none",
      },
    };
    yield {
      type: "model.requested",
      runId,
      request: {
        systemPrompt,
        userInput: request.input,
        modelId: requestedModel,
        session: sessionTrace,
        context: request.assembledContext,
        tools: [],
        skills: request.skills ?? [],
        packs: request.packs ?? [],
        capabilities: request.capabilities ?? [],
      },
    };

    const launch = this.prepareLaunchConfig(requestedModel, runtimeEnv);
    const launchCommand = resolveClaudeLaunchCommand(this.options);
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", permissionMode];
    if (nativeSession.resuming) {
      args.push("--resume", claudeSessionId);
    } else {
      args.push("--session-id", claudeSessionId);
    }

    if (requestedModel) {
      args.push("--model", requestedModel);
    }
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
    args.push(request.input);
    capture?.recordProcessLaunch({
      executable: launchCommand.executable,
      argv: [...launchCommand.prefixArgs, ...args],
      cwd,
      model: requestedModel,
      sessionId: claudeSessionId,
      runId,
    });

    const child = spawn(launchCommand.executable, [...launchCommand.prefixArgs, ...args], {
      cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abortChild = () => {
      aborted = true;
      if (!child.killed) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2_000);
      }
    };
    if (request.signal?.aborted) {
      abortChild();
    } else {
      request.signal?.addEventListener("abort", abortChild, { once: true });
    }
    capture?.recordLifecycle("process.spawned", {
      runId,
      sessionId: claudeSessionId,
      pid: child.pid,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let assistantText = "";
    let resultText = "";
    let resultIsError = false;
    const toolCalls = new Map<string, ClaudeToolCallRecord>();
    const planningState = createClaudePlanningState();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      capture?.recordStderr(chunk);
    });

    child.stdout.setEncoding("utf8");
    let stdoutReadError: Error | undefined;
    try {
      for await (const chunk of child.stdout) {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutBuffer.indexOf("\n");
          if (!line) {
            continue;
          }
          const parsed = parseClaudeStreamEvent(line);
          if (!parsed) {
            capture?.recordParseError(line);
            continue;
          }
          capture?.recordStdoutEvent(line, parsed);

          const mappedEvents = mapClaudeStreamEvent(parsed, {
            runId,
            toolCalls,
            planningState,
            onAssistantText(text) {
              assistantText += text;
            },
            onResult(value, isError) {
              resultText = value;
              resultIsError = isError;
            },
          });
          capture?.recordMappedEvents(mappedEvents);
          for (const event of mappedEvents) {
            yield event;
          }
        }
      }
    } catch (error) {
      stdoutReadError = error instanceof Error ? error : new Error(String(error));
    }

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once("close", resolveExit);
    });
    request.signal?.removeEventListener("abort", abortChild);
    if (killTimer) clearTimeout(killTimer);
    capture?.recordLifecycle("process.closed", {
      runId,
      sessionId: claudeSessionId,
      exitCode,
      stderrBytes: Buffer.byteLength(stderrBuffer, "utf8"),
      stdoutReadError: stdoutReadError?.message,
    });
    if (aborted) {
      const partialText = resultText || assistantText;
      if (partialText) {
        yield {
          type: "assistant.final",
          runId,
          text: partialText,
          at: new Date().toISOString(),
          source: "runtime",
        };
      }
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_CANCELED", reasonCode: "native_cancelled", retryable: false },
      };
      return;
    }

    if (stdoutBuffer.trim()) {
      const tailLine = stdoutBuffer.trim();
      const parsed = parseClaudeStreamEvent(tailLine);
      if (parsed) {
        capture?.recordStdoutEvent(tailLine, parsed);
        const mappedEvents = mapClaudeStreamEvent(parsed, {
          runId,
          toolCalls,
          planningState,
          onAssistantText(text) {
            assistantText += text;
          },
          onResult(value, isError) {
            resultText = value;
            resultIsError = isError;
          },
        });
        capture?.recordMappedEvents(mappedEvents);
        for (const event of mappedEvents) {
          yield event;
        }
      } else {
        capture?.recordParseError(tailLine);
      }
    }

    const finalText = resultText || assistantText;
    if (resultIsError) {
      yield {
        type: "error",
        runId,
        message: finalText || claudeProcessErrorMessage(stderrBuffer, stdoutReadError, exitCode),
      };
    } else if (stdoutReadError || (exitCode && exitCode !== 0)) {
      yield {
        type: "error",
        runId,
        message: claudeProcessErrorMessage(stderrBuffer, stdoutReadError, exitCode),
      };
    }

    if (!resultIsError && !stdoutReadError && (!exitCode || exitCode === 0)) {
      rememberClaudeNativeSession(request, claudeSessionId, this.options.runtimeBindingFingerprint);
    }

    yield {
      type: "model.response",
      runId,
      response: { text: finalText },
    };
    capture?.recordLifecycle("turn.finished", {
      runId,
      sessionId: claudeSessionId,
      resultIsError,
      exitCode,
      finalTextBytes: Buffer.byteLength(finalText, "utf8"),
    });
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome:
        resultIsError || stdoutReadError || (exitCode !== null && exitCode !== 0)
          ? { taskState: "TASK_STATE_FAILED", reasonCode: "claude_code_failed" }
          : exitCode === null
            ? {
                taskState: "TASK_STATE_FAILED",
                reasonCode: "producer_lost",
                retryable: false,
                outcomeUnknown: true,
              }
            : { taskState: "TASK_STATE_COMPLETED" },
    };
  }

  private prepareLaunchConfig(
    requestedModel: string | undefined,
    runtimeEnv: NodeJS.ProcessEnv | undefined,
  ): { env: NodeJS.ProcessEnv } {
    const configuredBaseUrl = this.options.configuredBaseUrl?.trim() || "";
    const configuredAuthToken = this.options.configuredAuthToken?.trim() || "";
    const configuredModel = normalizeClaudeRuntimeModelId(requestedModel ?? this.options.configuredModel);
    const env = applyClaudeHostManagedProviderEnv({ ...process.env, ...runtimeEnv }, this.options.env);

    if (isClaudeProviderManagedByHost(this.options.env)) {
      // The CLI reads ~/.claude/settings.json after process env. Give an
      // explicit OpenGrove provider an isolated HOME so those settings cannot
      // redirect the request to a different account/provider.
      env.HOME = this.ensureIsolatedHome();
      delete env.CLAUDE_CONFIG_DIR;
    }

    if (!configuredBaseUrl && !configuredAuthToken) {
      return { env: applyClaudeBedrockHelperEnv(env) };
    }

    const home = this.ensureIsolatedHome();
    writeClaudeConfig(home, {
      baseUrl: configuredBaseUrl,
      authToken: configuredAuthToken,
      model: configuredModel,
    });

    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    env.HOME = home;
    return { env };
  }

  private ensureIsolatedHome(): string {
    this.isolatedHome ??= mkdtempSync(join(tmpdir(), "opengrove-claude-"));
    return this.isolatedHome;
  }
}

function mergeRuntimeEnv(
  base: NodeJS.ProcessEnv | undefined,
  override: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return Object.keys(merged).length ? merged : undefined;
}

function resolveClaudeNativeSession(
  request: AgentTurnRequest,
  runtimeBindingFingerprint: string | undefined,
  options: { cwd: string; configDir?: string | undefined },
): { sessionId: string; resuming: boolean } {
  const current = request.context.sessions?.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const sessionByFingerprint = current?.metadata?.claudeCodeSessionIds;
  if (sessionByFingerprint && typeof sessionByFingerprint === "object" && !Array.isArray(sessionByFingerprint)) {
    const sessionId = (sessionByFingerprint as Record<string, unknown>)[fingerprint];
    if (typeof sessionId === "string" && sessionId.trim()) {
      return { sessionId, resuming: true };
    }
  }
  const metadataSession =
    typeof current?.metadata?.claudeCodeSessionId === "string" ? current.metadata.claudeCodeSessionId : undefined;
  const stableSessionId =
    metadataSession && fingerprint === "native"
      ? metadataSession
      : toStableClaudeSessionId(`${request.context.sessionId}:${fingerprint}`);
  return {
    sessionId: stableSessionId,
    resuming:
      Boolean(metadataSession && fingerprint === "native") || claudeNativeTranscriptExists(stableSessionId, options),
  };
}

function rememberClaudeNativeSession(
  request: AgentTurnRequest,
  nativeSessionId: string,
  runtimeBindingFingerprint: string | undefined,
): void {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const metadata: JsonObject = {
    ...(current?.metadata ?? {}),
    claudeCodeSessionIds: {
      ...readObject(current?.metadata?.claudeCodeSessionIds),
      [fingerprint]: nativeSessionId,
    },
  };
  if (fingerprint === "native") {
    metadata.claudeCodeSessionId = nativeSessionId;
    metadata.claudeCodeSessionUpdatedAt = new Date().toISOString();
  }
  request.context.sessions.ensureSession({
    id: request.context.sessionId,
    activity: request.context.activity,
    metadata,
  });
}

function claudeNativeTranscriptExists(
  sessionId: string,
  options: { cwd: string; configDir?: string | undefined },
): boolean {
  const configDir = options.configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  const projectPath = join(projectsDir, claudeProjectKey(options.cwd), `${sessionId}.jsonl`);
  if (existsSync(projectPath)) {
    return true;
  }

  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projectsDir, entry.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
  } catch {
    // non-critical-fallback: Missing or unreadable native transcripts do not block a fresh session.
  }
  return false;
}

function claudeProjectKey(cwd: string): string {
  return resolve(cwd || process.cwd())
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]/g, "-");
}

function readObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function parseClaudeStreamEvent(line: string): ClaudeStreamEvent | undefined {
  try {
    const parsed = JSON.parse(line);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapClaudeStreamEvent(
  event: ClaudeStreamEvent,
  options: {
    runId: string;
    toolCalls: Map<string, ClaudeToolCallRecord>;
    planningState: ClaudePlanningState;
    onAssistantText(text: string): void;
    onResult(text: string, isError: boolean): void;
  },
): AgentEvent[] {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "assistant") {
    const message = isJsonObject(event.message) ? event.message : undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    const events: AgentEvent[] = [];

    for (const block of content) {
      if (!isJsonObject(block)) {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        options.onAssistantText(block.text);
        events.push({ type: "assistant.delta", runId: options.runId, text: block.text });
      }
      if (block.type === "tool_use") {
        const callId = typeof block.id === "string" ? block.id : "";
        const toolName = typeof block.name === "string" ? block.name : "Tool";
        const toolId = `claude.${toolName}`;
        const input = asJsonValue(block.input);
        if (callId) {
          options.toolCalls.set(callId, { toolId, toolName, input });
        }
        events.push({
          type: "tool.started",
          runId: options.runId,
          toolId,
          ...(callId ? { callId } : {}),
          input,
        });
        events.push(
          ...claudePlanningEventsForToolStarted({
            runId: options.runId,
            ...(callId ? { callId } : {}),
            toolName,
            toolInput: input,
            state: options.planningState,
          }),
        );
      }
    }

    return events;
  }

  if (type === "user") {
    const message = isJsonObject(event.message) ? event.message : undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    const events: AgentEvent[] = [];

    for (const block of content) {
      if (!isJsonObject(block) || block.type !== "tool_result") {
        continue;
      }
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const call = options.toolCalls.get(callId);
      const result = normalizeClaudeToolResult(block, event.tool_use_result);
      events.push({
        type: "tool.finished",
        runId: options.runId,
        toolId: call?.toolId ?? "claude.tool",
        ...(callId ? { callId } : {}),
        result,
      });
      if (call) {
        events.push(
          ...claudePlanningEventsForToolFinished({
            runId: options.runId,
            ...(callId ? { callId } : {}),
            toolName: call.toolName,
            toolInput: call.input,
            toolResult: result.value,
            resultOk: result.ok,
            state: options.planningState,
          }),
        );
      }
    }

    return events;
  }

  if (type === "result") {
    const text = typeof event.result === "string" ? event.result : "";
    const isError = event.is_error === true;
    options.onResult(text, isError);
  }

  return [];
}

function normalizeClaudeToolResult(block: JsonObject, toolUseResult: unknown): ToolResult {
  const isError = block.is_error === true;
  const rawValue = toolUseResult ?? block.content;
  const value = asJsonValue(rawValue);
  if (isError) {
    return {
      ok: false,
      error:
        typeof value === "string"
          ? value
          : isJsonObject(value) && typeof value.text === "string"
            ? value.text
            : "claude_tool_error",
      value: value === null ? undefined : value,
    };
  }
  return {
    ok: true,
    value: value === null ? undefined : value,
  };
}

function claudeProcessErrorMessage(
  stderr: string,
  stdoutReadError: Error | undefined,
  exitCode: number | null,
): string {
  return stderr.trim() || stdoutReadError?.message || `claude_code_failed:${exitCode ?? "unknown"}`;
}

function buildClaudeSystemPrompt(request: AgentTurnRequest): string {
  const capabilityBoundary = localizedValue(
    CLAUDE_CAPABILITY_BOUNDARY,
    turnReplyLanguagePreference(request) ?? DEFAULT_LOCALE,
  );
  const hostContext = agentTurnHostContextPromptBlock(request);
  const sections = [
    "You are running inside the OpenGrove host.",
    "Use Claude Agent built-in tools for workspace operations.",
    capabilityBoundary,
    hostContext ? `Host context:\n${hostContext}` : "",
    request.requestedSkillInvocation
      ? [`Loaded host skill /${request.requestedSkillInvocation.skillName}:`, request.requestedSkillInvocation.content]
          .filter(Boolean)
          .join("\n")
      : "",
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);

  return sections.join("\n\n");
}

const CLAUDE_CAPABILITY_BOUNDARY = {
  "zh-CN": [
    "OpenGrove Claude CLI 能力边界：当前不提供 OpenGrove Host Tools。",
    "不得声称已经调用仅由 OpenGrove Host 提供的工具；具体任务的降级规则由 Host context 给出。",
  ].join("\n"),
  en: [
    "OpenGrove Claude CLI capability boundary: OpenGrove Host Tools are not available.",
    "Do not claim to have called tools provided only by the OpenGrove Host. Follow the fallback rules in the Host context for the current task.",
  ].join("\n"),
} satisfies Record<SupportedLocale, string>;

function writeClaudeConfig(homeDir: string, config: { baseUrl?: string; authToken?: string; model?: string }) {
  const claudeDir = resolve(homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const env: Record<string, string> = {};
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.authToken) env.ANTHROPIC_AUTH_TOKEN = config.authToken;
  if (config.model) {
    env.ANTHROPIC_MODEL = config.model;
  }

  writeFileSync(resolve(claudeDir, "settings.json"), JSON.stringify({ env }, null, 2));
  writeFileSync(resolve(homeDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
}

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

function resolveClaudeLaunchCommand(options: ClaudeCodeRuntimeOptions): { executable: string; prefixArgs: string[] } {
  const cliKind = options.cliKind ?? inferClaudeCliKind(options.cliPath);
  const invocation = resolveCommandInvocation(options.cliPath, [], {
    nodeScript: cliKind === "node-script",
    nodePath: options.nodePath,
  });
  return {
    executable: invocation.command,
    prefixArgs: invocation.args,
  };
}

function inferClaudeCliKind(path: string): "node-script" | "native-executable" {
  const normalized = path.toLowerCase();
  return normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")
    ? "node-script"
    : "native-executable";
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

function resolveClaudePermissionMode(
  accessMode: RuntimeAccessMode | undefined,
  configured: ClaudeCodeRuntimeOptions["permissionMode"],
): NonNullable<ClaudeCodeRuntimeOptions["permissionMode"]> {
  switch (accessMode) {
    case "default":
      return "default";
    case "auto-review":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
    default:
      return configured ?? "bypassPermissions";
  }
}

function toStableClaudeSessionId(input: string): string {
  const hash = createHash("sha1").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item));
  }
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = asJsonValue(item);
    }
    return result;
  }
  return String(value);
}
