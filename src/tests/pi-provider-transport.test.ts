import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import { createKernelRuntime } from "../kernel/adapter.js";
import { createPiKernelAdapter, buildPiProviderEnv } from "../kernel/adapters/pi.js";

test("Pi's actual model registry dispatches a custom Responses route to /responses", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Transport probe complete" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const cwd = mkdtempSync(join(tmpdir(), "og-pi-responses-"));
  const profile = {
    id: "custom",
    protocol: "openai-compatible" as const,
    wireApi: "responses" as const,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test-key",
    model: "custom-model",
  };
  const adapter = createPiKernelAdapter({
    cwd,
    configuredModel: profile.model,
    env: { ...buildPiProviderEnv(profile), OPENGROVE_DATA_DIR: cwd },
  });
  const runtime = createKernelRuntime(adapter);
  const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime });
  const errors: string[] = [];
  try {
    for await (const event of runtime.runTurn({
      input: "Hi",
      tools: [],
      signal: AbortSignal.timeout(5000),
      context: {
        sessionId: "transport-probe",
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
      },
    })) {
      if (event.type === "error") errors.push(event.message);
    }
    assert.deepEqual(paths, ["/v1/responses"]);
    assert.equal(errors.length, 1, "one failed provider request must emit one error");
    assert.ok(errors.some((message) => message.includes("Transport probe complete")));
  } finally {
    await adapter.dispose?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
