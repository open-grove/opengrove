import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent, AgentTurnRequest } from "../core.js";
import type { KernelCapabilityId, KernelContractTestEvidence } from "../kernel/capabilities/types.js";
import { createClaudeSdkHostBridge } from "../runtime/claude-agent-sdk-tools.js";
import {
  claudePlanningEventsForToolFinished,
  claudePlanningEventsForToolStarted,
  createClaudePlanningState,
} from "../runtime/claude-planning.js";
import { AcpCliRuntime } from "../runtime/acp-cli-runtime.js";
import { AsyncEventQueue } from "../runtime/codex/async-event-queue.js";
import { handleCodexUserInputRequest } from "../runtime/codex/approval-bridge.js";
import { CodexEventProjector } from "../runtime/codex/event-projector.js";
import { HermesRuntime } from "../runtime/hermes-runtime.js";
import { writeFakeAcpCommand, writeFakeAcpServer } from "./harnesses/fake-acp-server.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";

export interface KernelCapabilityContractCase {
  testId: string;
  kernel: string;
  capability: KernelCapabilityId;
  run(): Promise<void>;
}

export interface KernelCapabilityContractRunOptions {
  checkedAtByTestId?: ReadonlyMap<string, string>;
  defaultCheckedAt?: string;
}

export const KERNEL_CAPABILITY_CONTRACT_CASES: KernelCapabilityContractCase[] = [
  {
    testId: "codex.interaction.askUser",
    kernel: "codex",
    capability: "interaction.askUser",
    run: assertCodexAskUserContract,
  },
  {
    testId: "codex.planning.plan",
    kernel: "codex",
    capability: "planning.plan",
    run: assertCodexPlanningProjectorContract,
  },
  {
    testId: "claude-code.interaction.askUser",
    kernel: "claude-code",
    capability: "interaction.askUser",
    run: assertClaudeAskUserContract,
  },
  {
    testId: "claude-code.planning.plan",
    kernel: "claude-code",
    capability: "planning.plan",
    run: assertClaudePlanningContract,
  },
  {
    testId: "opencode.message.streamText",
    kernel: "opencode",
    capability: "message.streamText",
    run: assertOpenCodeStreamTextContract,
  },
  {
    testId: "hermes.message.streamText",
    kernel: "hermes",
    capability: "message.streamText",
    run: assertHermesStreamTextContract,
  },
  {
    testId: "hermes.approval.request",
    kernel: "hermes",
    capability: "approval.request",
    run: assertHermesApprovalContract,
  },
  {
    testId: "hermes.interaction.askUser",
    kernel: "hermes",
    capability: "interaction.askUser",
    run: assertHermesQuestionContract,
  },
  {
    testId: "hermes.control.stop",
    kernel: "hermes",
    capability: "control.stop",
    run: assertHermesStopContract,
  },
  {
    testId: "hermes.diagnostics.usage",
    kernel: "hermes",
    capability: "diagnostics.usage",
    run: assertHermesUsageContract,
  },
];

export async function runKernelCapabilityContractCases(
  options: KernelCapabilityContractRunOptions = {},
): Promise<KernelContractTestEvidence[]> {
  const evidence: KernelContractTestEvidence[] = [];
  const defaultCheckedAt = options.defaultCheckedAt ?? new Date().toISOString().slice(0, 10);
  for (const testCase of KERNEL_CAPABILITY_CONTRACT_CASES) {
    await testCase.run();
    evidence.push({
      kernel: testCase.kernel,
      capability: testCase.capability,
      testId: testCase.testId,
      passed: true,
      checkedAt: options.checkedAtByTestId?.get(testCase.testId) ?? defaultCheckedAt,
      verification: "simulated",
      source: "Adapter/projector contract case using local fake runtime fixtures.",
    });
  }
  return evidence;
}

async function assertCodexAskUserContract(): Promise<void> {
  const { request, app } = createContractRequest("capability-codex-ask-user");
  const queue = new AsyncEventQueue<AgentEvent>();
  const responsePromise = handleCodexUserInputRequest(
    {
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "name", prompt: "Name?" }],
      },
    },
    {
      runId: "run-capability-ask-user",
      request,
      queue,
    },
  );
  const iterator = queue[Symbol.asyncIterator]();
  const requested = await iterator.next();
  assert.equal(requested.done, false);
  assert.equal(requested.value.type, "question.requested");
  if (requested.value.type !== "question.requested") {
    throw new Error("expected question.requested");
  }
  assert.equal(app.approvals.list().length, 0);
  app.questions.decide(requested.value.question.id, "answered", { answers: { name: "Ada" } });
  const response = await responsePromise;
  assert.deepEqual(response, { answers: { name: { answers: ["Ada"] } } });
  const answered = await iterator.next();
  assert.equal(answered.done, false);
  assert.equal(answered.value.type, "question.answered");

  const noAnswerController = new AbortController();
  const { request: noAnswerRequest, app: noAnswerApp } = createContractRequest("capability-codex-ask-user-no-answer");
  noAnswerRequest.signal = noAnswerController.signal;
  const noAnswerQueue = new AsyncEventQueue<AgentEvent>();
  const noAnswerResponsePromise = handleCodexUserInputRequest(
    {
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "name", prompt: "Name?" }],
      },
    },
    {
      runId: "run-capability-ask-user-no-answer",
      request: noAnswerRequest,
      queue: noAnswerQueue,
    },
  );
  const noAnswerIterator = noAnswerQueue[Symbol.asyncIterator]();
  const noAnswerRequested = await noAnswerIterator.next();
  assert.equal(noAnswerRequested.value.type, "question.requested");
  noAnswerController.abort();
  assert.deepEqual(await noAnswerResponsePromise, { answers: {} });
  const noAnswerResolved = await noAnswerIterator.next();
  assert.equal(noAnswerResolved.value.type, "question.answered");
  if (noAnswerResolved.value.type === "question.answered") {
    assert.equal(noAnswerResolved.value.question.status, "declined");
    assert.deepEqual(noAnswerResolved.value.question.response, { reason: "aborted" });
  }
  assert.equal(noAnswerApp.questions.list("pending").length, 0);
  noAnswerQueue.close();
  assert.equal((await noAnswerIterator.next()).done, true, "no-answer continuation must not enqueue a run error");
}

async function assertCodexPlanningProjectorContract(): Promise<void> {
  const queue = new AsyncEventQueue<AgentEvent>();
  const projector = new CodexEventProjector("run-capability-plan", "thread-capability-plan", queue);
  projector.handleNotification(
    {
      method: "turn/plan/updated",
      params: {
        threadId: "thread-capability-plan",
        turnId: "turn-capability-plan",
        explanation: "Probe plan",
        plan: [
          { step: "Inspect the workspace", status: "inProgress" },
          { step: "Return the reference id", status: "pending" },
        ],
      },
    },
    "turn-capability-plan",
  );

  const event = await queue[Symbol.asyncIterator]().next();
  assert.equal(event.done, false);
  assert.equal(event.value.type, "planning.updated");
  if (event.value.type === "planning.updated") {
    assert.equal(event.value.plan.id, "turn-capability-plan");
    assert.equal(event.value.plan.status, "inProgress");
    assert.equal(event.value.plan.text.includes("Probe plan"), true);
    assert.equal(event.value.plan.text.includes("[inProgress] Inspect the workspace"), true);
  }
}

async function assertClaudePlanningContract(): Promise<void> {
  const state = createClaudePlanningState();
  const toolInput = { subject: "Prepare reply", description: "Prepare the final reply" };
  const started = claudePlanningEventsForToolStarted({
    runId: "run-capability-claude-plan",
    callId: "toolu-capability-task",
    toolName: "TaskCreate",
    toolInput,
    state,
  });
  assert.equal(started[0]?.type, "planning.updated");

  claudePlanningEventsForToolFinished({
    runId: "run-capability-claude-plan",
    callId: "toolu-capability-task",
    toolName: "TaskCreate",
    toolInput,
    toolResult: { task: { id: "task-capability", subject: "Prepare reply" } },
    resultOk: true,
    state,
  });
  const updated = claudePlanningEventsForToolFinished({
    runId: "run-capability-claude-plan",
    callId: "toolu-capability-update",
    toolName: "TaskUpdate",
    toolInput: { taskId: "task-capability", status: "completed" },
    toolResult: {
      success: true,
      taskId: "task-capability",
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "completed" },
    },
    resultOk: true,
    state,
  });
  const event = updated[0];
  assert.equal(event?.type, "planning.updated");
  if (event?.type === "planning.updated") {
    assert.equal(event.plan.id, "claude-tasks");
    assert.equal(event.plan.text, "1. [completed] Prepare reply");
  }
}

async function assertClaudeAskUserContract(): Promise<void> {
  const { request, app } = createContractRequest("capability-claude-ask-user");
  const queue = new AsyncEventQueue<AgentEvent>();
  const bridge = createClaudeSdkHostBridge(request, "run-capability-claude-ask-user", queue);
  const controller = new AbortController();
  const permissionPromise = bridge.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Pick one?",
          header: "Choice",
          options: [
            { label: "A", description: "Use A." },
            { label: "B", description: "Use B." },
          ],
          multiSelect: false,
        },
      ],
    },
    {
      signal: controller.signal,
      title: "Claude needs input",
      displayName: "Ask",
      description: "Pick a branch",
      toolUseID: "toolu_question",
      requestId: "request_question",
    },
  );

  const iterator = queue[Symbol.asyncIterator]();
  const requested = await iterator.next();
  assert.equal(requested.done, false);
  assert.equal(requested.value.type, "question.requested");
  if (requested.value.type !== "question.requested") {
    throw new Error("expected question.requested");
  }
  assert.equal(app.approvals.list().length, 0);
  app.questions.decide(requested.value.question.id, "answered", { answers: { Choice: "A" } });
  const permission = await permissionPromise;
  assert.ok(permission, "Claude permission callback should return an in-band decision");
  assert.equal(permission.behavior, "allow");
  if (permission.behavior !== "allow") {
    throw new Error("expected Claude permission allow result");
  }
  assert.deepEqual(permission.updatedInput?.answers, { "Pick one?": "A" });
  const answered = await iterator.next();
  assert.equal(answered.done, false);
  assert.equal(answered.value.type, "question.answered");
}

async function assertOpenCodeStreamTextContract(): Promise<void> {
  const events = await runOpenCodeAcpContractTurn();
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.text.includes("FAKE_OPENCODE_ACP_OK")));
  assert.ok(
    events.some((event) => event.type === "model.response" && event.response.text.includes("FAKE_OPENCODE_ACP_OK")),
  );
}

async function assertHermesStreamTextContract(): Promise<void> {
  const events = await runHermesGatewayContractTurn();
  assert.ok(
    events.some((event) => event.type === "assistant.delta" && event.text.includes("FAKE_HERMES_GATEWAY_CONTRACT_OK")),
  );
  assert.ok(
    events.some(
      (event) => event.type === "model.response" && event.response.text.includes("FAKE_HERMES_GATEWAY_CONTRACT_OK"),
    ),
  );
}

async function assertHermesApprovalContract(): Promise<void> {
  const events = await runHermesGatewayContractTurn();
  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "approval.resolved"));
  assert.ok(events.some((event) => event.type === "model.response" && event.response.text.includes("APPROVAL:allow")));
}

async function assertHermesQuestionContract(): Promise<void> {
  const events = await runHermesGatewayContractTurn();
  assert.ok(events.some((event) => event.type === "question.requested"));
  assert.ok(events.some((event) => event.type === "question.answered"));
  assert.ok(events.some((event) => event.type === "model.response" && event.response.text.includes("ANSWER:alpha")));
}

async function assertHermesStopContract(): Promise<void> {
  const events = await runHermesGatewayContractTurn({ holdUntilInterrupt: true, abortAfterModelRequested: true });
  assert.ok(events.some((event) => event.type === "model.response" && event.response.text.includes("INTERRUPTED")));
}

async function assertHermesUsageContract(): Promise<void> {
  const events = await runHermesGatewayContractTurn();
  const response = events.find(
    (event): event is Extract<AgentEvent, { type: "model.response" }> => event.type === "model.response",
  );
  assert.deepEqual(response?.response.usage, { inputTokens: 7, outputTokens: 11, totalTokens: 18, costUsd: 0.001 });
}

async function runOpenCodeAcpContractTurn(): Promise<AgentEvent[]> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-opencode-acp-contract-"));
  mkdirSync(cwd, { recursive: true });
  const fakeCli = join(cwd, process.platform === "win32" ? "fake-opencode.mjs" : "fake-opencode.sh");
  const fakeServer = join(cwd, "fake-opencode-acp-server.mjs");
  writeFakeAcpServer(fakeServer, {
    sessionId: "fake-opencode-acp-session",
    marker: "FAKE_OPENCODE_ACP_OK",
  });
  writeFakeAcpCommand(fakeCli, fakeServer, {
    commandName: "fake-opencode",
    acpSubcommand: "acp",
  });
  const runtime = new AcpCliRuntime({
    kernelId: "opencode",
    title: "OpenCode",
    command: fakeCli,
    acpArgs: ["acp"],
    cwd,
    configuredModel: "opencode-test",
  });
  const { request } = createContractRequest("capability-opencode-acp");
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    ...request,
    runId: "run-capability-opencode-acp",
    input: "hello opencode acp",
  })) {
    events.push(event);
  }
  runtime.close();
  return events;
}

async function runHermesGatewayContractTurn(
  options: { holdUntilInterrupt?: boolean; abortAfterModelRequested?: boolean } = {},
): Promise<AgentEvent[]> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-gateway-contract-"));
  mkdirSync(cwd, { recursive: true });
  const fakeGateway = join(cwd, "fake-hermes-gateway.mjs");
  writeFakeHermesGateway(fakeGateway, {
    sessionId: "fake-hermes-gateway-contract-session",
    marker: "FAKE_HERMES_GATEWAY_CONTRACT_OK",
    holdUntilInterrupt: options.holdUntilInterrupt,
  });
  const runtime = new HermesRuntime({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [fakeGateway],
    cwd,
    configuredModel: "hermes-contract",
  });
  const { request, app } = createContractRequest("capability-hermes-gateway");
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  for await (const event of runtime.runTurn({
    ...request,
    runId: "run-capability-hermes-gateway",
    input: "hello hermes gateway",
    signal: controller.signal,
  })) {
    events.push(event);
    if (options.abortAfterModelRequested && event.type === "model.requested") {
      setTimeout(() => controller.abort(), 10);
    }
    if (event.type === "approval.requested") {
      app.approvals.decide(event.request.id, "approved", {});
    }
    if (event.type === "question.requested") {
      app.questions.decide(event.question.id, "answered", { answer: "alpha" });
    }
  }
  runtime.close();
  return events;
}

function createContractRequest(sessionId: string): {
  app: ReturnType<typeof createOpenGrove>;
  request: AgentTurnRequest;
} {
  const app = createOpenGrove({
    cwd: process.cwd(),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        return;
      },
    },
  });
  return {
    app,
    request: {
      input: "contract input",
      context: {
        sessionId,
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
      tools: [],
    },
  };
}
