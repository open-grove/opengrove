import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, FileError, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createAssistantMessageEventStream, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import { createNativePiSessionFactory } from "../runtime/native-pi-session.js";
import { PiAgentRuntime } from "../runtime/pi-runtime.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent } from "../core.js";

const model: Model<"openai-completions"> = {
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4000,
};
const identity = { sessionId: "lifecycle", system: "", tools: [], skills: [], packs: [], capabilities: [] };

function reply() {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "recovered" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}

test("concurrent first access creates a single native Harness", async (t) => {
  const create = t.mock.method(AgentHarness, "create");
  const factory = createNativePiSessionFactory({ model, streamFn: reply });
  const session = factory(identity);
  await Promise.all([session.trace?.(), session.trace?.(), session.trace?.()]);
  assert.equal(create.mock.callCount(), 1);
  await factory.dispose?.();
});

test("a transient storage fault does not poison later Pi turns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "og-pi-fault-"));
  const env = new NodeExecutionEnv({ cwd });
  const append = env.appendFile.bind(env);
  let unavailable = false;
  env.appendFile = async (...args) =>
    unavailable ? { ok: false, error: new FileError("unknown", "synthetic storage outage") } : append(...args);
  const factory = createNativePiSessionFactory({ model, cwd, sessionRoot: cwd, executionEnv: env, streamFn: reply });
  const runtime = new PiAgentRuntime({ createSession: factory });
  const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime });
  const context = {
    sessionId: identity.sessionId,
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
  const run = async () => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({ input: "synthetic turn", context, tools: [] })) events.push(event);
    return events;
  };
  try {
    await factory(identity).trace?.();
    unavailable = true;
    const failed = await run();
    assert.equal(failed.filter((event) => event.type === "error").length, 1);
    unavailable = false;
    const recovered = await run();
    assert.deepEqual(
      recovered.filter((event) => event.type === "error"),
      [],
    );
    assert.ok(recovered.some((event) => event.type === "model.response" && event.response.text === "recovered"));
  } finally {
    await factory.dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancellation close failures release the old Harness before the next turn", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "og-pi-close-failure-"));
  const create = t.mock.method(AgentHarness, "create");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let stalled = true;
  const factory = createNativePiSessionFactory({
    model,
    cwd,
    sessionRoot: cwd,
    abortSettleTimeoutMs: 10,
    streamFn: () => {
      if (!stalled) return reply();
      const stream = createAssistantMessageEventStream();
      markStarted();
      return stream;
    },
  });
  const runtime = new PiAgentRuntime({ createSession: factory });
  const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime });
  const context = {
    sessionId: identity.sessionId,
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
  const run = async (signal?: AbortSignal) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({ input: "test close", context, tools: [], signal })) events.push(event);
    return events;
  };
  try {
    await factory(identity).trace?.();
    const opened = await create.mock.calls[0]!.result;
    assert.ok(opened);
    const close = opened.harness.close.bind(opened.harness);
    t.mock.method(opened.harness, "close", async () => {
      await close(BACKGROUND_CONTEXT);
      throw new Error("synthetic close failure");
    });
    const abort = new AbortController();
    const pending = run(abort.signal);
    await started;
    abort.abort();
    const stopped = await pending;
    assert.ok(stopped.some((event) => event.type === "error" && event.message.includes("synthetic close failure")));
    assert.ok(!stopped.some((event) => event.type === "error" && event.message.includes("HarnessClosed")));
    stalled = false;
    const recovered = await run();
    assert.deepEqual(
      recovered.filter((event) => event.type === "error"),
      [],
    );
    assert.ok(recovered.some((event) => event.type === "model.response" && event.response.text === "recovered"));
  } finally {
    await factory.dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
});
