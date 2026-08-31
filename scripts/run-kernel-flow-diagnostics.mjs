import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCodexKernelAdapter, createOpenGrove } from "../dist/index.js";
import { resolveClaudeCodeCliPath } from "../dist/runtime/claude-code-runtime.js";
import { resolveCodexCommandPath } from "../dist/runtime/codex-runtime.js";

const ROOT = process.cwd();
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = resolve(ROOT, "data", "kernel-flow-runs", RUN_ID);
mkdirSync(OUT_DIR, { recursive: true });

const CODEX_BIN = resolveCodexCommandPath();
const CLAUDE_BIN = resolveClaudeCodeCliPath(ROOT);
if (!CODEX_BIN) throw new Error("Product kernel discovery could not resolve Codex.");
if (!CLAUDE_BIN) throw new Error("Product kernel discovery could not resolve the Claude Agent runtime.");

const summaries = [];

function writeJsonl(name, records) {
  const file = resolve(OUT_DIR, `${name}.jsonl`);
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function redact(value) {
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
  }
  return value;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "raw", text: line };
  }
}

async function runCommandScenario(name, command, args, options = {}) {
  const records = [];
  const startedAt = new Date().toISOString();
  records.push({ type: "diagnostic.started", name, command, args, startedAt });

  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) records.push({ stream: "stdout", ...redact(parseJsonLine(line.trim())) });
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) records.push({ stream: "stderr", ...redact(parseJsonLine(line.trim())) });
    }
  });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    records.push({ type: "diagnostic.timeout", timeoutMs });
    child.kill("SIGTERM");
  }, timeoutMs);

  const exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));
  clearTimeout(timeout);

  records.push({
    type: "diagnostic.finished",
    name,
    exitCode,
    finishedAt: new Date().toISOString(),
  });
  const file = writeJsonl(name, records);
  summaries.push(summarizeCommandScenario(name, file, exitCode, stdout, stderr, records));
}

function summarizeCommandScenario(name, file, exitCode, stdout, stderr, records) {
  const jsonEvents = records.filter((record) => record.stream === "stdout" && record.type && record.type !== "raw");
  const stderrLines = stderr.split(/\r?\n/).filter(Boolean).length;
  const toolUses = jsonEvents.filter(
    (event) =>
      event.type === "assistant" &&
      Array.isArray(event.message?.content) &&
      event.message.content.some((block) => block?.type === "tool_use"),
  ).length;
  const toolResults = jsonEvents.filter(
    (event) =>
      event.type === "user" &&
      Array.isArray(event.message?.content) &&
      event.message.content.some((block) => block?.type === "tool_result"),
  ).length;
  const final = [...jsonEvents].reverse().find((event) => event.type === "result");
  return {
    name,
    file,
    exitCode,
    eventCount: records.length,
    jsonEventCount: jsonEvents.length,
    stderrLines,
    toolUses,
    toolResults,
    finalText: typeof final?.result === "string" ? final.result.slice(0, 300) : "",
    permissionDenials: Array.isArray(final?.permission_denials) ? final.permission_denials.length : 0,
    usage: final?.usage || final?.modelUsage || undefined,
  };
}

async function runPaCodexScenario(name, input, options = {}) {
  const records = [];
  const app = createOpenGrove({
    kernel: createCodexKernelAdapter({
      command: CODEX_BIN,
      cwd: ROOT,
      approvalPolicy: options.approvalPolicy || "never",
      sandbox: options.sandbox || "read-only",
      statePath: resolve(OUT_DIR, `${name}-codex-threads.json`),
    }),
    readPage: () => ({
      title: "Kernel diagnostics page",
      url: "about:blank#kernel-diagnostics",
      selection: "diagnostic selection",
      locator: "diagnostic",
    }),
    sessionId: `diag-${name}`,
    userId: "local-user",
  });

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 150_000);
  let approvalRequests = 0;
  let approvalResolved = 0;
  let finalText = "";

  try {
    for await (const event of app.runTurn(input, {
      sandbox: options.sandbox || "read-only",
      approvalPolicy: options.approvalPolicy || "never",
      signal: abort.signal,
    })) {
      records.push(redact(event));
      if (event.type === "assistant.delta") {
        finalText += event.text || "";
      }
      if (event.type === "model.response" && event.response?.text) {
        finalText = event.response.text;
      }
      if (event.type === "approval.requested") {
        approvalRequests += 1;
        const decision = options.approvalDecision || "rejected";
        app.approvals.decide(event.request.id, decision, {
          answer: decision === "approved" ? "diagnostic-approved" : "diagnostic-rejected",
        });
      }
      if (event.type === "approval.resolved") {
        approvalResolved += 1;
      }
    }
  } catch (error) {
    records.push({
      type: "diagnostic.error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }

  const file = writeJsonl(name, records);
  const eventTypes = {};
  for (const event of records) eventTypes[event.type || "unknown"] = (eventTypes[event.type || "unknown"] || 0) + 1;
  summaries.push({
    name,
    file,
    exitCode: 0,
    eventCount: records.length,
    eventTypes,
    approvalRequests,
    approvalResolved,
    finalText: finalText.slice(0, 300),
  });
}

await runCommandScenario("claude-normal", CLAUDE_BIN, [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "bypassPermissions",
  "--",
  "只回答 OK-CLAUDE-NORMAL，不要调用工具。",
]);

await runCommandScenario(
  "claude-bash-tool-default-permission-timeout",
  CLAUDE_BIN,
  [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "default",
    "--tools",
    "Bash",
    "--",
    "请调用 Bash 工具执行 pwd，然后用一句话告诉我结果。",
  ],
  { timeoutMs: 25_000 },
);

await runCommandScenario("claude-bash-tool-bypass", CLAUDE_BIN, [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "bypassPermissions",
  "--tools",
  "Bash",
  "--",
  "请调用 Bash 工具执行 pwd，然后用一句话告诉我结果。",
]);

await runCommandScenario("claude-user-question", CLAUDE_BIN, [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "bypassPermissions",
  "--tools",
  "AskUserQuestion",
  "--",
  "请必须调用 AskUserQuestion 工具，问用户选择 A 或 B；不要自己回答。",
]);

await runCommandScenario("codex-exec-tool", CODEX_BIN, [
  "exec",
  "--json",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "请运行 pwd，然后只用一句话回答当前目录。",
]);

await runCommandScenario("codex-exec-readonly-write", CODEX_BIN, [
  "-a",
  "never",
  "exec",
  "--json",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "请尝试创建文件 data/kernel-flow-runs/codex-readonly-probe.txt，内容 CODEX_READONLY_PROBE，然后报告是否成功。",
]);

await runPaCodexScenario("opengrove-codex-normal", "只回答 OK-OpenGrove-CODEX-NORMAL，不要调用工具。", {
  sandbox: "read-only",
  approvalPolicy: "never",
});

await runPaCodexScenario(
  "opengrove-codex-host-choice-tool",
  "必须调用 OpenGrove host tool `host.ui.requestChoices`。表单标题为“诊断选择”，只问一个问题“选择 A 还是 B？”，两个选项 A/B。调用后不要继续解释。",
  { sandbox: "read-only", approvalPolicy: "never" },
);

await runPaCodexScenario(
  "opengrove-codex-native-approval-rejected",
  "请尝试创建文件 data/kernel-flow-runs/native-approval-probe.txt，内容为 APPROVAL_PROBE。当前如果需要批准，请正常请求批准；不要绕过，也不要改写到别处。",
  {
    sandbox: "read-only",
    approvalPolicy: "on-request",
    approvalDecision: "rejected",
  },
);

const report = [
  "# Kernel Flow Diagnostics",
  "",
  `Run id: ${RUN_ID}`,
  `Output dir: ${OUT_DIR}`,
  "",
  "## Scenarios",
  "",
  ...summaries.flatMap((summary) => [
    `### ${summary.name}`,
    "",
    `- Log: ${summary.file}`,
    `- Exit: ${summary.exitCode}`,
    `- Events: ${summary.eventCount}`,
    summary.eventTypes
      ? `- OpenGrove event types: ${JSON.stringify(summary.eventTypes)}`
      : `- JSON events: ${summary.jsonEventCount}`,
    summary.toolUses !== undefined ? `- Native tool uses: ${summary.toolUses}` : "",
    summary.toolResults !== undefined ? `- Native tool results: ${summary.toolResults}` : "",
    summary.permissionDenials !== undefined ? `- Permission denials: ${summary.permissionDenials}` : "",
    summary.approvalRequests !== undefined ? `- Approval requests: ${summary.approvalRequests}` : "",
    summary.approvalResolved !== undefined ? `- Approval resolved: ${summary.approvalResolved}` : "",
    summary.stderrLines ? `- Stderr lines: ${summary.stderrLines}` : "",
    summary.finalText ? `- Final text: ${summary.finalText.replace(/\n/g, " ")}` : "",
    "",
  ]),
  "## Notes",
  "",
  "- Claude Code `AskUserQuestion` appears as a native tool call in stream-json, but in non-interactive `--print` mode it returns a tool error instead of opening an interactive UI.",
  "- Codex `exec --json` exposes native thread/turn/item events. OpenGrove Codex adapter translates app-server notifications into OpenGrove `AgentEvent` records.",
  "- Compaction did not naturally trigger in these short runs. OpenGrove has `compaction.started` / `compaction.finished` event handling, but a real trigger needs a long/high-pressure context or a native compact action.",
  "",
]
  .filter((line) => line !== "")
  .join("\n");

const reportFile = resolve(OUT_DIR, "report.md");
writeFileSync(reportFile, report);
console.log(JSON.stringify({ ok: true, outDir: OUT_DIR, reportFile, summaries }, null, 2));
process.exit(0);
