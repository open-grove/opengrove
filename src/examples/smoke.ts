import { createOpenGrove } from "../app/create-opengrove.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "opengrove-smoke-"));
const app = createOpenGrove({
  cwd,
  readPage: () => ({
    title: "微信读书测试页",
    url: "https://weread.qq.com/web/reader/example",
    selection: "浏览器其实也是一种操作系统，agent 可以长在它的活动空间里。",
    locator: "demo-selection",
  }),
  runtime: {
    async *runTurn(request) {
      const runId = request.runId ?? "smoke-run";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      yield {
        type: "model.requested",
        runId,
        request: {
          systemPrompt: "",
          userInput: request.input,
          tools: request.tools.map((tool) => tool.spec),
          skills: request.skills ?? [],
          packs: request.packs ?? [],
          capabilities: request.capabilities ?? [],
        },
      };
      yield { type: "assistant.delta", runId, text: "OpenGrove smoke runtime is alive." };
      yield { type: "turn.finished", runId, at: new Date().toISOString() };
    },
  },
  sessionId: "smoke",
  userId: "local-user",
});

const readingSelection = app.artifacts.create({
  type: "selection",
  title: "当前划线",
  tags: ["weread", "selection"],
  data: {
    text: "浏览器其实也是一种操作系统，agent 可以长在它的活动空间里。",
    locator: "demo-selection",
    url: "https://weread.qq.com/web/reader/example",
  },
});
const noteDraft = app.artifacts.create({
  type: "note",
  title: "伴读草稿",
  tags: ["draft", "note"],
  data: {
    markdown: "先把这句当作工作对象，而不是聊天附件。",
  },
  derivedFrom: [readingSelection.id],
});
app.workingState.update({
  sessionId: "smoke",
  taskSummary: "验证 OpenGrove host、artifact 和 workingState 的最小链路。",
  activeGoal: "确认默认工具面保持精简。",
  pinnedArtifactIds: [readingSelection.id],
  workingArtifactIds: [noteDraft.id],
});

for await (const event of app.runTurn("smoke")) {
  console.log(JSON.stringify(event));
}

console.log(
  JSON.stringify(
    {
      memory: app.memory.list(),
      artifacts: app.artifacts.list(),
      workingState: app.workingState.get(),
    },
    null,
    2,
  ),
);
