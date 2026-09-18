import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenGrove } from "../../dist/app/create-opengrove.js";
import { OpenClawGatewayRuntime } from "../../dist/runtime/openclaw-gateway-runtime.js";

// Capture real native Gateway provider requests without model credentials.
export async function startOpenClawContextFixture(stateDir) {
  const requests = [];
  let canceledConnection = false;
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const lastUser = request.messages.filter((message) => message.role === "user").at(-1);
    if (JSON.stringify(lastUser).includes("CANCEL_NATIVE_TURN")) {
      res.on("close", () => {
        canceledConnection = true;
      });
      return;
    }
    const content = `CONTEXT_OK ${"fixture answer ".repeat(300)}`;
    if (!request.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          model: request.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: request.model, choices: [choice] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(
    join(stateDir, "openclaw.json"),
    JSON.stringify({
      gateway: { mode: "local" },
      agents: {
        defaults: {
          workspace: join(stateDir, "workspace"),
          skipBootstrap: true,
          model: { primary: "hostfixture/context-model" },
          heartbeat: { every: "0m" },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          hostfixture: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: "local-fixture-key",
            api: "openai-completions",
            models: [
              {
                id: "context-model",
                name: "Context fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      cron: { enabled: false },
      discovery: { mdns: { mode: "off" } },
    }),
  );
  return {
    async verify(url, token) {
      const app = createOpenGrove({ cwd: stateDir, runtime: { async *runTurn() {} }, readPage: async () => ({}) });
      const context = {
        sessionId: "host-context-probe",
        activity: "chat",
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
      const options = { url, token, configuredModel: "hostfixture/context-model", requestTimeoutMs: 30_000 };
      let runtime = new OpenClawGatewayRuntime(options);
      const run = async (room, language = "en", signal) => {
        const events = [];
        for await (const event of runtime.runTurn({
          runId: `probe-${room}`,
          input: `question-${room}`,
          context,
          tools: [],
          signal,
          sessionInstructions: "STABLE_EMPLOYEE_RULE",
          replyLanguagePreference: language,
          assembledContext: {
            id: `ctx-${room}`,
            createdAt: new Date().toISOString(),
            summary: "fixture",
            items: [],
            hostState: [{ id: "room", text: room }],
            turnInstructions: [{ id: "task", text: `INSTRUCTIONS_${room}` }],
            promptBlock: `ATTACHMENT_${room}`,
            budget: { maxItems: 8, usedItems: 0, maxCharacters: 6000, usedCharacters: 0, truncated: false },
          },
        }))
          events.push(event);
        return events;
      };
      const assertCompleted = (events) => {
        assert.deepEqual(
          events.filter((event) => event.type === "error"),
          [],
        );
        assert.match(events.find((event) => event.type === "model.response")?.response.text ?? "", /CONTEXT_OK/);
      };
      const inspect = (room, language) => {
        const request = requests.at(-1);
        assert.equal(request.model, "context-model");
        const system = JSON.stringify(
          request.messages.filter((message) => ["system", "developer"].includes(message.role)),
        );
        const users = request.messages.filter((message) => message.role === "user");
        assert.match(system, /STABLE_EMPLOYEE_RULE/);
        assert.doesNotMatch(system, /ATTACHMENT_ROOM_|INSTRUCTIONS_ROOM_|Default response language/);
        assert.doesNotMatch(JSON.stringify(users), /STABLE_EMPLOYEE_RULE/);
        assert.match(JSON.stringify(users.at(-1)), new RegExp(`INSTRUCTIONS_${room}`));
        assert.match(JSON.stringify(users.at(-1)), new RegExp(language));
        return { system, users };
      };
      try {
        assertCompleted(await run("ROOM_ONE", "zh-CN"));
        const first = inspect("ROOM_ONE", "Simplified Chinese");
        runtime.close();
        runtime = new OpenClawGatewayRuntime(options);
        assertCompleted(await run("ROOM_TWO"));
        const second = inspect("ROOM_TWO", "English");
        assert.equal(second.system, first.system, "Host state updates must preserve the native system prefix");
        assert.match(JSON.stringify(second.users), /question-ROOM_ONE/, "Gateway reconnect must retain native history");
        const compacted = await runtime.compactSession({ runId: "probe-compact", threadId: context.sessionId });
        assert.equal(compacted.ok, true, JSON.stringify(compacted));
        assert.equal(compacted.compacted, true);
        assertCompleted(await run("ROOM_THREE"));
        inspect("ROOM_THREE", "English");
        const controller = new AbortController();
        const canceled = run("CANCEL_NATIVE_TURN", "en", controller.signal);
        try {
          await waitUntil(() => JSON.stringify(requests.at(-1)).includes("CANCEL_NATIVE_TURN"));
        } finally {
          controller.abort();
        }
        const canceledEvents = await canceled;
        assert.equal(
          canceledEvents.find((event) => event.type === "turn.finished")?.outcome?.taskState,
          "TASK_STATE_CANCELED",
        );
        await waitUntil(() => canceledConnection);
        process.stdout.write(
          "Native OpenClaw context: system/user separation, reconnect, compaction recovery and provider cancellation passed.\n",
        );
      } finally {
        runtime.close();
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Native Gateway fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
