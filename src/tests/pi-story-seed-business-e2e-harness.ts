import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ApprovalInbox, QuestionInbox, WorkingStateStore, type AgentContext, type AgentEvent } from "../core.js";
import { createNativePiSessionFactory } from "../runtime/native-pi-session.js";
import { PiAgentRuntime } from "../runtime/pi-runtime.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "opengrove-pi-story-seed-e2e-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const outlineRelativePath = "项目/回归故事/章节大纲.md";
const outlinePath = join(workspaceRoot, outlineRelativePath);
const realCli = process.env.OPENGROVE_STORY_SEED_CLI?.trim();
const fixtureCli = join(fixtureRoot, "story-seed-fixture.cjs");
const cli = realCli || fixtureCli;

try {
  if (!realCli) writeFixtureCli(fixtureCli);
  if (!existsSync(cli)) throw new Error(`pi_story_seed_cli_missing:${cli}`);

  const events = await runPiStorySeedTurn(workspaceRoot, outlineRelativePath, validOutline());
  assert.equal(existsSync(outlinePath), true, "Pi must create the requested App Workspace artifact");
  assert.match(readFileSync(outlinePath, "utf8"), /第 30 章/);
  assert.ok(
    events.some((event) => event.type === "tool.started" && event.toolId === "write"),
    "the Pi native write must remain observable",
  );
  assert.ok(
    events.some((event) => event.type === "tool.finished" && event.toolId === "write"),
    "the Pi native write must reach a terminal tool event",
  );

  const validation = spawnSync(process.execPath, [cli, "validate", outlinePath, "--json"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(
    validation.status,
    0,
    `story-seed validate must find the Pi-written artifact\n${validation.stdout}\n${validation.stderr}`,
  );
  const result = JSON.parse(validation.stdout) as { ok?: boolean; outlinePath?: string };
  assert.equal(result.ok, true, validation.stdout);
  if (!realCli) assert.equal(result.outlinePath, outlinePath);

  console.log(`pi story seed business e2e passed (${realCli ? "installed CLI" : "portable contract fixture"})`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function runPiStorySeedTurn(cwd: string, targetPath: string, outline: string): Promise<AgentEvent[]> {
  const model: Model<"test"> = {
    id: "pi-story-seed-business-e2e",
    name: "Pi Story Seed business E2E",
    api: "test",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_000,
  };
  const runtime = new PiAgentRuntime({
    createSession: createNativePiSessionFactory({
      cwd,
      model,
      streamFn: (_model, context) => {
        const hasWriteResult = context.messages.some(
          (message) => message.role === "toolResult" && message.toolName === "write",
        );
        if (!hasWriteResult) {
          return assistantStream(
            model,
            [
              {
                type: "toolCall",
                id: "pi-story-seed-write",
                name: "write",
                arguments: { path: targetPath, content: outline },
              },
            ],
            "toolUse",
          );
        }
        return assistantStream(model, [{ type: "text", text: "章节大纲已写入 App Workspace。" }], "stop");
      },
    }),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "pi-story-seed-business-run",
    input: `生成章节大纲并写入 ${targetPath}`,
    context: testContext(),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    accessMode: "full-access",
  })) {
    events.push(event);
  }
  return events;
}

function testContext(): AgentContext {
  return {
    sessionId: "pi-story-seed-business-session",
    activity: undefined as never,
    sessions: undefined as never,
    memory: undefined as never,
    artifacts: undefined as never,
    skills: undefined as never,
    executions: undefined as never,
    packs: undefined as never,
    workingState: new WorkingStateStore(),
    approvals: new ApprovalInbox(),
    questions: new QuestionInbox(),
  };
}

function assistantStream(model: Model<"test">, content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message: AssistantMessage = {
      role: "assistant" as const,
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    content.forEach((part, contentIndex) => {
      if (part.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
      } else if (part.type === "text") {
        const text = String(part.text || "");
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex, content: text, partial: message });
      }
    });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

function validOutline(): string {
  const chapters = Array.from({ length: 30 }, (_, index) => {
    const chapter = index + 1;
    return [
      `第 ${chapter} 章：能力回归章节 ${chapter}`,
      "- 视角人物：主角。",
      "- 场景目标：主角完成一个不可跳过的具体目标。",
      "- 核心冲突：对手迫使主角做出改变后续路径的选择。",
      "- 章末钩子：高潮制造主动后果并迫使主角下一章立刻行动，同时揭开更危险的新线索。",
      "- 关键揭示：一个新事实改变主角对局势的理解。",
      "- 章节高潮：主角付出代价并作出关键选择。",
      "- 对白重点：围绕目标与阻力展开对抗并暴露立场。",
    ].join("\n");
  }).join("\n\n");
  return `# 大纲提交稿

## 一、故事基础信息
题材类型：都市悬疑
背景设定：当代城市。
核心卖点：被低估的主角在危机中夺回主动权。

## 二、角色表
姓名：主角
身份：调查者
性格特征：克制而敏锐。
核心动机：保护重要的人。
关键关系：与旧日敌人存在未清算的秘密。

## 三、付费点
免费章节：第1章 - 第6章
付费起始：第7章

## 四、分章大纲

${chapters}
`;
}

function writeFixtureCli(path: string): void {
  writeFileSync(
    path,
    `const fs = require("node:fs");
const outlinePath = process.argv[3];
const text = outlinePath && fs.existsSync(outlinePath) ? fs.readFileSync(outlinePath, "utf8") : "";
const chapters = text.match(/^第 \\d+ 章：/gm) || [];
const ok = Boolean(outlinePath) && chapters.length === 30 && text.includes("## 四、分章大纲");
process.stdout.write(JSON.stringify({ ok, outlinePath }));
process.exit(ok ? 0 : 1);
`,
    "utf8",
  );
}
