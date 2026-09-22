import assert from "node:assert/strict";
import { test } from "node:test";
import { connectOpenGrove } from "../dist/index.js";

function hostFixture() {
  let completed = false;
  let toolFinished = false;
  const requests = [];
  const fetch = async (request) => {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, query: url.searchParams });
    let body;
    if (url.pathname.endsWith("/bootstrap")) body = { ok: true };
    else if (url.pathname.endsWith("/runs") && request.method === "POST")
      body = { ok: true, runId: "run-1", sessionId: "session-1" };
    else if (url.pathname.endsWith("/result") && request.method === "POST") {
      toolFinished = true;
      completed = true;
      body = { ok: true };
    } else if (url.pathname.endsWith("/result"))
      body = {
        ok: true,
        finalized: completed,
        outputAvailable: completed,
        answer: completed ? "Updated" : "",
        run: { id: "run-1", lifecycle: { taskState: completed ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING" } },
      };
    else if (url.pathname.endsWith("/events"))
      body = {
        ok: true,
        cursor: "cursor-1",
        events: [],
        hasMore: false,
        historyTruncated: false,
        resetRequired: false,
      };
    else if (url.pathname.endsWith("/tool-calls"))
      body = {
        ok: true,
        calls: toolFinished
          ? []
          : [{ id: "call-1", runId: "run-1", toolId: "client.edit", input: { title: "New" }, status: "pending" }],
      };
    else throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests };
}

test("external task runs a product handler once and returns the finalized answer", async () => {
  const fixture = hostFixture();
  const op = await connectOpenGrove({ baseUrl: "http://host/api", token: "test", fetch: fixture.fetch });
  let count = 0;
  const task = await op
    .session({
      sessionId: "session-1",
      kernel: "codex",
      model: "test",
      providerId: "$login",
      tools: [
        {
          id: "client.edit",
          description: "Edit",
          inputSchema: {},
          async execute(input, context) {
            count++;
            assert.equal(context.callId, "call-1");
            assert.deepEqual(input, { title: "New" });
            return { ok: true };
          },
        },
      ],
    })
    .run("Edit");
  const result = await task.wait({ pollMs: 50, signal: AbortSignal.timeout(3000) });
  assert.equal(count, 1);
  assert.equal(result.answer, "Updated");
  assert.equal(result.finalized, true);
  assert.ok(fixture.requests.some((request) => request.path.endsWith("/tool-calls/call-1/result")));
});

test("stopping observation and observing again does not repeat an in-flight product side effect", async () => {
  const fixture = hostFixture();
  const op = await connectOpenGrove({ baseUrl: "http://host/api", fetch: fixture.fetch });
  let finish;
  let count = 0;
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const execution = new Promise((resolve) => {
    finish = resolve;
  });
  const task = op.task("run-1", [
    {
      id: "client.edit",
      description: "Edit",
      inputSchema: {},
      async execute() {
        count++;
        started();
        await execution;
        return { ok: true };
      },
    },
  ]);
  const firstObserver = new AbortController();
  const first = task.wait({ signal: firstObserver.signal, pollMs: 50 });
  await didStart;
  firstObserver.abort(new Error("stop_observing"));
  await assert.rejects(first, /stop_observing/);
  const second = task.wait({ signal: AbortSignal.timeout(3000), pollMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(count, 1);
  finish();
  assert.equal((await second).answer, "Updated");
  assert.equal(count, 1);
});

test("completed output stays readable when bounded event history was truncated", async () => {
  let gap;
  const fetch = async (request) => {
    const path = new URL(request.url).pathname;
    const body = path.endsWith("/bootstrap")
      ? { ok: true }
      : path.endsWith("/events")
        ? {
            ok: true,
            cursor: "current",
            events: [],
            hasMore: false,
            historyTruncated: true,
            resetRequired: false,
          }
        : {
            ok: true,
            finalized: true,
            answer: "Persisted complete answer",
            run: { lifecycle: { taskState: "TASK_STATE_COMPLETED" } },
          };
    return Response.json(body);
  };
  const op = await connectOpenGrove({ baseUrl: "http://host/api", fetch });
  const result = await op.task("old-run").wait({
    onHistoryGap: (event) => {
      gap = event;
    },
  });
  assert.equal(result.answer, "Persisted complete answer");
  assert.equal(gap.historyTruncated, true);
});

test("product callbacks are aborted at the Host deadline before task finalization", async () => {
  let callStarted;
  const started = new Promise((resolve) => {
    callStarted = resolve;
  });
  let expired;
  const didExpire = new Promise((resolve) => {
    expired = resolve;
  });
  const until = Date.now() + 200;
  const fetch = async (request) => {
    const path = new URL(request.url).pathname;
    let body = { ok: true };
    if (path.endsWith("/events")) body = { cursor: "one", events: [], hasMore: false };
    else if (path.endsWith("/result"))
      body = { finalized: false, run: { lifecycle: { taskState: "TASK_STATE_WORKING" } } };
    else if (path.endsWith("/tool-calls"))
      body = {
        calls: [
          {
            id: "call",
            toolId: "client.edit",
            input: {},
            status: Date.now() >= until ? "timed_out" : "pending",
            deadlineAt: new Date(until).toISOString(),
          },
        ],
      };
    return Response.json(body);
  };
  const op = await connectOpenGrove({ baseUrl: "http://host/api", fetch });
  const controller = new AbortController();
  const task = op.task("run", [
    {
      id: "client.edit",
      description: "Edit",
      inputSchema: {},
      async execute(input, { signal }) {
        callStarted();
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              expired();
              resolve();
            },
            { once: true },
          );
        });
        return { ok: false, error: "aborted" };
      },
    },
  ]);
  const waiting = task.wait({ signal: controller.signal, pollMs: 50 });
  try {
    await started;
    await Promise.race([
      didExpire,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("deadline_not_propagated")), 600)),
    ]);
  } finally {
    controller.abort(new Error("test_finished"));
    await assert.rejects(waiting, /test_finished/);
  }
});
