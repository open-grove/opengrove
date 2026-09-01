import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AgentEvent, AgentRuntime, AgentSessionTrace, AgentTurnRequest } from "../core.js";
import { agentTurnHostContextPromptBlock, agentTurnReplyLanguageInstruction } from "../core.js";
import { resolveCommandInvocation } from "../kernel/discovery.js";
import { recentSessionMessages, recentSessionPromptBlock } from "./session-history.js";

export interface GenericCliRuntimeOptions {
  kernelId: string;
  title: string;
  command: string;
  args?: string[];
  promptMode?: "stdin" | "arg";
  promptLayout?: "full-context" | "input-only";
  outputFormat?: "text" | "agent-jsonl";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class GenericCliRuntime implements AgentRuntime {
  constructor(private readonly options: GenericCliRuntimeOptions) {}

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = request.runId ?? `run_${Date.now()}`;
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const prompt = buildPrompt(request, this.options.promptLayout);
    const priorMessages = recentSessionMessages(request);
    const args =
      this.options.promptMode === "arg" ? [...(this.options.args ?? []), prompt] : [...(this.options.args ?? [])];
    const invocation = resolveCommandInvocation(this.options.command, args);
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const env = { ...process.env, ...runtimeEnv };
    const session: AgentSessionTrace = {
      provider: this.options.kernelId,
      sessionId: request.context.sessionId,
      persistent: false,
      priorMessageCount: priorMessages.length,
      priorMessages,
    };

    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.assembledContext) {
      yield { type: "context.assembled", runId, context: request.assembledContext };
    }
    yield {
      type: "model.requested",
      runId,
      request: {
        systemPrompt: [`${this.options.title} CLI adapter`, agentTurnReplyLanguageInstruction(request)]
          .filter(Boolean)
          .join("\n"),
        userInput: request.input,
        modelId: request.requestedModelId,
        session,
        context: request.assembledContext,
        tools: request.tools.map((tool) => tool.spec),
        skills: request.skills ?? [],
        packs: request.packs ?? [],
        capabilities: request.capabilities ?? [],
      },
    };

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...env, PWD: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const abort = () => {
      aborted = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    if (request.signal?.aborted) {
      abort();
    } else {
      request.signal?.addEventListener("abort", abort, { once: true });
    }
    if (this.options.promptMode !== "arg") {
      child.stdin?.end(prompt);
    } else {
      child.stdin?.end();
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let spawnError: Error | undefined;
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once("error", (error) => {
        spawnError = error;
        resolveExit(null);
      });
      child.once("close", resolveExit);
    });
    request.signal?.removeEventListener("abort", abort);
    if (aborted) {
      const partialText = safelyFormatPartialCliOutput(stdout.trimEnd(), this.options.outputFormat);
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
    const text = formatCliOutput(stdout.trimEnd(), this.options.outputFormat);
    if (text) yield { type: "assistant.delta", runId, text };
    if (spawnError || (exitCode && exitCode !== 0)) {
      yield {
        type: "error",
        runId,
        message: spawnError?.message || stderr.trim() || `${this.options.kernelId}_failed:${exitCode}`,
      };
    }
    yield { type: "model.response", runId, response: { text } };
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome:
        spawnError || (exitCode !== null && exitCode !== 0)
          ? { taskState: "TASK_STATE_FAILED", reasonCode: `${this.options.kernelId}_failed` }
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

function formatCliOutput(stdout: string, outputFormat: GenericCliRuntimeOptions["outputFormat"]): string {
  if (!stdout) {
    return "";
  }
  if (outputFormat === "agent-jsonl") {
    return extractAgentJsonlText(stdout);
  }
  return stdout;
}

function safelyFormatPartialCliOutput(stdout: string, outputFormat: GenericCliRuntimeOptions["outputFormat"]): string {
  try {
    return formatCliOutput(stdout, outputFormat);
  } catch {
    // A canceled JSONL producer can end in the middle of a record. Preserve
    // only complete assistant records; never project protocol fragments as a
    // successful model.response.
    if (outputFormat !== "agent-jsonl") return stdout;
    const completeLines = stdout.includes("\n") ? stdout.slice(0, stdout.lastIndexOf("\n")) : "";
    if (!completeLines) return "";
    try {
      return extractAgentJsonlText(completeLines);
    } catch {
      return "";
    }
  }
}

function extractAgentJsonlText(stdout: string): string {
  const assistantParts: string[] = [];
  let finalText = "";
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = normalizeJsonlLine(rawLine);
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error("generic_cli_invalid_agent_jsonl", { cause: error });
    }
    const event = isRecord(parsed) ? parsed : {};
    const type = readString(event, "type");
    if (type === "assistant") {
      assistantParts.push(...readAssistantMessageParts(event.message));
      continue;
    }
    if (type === "message") {
      const role = readString(event, "role") || readString(asRecord(event.message), "role");
      if (role === "assistant") {
        assistantParts.push(...readAssistantMessageParts(event));
        assistantParts.push(...readAssistantMessageParts(event.message));
      }
      continue;
    }
    if (type === "text") {
      const text = readString(asRecord(event.part), "text") || readString(event, "text");
      if (text) assistantParts.push(text);
      continue;
    }
    if (type === "result") {
      finalText = readString(event, "result") || readString(event, "response") || finalText;
    }
  }
  return assistantParts.join("").trimEnd() || finalText.trimEnd();
}

function readAssistantMessageParts(value: unknown): string[] {
  const message = asRecord(value);
  const directText = readString(message, "text") || readString(message, "content");
  if (directText) return [directText];
  const parts: string[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = asRecord(block);
      const type = readString(item, "type");
      if (type === "text" || type === "output_text") {
        const text = readString(item, "text");
        if (text) parts.push(text);
      }
    }
  }
  return parts;
}

function normalizeJsonlLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^(stdout|stderr)\s*[:=]?\s*/i, "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildPrompt(
  request: AgentTurnRequest,
  promptLayout: GenericCliRuntimeOptions["promptLayout"] = "full-context",
): string {
  if (promptLayout === "input-only") {
    return `${[request.input, agentTurnReplyLanguageInstruction(request)].filter(Boolean).join("\n\n")}\n`;
  }
  const ambientContext = renderAmbientContext(request);
  const sections = [
    ambientContext,
    recentSessionPromptBlock(request),
    request.input,
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);
  return `${sections.join("\n\n")}\n`;
}

function renderAmbientContext(request: AgentTurnRequest): string {
  const context = request.assembledContext;
  const promptBlock = agentTurnHostContextPromptBlock(request);
  if (promptBlock) {
    return `OpenGrove host context:\n${promptBlock}`;
  }
  if (!context) {
    return "";
  }
  const summary = context.summary?.trim();
  const hasItems = (context.items?.length ?? 0) > 0;
  if (!hasItems && (!summary || summary === "empty context")) {
    return "";
  }
  if (summary) {
    return `OpenGrove context summary:\n${summary}`;
  }
  return "";
}
