import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-flow-live-todos-"));
const entryPath = join(tempDir, "flow-live-todos-entry.ts");
const bundlePath = join(tempDir, "flow-live-todos-entry.cjs");
const require = createRequire(import.meta.url);

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  const mod = require(bundlePath);
  mod.runFlowLiveTodosHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function entrySource() {
  const helperPath = resolve(projectRoot, "web/src/components/shared/flow-live-todos.ts");
  return `
    import assert from "node:assert/strict";
    import { extractFlowLiveTodos } from ${JSON.stringify(helperPath)};

    export function runFlowLiveTodosHarness() {
      const codexTodos = extractFlowLiveTodos([{
        type: "planning.updated",
        runId: "run-codex",
        plan: {
          id: "turn-plan",
          text: "summary should not be the data source",
          status: "inProgress",
          raw: {
            plan: [
              { step: "读取需求", status: "completed" },
              { step: "生成方案", status: "inProgress" },
              { step: "等待确认", status: "pending" },
            ],
          },
        },
      }]);
      assert.deepEqual(codexTodos, [
        { content: "读取需求", status: "completed" },
        { content: "生成方案", status: "in_progress" },
        { content: "等待确认", status: "pending" },
      ]);

      const acpTodos = extractFlowLiveTodos([{
        type: "planning.updated",
        runId: "run-acp",
        plan: {
          id: "acp-plan",
          text: "Plan",
          raw: {
            plan: {
              entries: [
                { content: "检查输入", status: "done" },
                { text: "调用工具", status: "in_progress" },
              ],
            },
          },
        },
      }]);
      assert.deepEqual(acpTodos, [
        { content: "检查输入", status: "completed" },
        { content: "调用工具", status: "in_progress" },
      ]);

      const latestWins = extractFlowLiveTodos([
        {
          type: "planning.updated",
          runId: "run-latest",
          plan: { id: "plan", text: "", items: [{ content: "旧计划", status: "pending" }] },
        },
        {
          type: "planning.updated",
          runId: "run-latest",
          plan: { id: "plan", text: "", steps: [{ title: "新计划", status: "completed" }] },
        },
      ]);
      assert.deepEqual(latestWins, [{ content: "新计划", status: "completed" }]);

      const textFallback = extractFlowLiveTodos([{
        type: "planning.updated",
        runId: "run-text",
        plan: {
          id: "text-plan",
          text: [
            "1. [completed] 完成一",
            "2. [inProgress] 正在二",
            "- [ ] 待办三",
          ].join("\\n"),
        },
      }]);
      assert.deepEqual(textFallback, [
        { content: "完成一", status: "completed" },
        { content: "正在二", status: "in_progress" },
        { content: "待办三", status: "pending" },
      ]);
    }
  `;
}
