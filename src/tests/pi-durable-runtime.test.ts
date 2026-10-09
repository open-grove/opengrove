import { createNativePiSessionFactory as createLegacyFactory } from "../runtime/native-pi-session.compat.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { createNativePiSessionFactory } from "../runtime/native-pi-session.js";
import { PiAgentRuntime } from "../runtime/pi-runtime.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent, ToolDefinition } from "../core.js";

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function reply(context: Context, seen: Context[]) {
  seen.push(context);
  const last = context.messages.at(-1);
  const content: AssistantMessage["content"] =
    last?.role !== "toolResult" && JSON.stringify(last).includes("call echo")
      ? [{ type: "toolCall", id: `call-${seen.length}`, name: "opengrove_0_test_echo", arguments: { text: "CEDAR" } }]
      : [{ type: "text", text: last?.role === "toolResult" ? JSON.stringify(last.content) : "Native reply" }];
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    stream.end();
  });
  return stream;
}
test("Pi 1.1 OpenGrove consumer uses native tool policy and resumes its own durable conversation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opengrove-pi-durable-"));
  const seen: Context[] = [];
  let calls = 0;
  const options = {
    cwd,
    sessionRoot: join(cwd, "sessions"),
    model,
    streamFn: (_model: Model<string>, context: Context) => reply(context, seen),
  };
  let factory = createNativePiSessionFactory(options);
  let runtime = new PiAgentRuntime({ createSession: factory, workspaceRoot: cwd });
  const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime });
  const context = {
    sessionId: "consumer",
    activity: "chat" as const,
    memory: app.memory,
    artifacts: app.artifacts,
    skills: app.skills,
    packs: app.packs,
    sessions: app.sessions,
    executions: app.executions,
    workingState: app.workingState,
    approvals: app.approvals,
    questions: app.questions,
  };
  const tool: ToolDefinition = {
    spec: {
      id: "test.echo",
      title: "Echo",
      description: "Echo text",
      activity: "chat",
      risk: "write",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      permission: { mode: "ask", reason: "Product approval" },
    },
    execute: async (input) => {
      calls++;
      return { ok: true, value: input };
    },
  };
  const run = async (input: string, approve: boolean) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({ input, context, tools: [tool] })) {
      events.push(event);
      if (event.type === "approval.requested")
        app.approvals.decide(event.request.id, approve ? "approved" : "rejected");
    }
    assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
    assert.equal(
      events.find((event) => event.type === "turn.finished")?.outcome?.taskState,
      "TASK_STATE_COMPLETED",
      JSON.stringify(events.filter((event) => event.type === "error")),
    );
    return events;
  };
  try {
    const rejected = await run("call echo", false);
    assert.equal(calls, 0);
    assert.ok(rejected.some((event) => event.type === "approval.requested"));
    await run("call echo", true);
    assert.equal(calls, 1);
    const before = await factory({
      sessionId: "consumer",
      system: "",
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }).trace?.();
    await factory.dispose?.();
    factory = createNativePiSessionFactory(options);
    runtime = new PiAgentRuntime({ createSession: factory, workspaceRoot: cwd });
    await run("Continue without tools", true);
    const after = await factory({
      sessionId: "consumer",
      system: "",
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    }).trace?.();
    assert.equal(after?.nativeSessionId, before?.nativeSessionId);
    assert.ok((after?.priorMessageCount ?? 0) > (before?.priorMessageCount ?? 0));
    assert.ok(seen.some((native) => JSON.stringify(native.messages).includes("opengrove_0_test_echo")));
    assert.equal((await factory.forkSession?.("consumer", "fork"))?.forked, true);
    assert.equal((await factory.listSessions?.())?.length, 2);
    assert.equal((await factory.deleteSession?.("fork"))?.error, "pi_durable_native_delete_unsupported");
  } finally {
    await factory.dispose?.();
  }
});

test("Pi upgrade selects the explicit compatibility adapter for an existing native 0.85 session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opengrove-pi-upgrade-"));
  const seen: Context[] = [];
  const options = {
    cwd,
    sessionRoot: join(cwd, "sessions"),
    model,
    streamFn: (_model: Model<string>, context: Context) => reply(context, seen),
  };
  const legacy = createLegacyFactory({ cwd, sessionRoot: options.sessionRoot, model: { ...model, compat: undefined } });
  const identity = {
    sessionId: "existing",
    system: "Keep history",
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
  };
  const before = await legacy(identity).trace?.();
  await legacy.dispose?.();
  const latest = createNativePiSessionFactory(options);
  try {
    const after = await latest(identity).trace?.();
    assert.equal(after?.nativeSessionId, before?.nativeSessionId);
    assert.equal(after?.nativeSessionId, "opengrove-session:existing");
    assert.equal((await latest.listSessions?.())?.length, 1);
  } finally {
    await latest.dispose?.();
  }
});
