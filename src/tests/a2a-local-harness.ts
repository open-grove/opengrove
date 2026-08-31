import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEvent } from "../core.js";
import type { A2ATask } from "#agent-protocol";
import { createBridgeState } from "../server/bridge-state.js";
import { handleA2ARoute } from "../server/routes/a2a.js";
import { roomExecutionState } from "../server/room-runs/execution-state.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-a2a-local-"));
const stateHolder: { value?: ReturnType<typeof createBridgeState> } = {};

try {
  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  stateHolder.value = state;
  state.settings.kernelPathOverrides.codex = { binaryPath: process.execPath };
  state.settings.customProviders.push({
    id: "a2a-test-provider",
    name: "A2A Test Provider",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://a2a.example.test/v1",
    apiKey: "a2a-test-key",
    credentialKind: "api-key",
    models: [{ id: "a2a-test-model", label: "A2A Test Model" }],
  });
  state.app.rooms.upsertMember({
    id: "employee-a2a-local",
    name: "A2A Local",
    kernel: "codex",
    model: "a2a-test-model",
    providerId: "a2a-test-provider",
    role: "A public local A2A test employee.",
    status: "idle",
    color: "#2563eb",
    reasoningEffort: "high",
    lastActive: "now",
    source: "local",
    visibility: "public",
    publicDescription: "Helps users operate OpenGrove from an A2A client.",
    publicSkills: ["app setup", "room troubleshooting"],
    inputSpec: "A plain-text setup or troubleshooting question.",
    outputSpec: "A concise answer with next steps.",
  });
  const member = state.app.rooms.listMembers().find((candidate) => candidate.id === "employee-a2a-local");
  assert.ok(member, "public A2A test employee should exist");

  const harnessExecutionState = roomExecutionState(state, member);
  const harnessAdapter = harnessExecutionState.kernelAdapter;
  assert.ok(harnessAdapter, "the A2A harness needs one reusable Kernel worker seam");
  harnessAdapter.runTurn = async function* runFakeTurn(request): AsyncIterable<AgentEvent> {
    const runId = request.runId ?? "fake-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.signal?.aborted) {
      throw new Error("fake_aborted");
    }
    if (request.input.includes("A2A_WAIT_FOR_CANCEL")) {
      await new Promise<void>((resolve, reject) => {
        const signal = request.signal;
        const timer = setTimeout(resolve, 2_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("fake_aborted"));
          },
          { once: true },
        );
      });
    }
    yield {
      type: "model.response",
      runId,
      response: {
        text: "A2A_LOCAL_OK",
      },
    } as AgentEvent;
  };

  const card = await routeJson<{
    name: string;
    description: string;
    skills: Array<{ name: string }>;
    metadata?: {
      ogExtensions?: {
        employeeId?: string;
        kernel?: string;
        model?: string;
        reasoningEffort?: string;
        visibility?: string;
        inputSpec?: string;
        outputSpec?: string;
        publicSkills?: string[];
      };
    };
  }>(state, "GET", `/a2a/agents/${encodeURIComponent(member.id)}/card`);
  assert.equal(card.status, 200);
  assert.equal(card.body.description, "Helps users operate OpenGrove from an A2A client.");
  assert.equal(card.body.metadata?.ogExtensions?.employeeId, member.id);
  assert.equal(card.body.metadata?.ogExtensions?.kernel, member.kernel);
  assert.equal(card.body.metadata?.ogExtensions?.model, member.model);
  assert.equal(card.body.metadata?.ogExtensions?.reasoningEffort, "high");
  assert.equal(card.body.metadata?.ogExtensions?.visibility, "public");
  assert.equal(card.body.metadata?.ogExtensions?.inputSpec, "A plain-text setup or troubleshooting question.");
  assert.equal(card.body.metadata?.ogExtensions?.outputSpec, "A concise answer with next steps.");
  assert.deepEqual(card.body.metadata?.ogExtensions?.publicSkills, ["app setup", "room troubleshooting"]);
  assert.deepEqual(
    card.body.skills.map((skill) => skill.name),
    ["app setup", "room troubleshooting"],
  );

  const sent = await routeJson<A2ATask>(state, "POST", `/a2a/agents/${encodeURIComponent(member.id)}/message:send`, {
    message: {
      messageId: "a2a-msg-ok",
      role: "ROLE_USER",
      parts: [{ text: "只回复 A2A_LOCAL_OK" }],
    },
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.status.state, "TASK_STATE_WORKING");

  const completed = await waitForTask(state, sent.body.id, "TASK_STATE_COMPLETED");
  assert.equal(
    completed.status.message?.parts[0] && "text" in completed.status.message.parts[0]
      ? completed.status.message.parts[0].text
      : "",
    "A2A_LOCAL_OK",
  );

  assert.ok(completed.contextId);
  state.app.rooms.postSystemTargetedMessage({
    roomId: completed.contextId,
    senderName: "Platform",
    text: "INTERNAL_HANDOFF_MUST_NOT_LEAK",
    audience: "internal",
  });
  const taskAfterInternalHandoff = await routeJson<A2ATask>(
    state,
    "GET",
    `/a2a/tasks/${encodeURIComponent(sent.body.id)}`,
  );
  assert.equal(taskAfterInternalHandoff.status, 200);
  assert.equal(
    taskAfterInternalHandoff.body.history?.some((message) =>
      message.parts.some((part) => "text" in part && part.text.includes("INTERNAL_HANDOFF_MUST_NOT_LEAK")),
    ),
    false,
  );

  state.settings.languagePreference = "en";
  const cancelSent = await routeJson<A2ATask>(
    state,
    "POST",
    `/a2a/agents/${encodeURIComponent(member.id)}/message:send`,
    {
      message: {
        messageId: "a2a-msg-cancel",
        role: "ROLE_USER",
        parts: [{ text: "A2A_WAIT_FOR_CANCEL" }],
      },
    },
  );
  assert.equal(cancelSent.status, 202);
  const canceled = await routeJson<A2ATask>(
    state,
    "POST",
    `/a2a/tasks/${encodeURIComponent(cancelSent.body.id)}:cancel`,
    {},
  );
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status.state, "TASK_STATE_CANCELED");
  assert.equal(
    canceled.body.status.message?.parts[0] && "text" in canceled.body.status.message.parts[0]
      ? canceled.body.status.message.parts[0].text
      : "",
    "This reply was canceled.",
  );

  console.log("a2a-local-harness ok");
} finally {
  await stateHolder.value?.store.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function waitForTask(
  state: ReturnType<typeof createBridgeState>,
  taskId: string,
  status: A2ATask["status"]["state"],
): Promise<A2ATask> {
  const deadline = Date.now() + 10_000;
  let lastState: A2ATask["status"]["state"] | undefined;
  let lastTask: A2ATask | undefined;
  while (Date.now() < deadline) {
    const task = await routeJson<A2ATask>(state, "GET", `/a2a/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(task.status, 200);
    if (task.body.status.state === status) return task.body;
    lastTask = task.body;
    lastState = task.body.status.state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Task ${taskId} did not reach ${status}; last state was ${lastState ?? "unknown"}; task=${JSON.stringify(lastTask)}`,
  );
}

async function routeJson<T>(
  state: ReturnType<typeof createBridgeState>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  let status = 0;
  let payload: unknown;
  const request = {
    method,
    headers: { host: "127.0.0.1:37371" },
  } as IncomingMessage;
  const response = {} as ServerResponse;
  const handled = await handleA2ARoute({
    request,
    response,
    url: new URL(`http://127.0.0.1:37371${path}`),
    state,
    sendJson: (_response, code, data) => {
      status = code;
      payload = data;
    },
    readJsonBody: async () => body ?? {},
  });
  assert.equal(handled, true, `A2A route should handle ${method} ${path}`);
  return { status, body: payload as T };
}
