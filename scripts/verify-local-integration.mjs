import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { connectOpenGrove } from "@opengrove/sdk";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:37371/api" },
    kernel: { type: "string" },
    model: { type: "string" },
    provider: { type: "string", default: "$login" },
    workspace: { type: "string" },
    "editor-proxy": { type: "boolean", default: false },
  },
});
if (!values.kernel || !values.model || !values.workspace)
  throw new Error("Required: --kernel --model --workspace. Use an isolated project directory.");
const op = await connectOpenGrove({
  baseUrl: values["base-url"],
  token: process.env.OPENGROVE_BRIDGE_TOKEN,
  headers: values["editor-proxy"] ? { "x-editor-client": "1" } : undefined,
});
const config = {
  kernel: values.kernel,
  model: values.model,
  providerId: values.provider,
  workspaceRoot: values.workspace,
};
const inventory = (await op.api.host.runtime.list()).data;
const inspection = (await op.api.host.runtime.inspect({ body: config })).data;
const report = {
  kernel: values.kernel,
  checkedAt: new Date().toISOString(),
  upstreamVersion: inventory.kernels.find((item) => item.id === values.kernel)?.version ?? null,
  inspection,
  checks: {},
};
if (!inspection.available || !inspection.capabilities?.hostTools) {
  report.checks.execution = "blocked_by_runtime_configuration";
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2;
} else {
  let active;
  try {
    const marker = `probe_${randomUUID()}`;
    let count = 0;
    const session = op.session({
      ...config,
      sessionId: `integration-${randomUUID()}`,
      tools: [
        {
          id: "client.integrationProbe",
          description: "Call once to receive the verification marker. Do not substitute native tools.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            count++;
            return { ok: true, value: { marker } };
          },
        },
      ],
    });
    active = await session.run(
      "Call client.integrationProbe exactly once and return the exact marker it returns. Do not use any other tools.",
    );
    const result = await active.wait({ signal: AbortSignal.timeout(90000) });
    assert.equal(result.run.lifecycle.taskState, "TASK_STATE_COMPLETED");
    assert.equal(count, 1);
    assert.ok(result.answer.includes(marker));
    report.checks.productTool = { runId: active.runId, executions: count, passed: true };
    active = await session.run("Return the exact verification marker from the previous turn. Do not call tools.");
    const followup = await active.wait({ signal: AbortSignal.timeout(90000) });
    assert.ok(followup.answer.includes(marker));
    assert.equal(count, 1);
    report.checks.continuation = { runId: active.runId, passed: true };
    let entered;
    const called = new Promise((resolve) => {
      entered = resolve;
    });
    const cancelSession = op.session({
      ...config,
      sessionId: `cancel-${randomUUID()}`,
      tools: [
        {
          id: "client.waitForCancellation",
          description: "Wait for the test to cancel this task.",
          inputSchema: { type: "object", properties: {} },
          async execute(input, { signal }) {
            entered();
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            });
            return { ok: false, error: "canceled" };
          },
        },
      ],
    });
    active = await cancelSession.run("Call client.waitForCancellation now. Do not call other tools.");
    const watching = active.wait({ signal: AbortSignal.timeout(90000) });
    const cancelTimer = setTimeout(() => entered(), 30000);
    await Promise.race([called, watching]);
    clearTimeout(cancelTimer);
    await active.cancel();
    const canceled = await watching;
    assert.equal(canceled.run.lifecycle.taskState, "TASK_STATE_CANCELED");
    report.checks.cancellation = { runId: active.runId, passed: true };
  } catch (error) {
    report.checks.failure = { runId: active?.runId, message: error instanceof Error ? error.message : String(error) };
    await active?.cancel().catch(() => {});
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}
