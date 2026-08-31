import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent, JsonObject } from "../core.js";
import { createClaudeCodeKernelAdapter } from "../kernel/adapters/claude-code.js";
import { resolveKernelCommandPath } from "../server/kernel-selection.js";

const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-auto-compact-"));
const cliPath = resolveKernelCommandPath(undefined, "claude-code");
assert.ok(cliPath, "the product discovery chain must resolve the Claude Code runtime");
const kernel = createClaudeCodeKernelAdapter({
  cliPath,
  cwd,
  configuredModel: process.env.OPENGROVE_CLAUDE_TEST_MODEL?.trim() || "haiku",
  permissionMode: "dontAsk",
});
const app = createOpenGrove({
  cwd,
  workspaceRoot: cwd,
  kernel,
  readPage: () => ({ title: "", url: "", selection: "", locator: "" }),
});
const sessionId = `claude-auto-compact-${Date.now()}`;
const runtimeEnv = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "16000",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "9000",
};
const compactionEvents: Extract<AgentEvent, { type: "compaction.finished" }>[] = [];

try {
  for (let turn = 0; turn < 6 && !findAutomaticCompaction(compactionEvents); turn += 1) {
    const payload = Array.from({ length: 5_500 }, (_, index) => `词${turn}-${index % 997}`).join(" ");
    for await (const event of app.runTurn(
      `请记住下面的测试填充文本，不要调用工具，只回答 AUTO_TURN_${turn}_OK。\n${payload}`,
      {
        sessionId,
        requestedModelId: process.env.OPENGROVE_CLAUDE_TEST_MODEL?.trim() || "haiku",
        requestedEffort: "low",
        accessMode: "default",
        runtimeEnv,
      },
    )) {
      if (event.type === "compaction.finished") compactionEvents.push(event);
    }
  }

  const automatic = findAutomaticCompaction(compactionEvents);
  assert.ok(automatic, `expected Claude auto compaction; events=${JSON.stringify(compactionEvents)}`);

  let resumedAnswer = "";
  for await (const event of app.runTurn("不要调用工具，只回答 AUTO_RESUME_OK", {
    sessionId,
    requestedModelId: process.env.OPENGROVE_CLAUDE_TEST_MODEL?.trim() || "haiku",
    requestedEffort: "low",
    accessMode: "default",
    runtimeEnv,
  })) {
    if (event.type === "assistant.final") resumedAnswer = event.text.trim();
  }
  assert.match(resumedAnswer, /AUTO_RESUME_OK/);
  process.stdout.write(`${JSON.stringify({ ok: true, trigger: "auto", resumedAnswer }, null, 2)}\n`);
} finally {
  await kernel.dispose?.();
  rmSync(cwd, { recursive: true, force: true });
}

function findAutomaticCompaction(
  events: Extract<AgentEvent, { type: "compaction.finished" }>[],
): Extract<AgentEvent, { type: "compaction.finished" }> | undefined {
  return events.find((event) => {
    const item =
      event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as JsonObject)
        : undefined;
    return item?.trigger === "auto";
  });
}
