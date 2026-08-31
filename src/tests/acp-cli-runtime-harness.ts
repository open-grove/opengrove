import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalInbox,
  QuestionInbox,
  SessionStore,
  type AgentContext,
  type AgentEvent,
  type ToolDefinition,
} from "../core.js";
import { AcpCliRuntime } from "../runtime/acp-cli-runtime.js";
import {
  AcpHostToolBridgeServer,
  AcpHostToolBridgeUnavailableError,
  type AcpHostToolBridgeProvider,
} from "../runtime/acp-host-tool-bridge.js";
import type { HostToolBridge } from "../runtime/host-tool-bridge.js";
import { AcpSessionProjector } from "../runtime/projectors/acp.js";
import { buildContextRecords } from "../server/trajectory.js";
import { writeFakeAcpCommand, writeFakeAcpServer, writeFakeOpenCodeServe } from "./harnesses/fake-acp-server.js";
import { RoomChannelStore } from "../rooms/channel-store.js";
import { createRoomLedgerReadTool, withRoomLedgerAccessForRun } from "../tools/rooms.js";
import { createBridgeState } from "../server/bridge-state.js";

async function main() {
  await assertAcpHostToolCredentialsAreScoped();
  const missingIdProjector = new AcpSessionProjector({
    runId: "run-acp-missing-tool-id",
    kernelId: "opencode",
  });
  const missingIdStart = missingIdProjector.project({
    sessionUpdate: "tool_call",
    title: "terminal",
    rawInput: { command: "pwd" },
  });
  const missingIdProgress = missingIdProjector.project({
    sessionUpdate: "tool_call_update",
    status: "in_progress",
    rawOutput: "running",
  });
  const missingIdFinish = missingIdProjector.project({
    sessionUpdate: "tool_call_update",
    status: "completed",
    rawOutput: "ok",
  });
  assert.equal(
    (missingIdStart[0] as Extract<AgentEvent, { type: "tool.started" }>).callId,
    (missingIdProgress[0] as Extract<AgentEvent, { type: "tool.progress" }>).callId,
    "ACP progress must keep the same fallback call ID as tool start",
  );
  assert.equal(
    (missingIdStart[0] as Extract<AgentEvent, { type: "tool.started" }>).callId,
    (missingIdFinish[0] as Extract<AgentEvent, { type: "tool.finished" }>).callId,
    "ACP fallback IDs must stay symmetric when a non-conforming kernel omits toolCallId",
  );

  const ignoredHostToolProjector = new AcpSessionProjector({
    runId: "run-acp-ignored-host-tool",
    kernelId: "kimi",
    ignoreToolCall: (update) => update.name === "opengrove_room.ledger.read",
  });
  assert.deepEqual(
    ignoredHostToolProjector.project({
      sessionUpdate: "tool_call",
      toolCallId: "host-tool-call",
      name: "opengrove_room.ledger.read",
      rawInput: {},
    }),
    [],
  );
  assert.deepEqual(
    ignoredHostToolProjector.project({
      sessionUpdate: "tool_call_update",
      toolCallId: "host-tool-call",
      status: "in_progress",
    }),
    [],
  );
  assert.deepEqual(
    ignoredHostToolProjector.project({
      sessionUpdate: "tool_call_update",
      toolCallId: "host-tool-call",
      status: "completed",
    }),
    [],
    "Host Tool execution must be recorded only by the shared dispatcher",
  );

  const cwd = mkdtempSync(join(tmpdir(), "opengrove-acp-cli-runtime-"));
  mkdirSync(cwd, { recursive: true });
  const fakeCli = fakeAcpCommandPath(cwd, "fake-acp-cli");
  const fakeServer = join(cwd, "fake-acp-server.mjs");
  const fakeServe = join(cwd, "fake-opencode-serve.mjs");
  const compactRecordPath = join(cwd, "compact-records.jsonl");
  const sessionSetupRecordPath = join(cwd, "session-setup-records.jsonl");
  writeFakeAcpServer(fakeServer, {
    sessionId: "fake-generic-acp-session",
    marker: "FAKE_GENERIC_ACP_OK",
    usageUsed: 160_000,
    usageSize: 200_000,
    thoughtText: "ACP_NATIVE_REASONING_PROCESS_TEXT",
    sessionSetupRecordPath,
  });
  writeFakeOpenCodeServe(fakeServe, { recordPath: compactRecordPath });
  writeFakeAcpCommand(fakeCli, fakeServer, {
    commandName: "fake-acp-cli",
    acpSubcommand: "acp",
    serveScriptPath: fakeServe,
  });
  await assertAcpHostToolBridgeFailureClosesLifecycle(cwd);
  await assertAcpHostToolActivationFailureCleansUp(cwd);
  await assertAcpClientGenerationRevokesHostToolBindings(cwd);
  await assertAbortedHostToolTurnCancelsScopedSession(cwd);

  const runtime = new AcpCliRuntime({
    kernelId: "opencode",
    title: "OpenCode",
    command: fakeCli,
    cwd,
    configuredModel: "test-model",
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { "*": "ask" },
      }),
    },
  });

  const events: AgentEvent[] = [];
  const hostTool: ToolDefinition = {
    spec: {
      id: "room.ledger.read",
      title: "Read room ledger",
      description: "Read messages from the current room.",
      activity: "chat",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
      permission: { mode: "allow", reason: "Read-only current-room access." },
    },
    async execute() {
      return { ok: true, value: { sourceRoomId: "room-test", messages: [] } };
    },
  };
  for await (const event of runtime.runTurn({
    runId: "run-acp-cli-harness",
    input: "hello\nfrom acp",
    context: createContext("acp-cli-harness-session"),
    tools: [hostTool],
    replyLanguagePreference: "zh-CN",
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
    assembledContext: {
      id: "ctx-acp-cli",
      createdAt: new Date().toISOString(),
      summary: "fake ACP context",
      items: [],
      budget: {
        maxItems: 10,
        usedItems: 0,
        maxCharacters: 1000,
        usedCharacters: 0,
        truncated: false,
      },
      promptBlock: "Host marker: ACP_CONTEXT_VISIBLE",
    },
  })) {
    events.push(event);
  }
  const response = events.find((event) => event.type === "model.response");
  assert.ok(
    response && response.type === "model.response",
    `ACP CLI runtime should emit model.response; observed ${events.map((event) => event.type).join(", ")}`,
  );
  assert.match(response.response.text, /FAKE_GENERIC_ACP_OK/);
  assert.match(response.response.text, /ACP_CONTEXT_VISIBLE/);
  assert.match(response.response.text, /Default response language: Simplified Chinese/);
  assert.match(response.response.text, /hello\nfrom acp/);
  const sessionSetup = readFileSync(sessionSetupRecordPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: { mcpServers?: unknown[] } });
  assert.equal(sessionSetup[0]?.method, "session/new");
  assert.equal(
    sessionSetup[0]?.params.mcpServers?.length,
    1,
    "ACP session/new must receive the scoped OpenGrove Host Tool MCP server",
  );
  assert.ok(events.some((event) => event.type === "tool.started" && event.toolId === "opencode.terminal"));
  assert.ok(events.some((event) => event.type === "tool.finished" && event.toolId === "opencode.terminal"));
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "tool.started" | "tool.progress" | "tool.finished" }> =>
          (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.finished") &&
          event.toolId === "opencode.terminal",
      )
      .map((event) => event.callId),
    ["tc-1", "tc-1", "tc-1", "tc-1"],
  );
  assert.ok(
    events.some(
      (event) => event.type === "tool.progress" && event.toolId === "opencode.terminal" && event.callId === "tc-1",
    ),
    "ACP tool_call_update must remain visible as tool.progress before completion",
  );
  const contextRecord = buildContextRecords(events)[0];
  assert.ok(contextRecord, "ACP turn should produce a context record");
  assert.equal(
    contextRecord.events.filter((event) => event.type === "tool.progress").length,
    1,
    "trajectory diagnostics should retain only the latest progress snapshot for a tool call",
  );
  assert.equal(
    contextRecord.toolEvents.filter((event) => event.type === "tool.progress").length,
    1,
    "trajectory tool events should retain only the latest progress snapshot for a tool call",
  );
  assert.ok(events.some((event) => event.type === "runtime.diagnostic" && event.name === "opencode.acp.session"));
  const reasoning = events.find((event) => String(event.type) === "reasoning.completed") as unknown as
    | {
        reasoning?: { kind?: string; kernelId?: string; text?: string };
      }
    | undefined;
  assert.equal(reasoning?.reasoning?.kind, "native");
  assert.equal(reasoning?.reasoning?.kernelId, "opencode");
  assert.match(reasoning?.reasoning?.text ?? "", /ACP_NATIVE_REASONING_PROCESS_TEXT/);
  assert.equal(
    events.some(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.finished") && event.toolId === "opencode.reasoning",
    ),
    false,
    "ACP reasoning must not masquerade as a tool call",
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "assistant.delta" && /ACP_NATIVE_REASONING_PROCESS_TEXT/.test(event.text)) ||
        (event.type === "model.response" && /ACP_NATIVE_REASONING_PROCESS_TEXT/.test(event.response.text)),
    ),
    false,
    "ACP thought chunks must stay in process activity and out of the final answer channel",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "opencode.policy.configured" &&
        event.data.permissionMode === "ask",
    ),
  );

  const secondEvents: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-acp-cli-budget-harness",
    input: "second turn",
    context: createContext("acp-cli-harness-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
  })) {
    secondEvents.push(event);
  }
  assert.ok(
    secondEvents.some((event) => event.type === "compaction.finished"),
    "OpenCode should summarize natively before an over-budget turn",
  );
  assert.ok(
    secondEvents.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.usageSource === "native" &&
        event.data.compactionSucceeded === true,
    ),
  );

  const compactResult = await runtime.compactSession({
    runId: "run-acp-cli-harness-compact",
    threadId: "acp-cli-harness-session",
    reason: "harness compact",
  });
  assert.deepEqual(compactResult, { ok: true, compacted: true });
  const compactRecords = readFileSync(compactRecordPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sessionId: string; body: { providerID: string; modelID: string } });
  assert.equal(compactRecords.length, 2, "automatic and manual OpenCode compaction should both use native summarize");
  assert.deepEqual(compactRecords[0], {
    sessionId: "fake-generic-acp-session",
    body: { providerID: "fake-provider", modelID: "fake-model" },
  });
  runtime.close();

  await assertAbortedAcpTurnCloses(cwd, "opencode");
  await assertAbortedAcpTurnCloses(cwd, "kimi");
  await assertAcpImageInput(cwd);
  await assertKimiNativeCompaction(cwd);
  await assertKimiNativeSkillInvocation(cwd);
  await assertKimiUnconfirmedCompactionFailsOpen(cwd);
  await assertAcpHostToolsAcrossNewAndLoad(cwd);
  await assertAcpHostToolKeepsRoomDelegationAuthorization(cwd);
}

async function assertAcpHostToolCredentialsAreScoped(): Promise<void> {
  const server = new AcpHostToolBridgeServer();
  const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const bridge: HostToolBridge = {
    descriptors: [
      {
        name: "opengrove_probe",
        description: "Scoped bridge probe",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    fingerprint: "probe-tools",
    exposedToolIds: ["probe"],
    isToolName: (name) => name === "opengrove_probe",
    async call() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  try {
    const current = await server.prepare({
      scope: { sessionId: "session-a", employeeId: "employee-a", roomId: "room-a" },
      bridge,
    });
    const otherRoom = await server.prepare({
      scope: { sessionId: "session-a", employeeId: "employee-a", roomId: "room-b" },
      bridge,
    });
    const otherEmployee = await server.prepare({
      scope: { sessionId: "session-a", employeeId: "employee-b", roomId: "room-a" },
      bridge,
    });
    const otherSession = await server.prepare({
      scope: { sessionId: "session-b", employeeId: "employee-a", roomId: "room-a" },
      bridge,
    });
    const otherTools = await server.prepare({
      scope: { sessionId: "session-a", employeeId: "employee-a", roomId: "room-a" },
      bridge: { ...bridge, fingerprint: "probe-tools-other" },
    });
    const endpoint = current.mcpServer.env.find((entry) => entry.name === "OPENGROVE_ACP_HOST_TOOL_ENDPOINT")?.value;
    const currentToken = current.mcpServer.env.find((entry) => entry.name === "OPENGROVE_ACP_HOST_TOOL_TOKEN")?.value;
    const otherRoomToken = otherRoom.mcpServer.env.find(
      (entry) => entry.name === "OPENGROVE_ACP_HOST_TOOL_TOKEN",
    )?.value;
    const scopedTokens = [current, otherRoom, otherEmployee, otherSession, otherTools].map(
      (binding) => binding.mcpServer.env.find((entry) => entry.name === "OPENGROVE_ACP_HOST_TOOL_TOKEN")?.value,
    );
    assert.ok(endpoint && currentToken && otherRoomToken && scopedTokens.every(Boolean));
    assert.deepEqual(
      current.mcpServer.env.find((entry) => entry.name === "ELECTRON_RUN_AS_NODE"),
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      "Packaged Electron must run the MCP child as Node",
    );
    assert.equal(
      new Set(scopedTokens).size,
      scopedTokens.length,
      "Session, Employee, Room, and allowed-tool scope must each produce a distinct MCP capability token",
    );
    assert.equal(
      (
        await fetch(`${endpoint}/tools`, {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${endpoint}/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${currentToken}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "opengrove_probe", arguments: {} }),
        })
      ).status,
      409,
      "A scoped credential must not execute outside its active Run",
    );
    current.activate(bridge);
    assert.equal(
      (
        await fetch(`${endpoint}/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${otherRoomToken}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "opengrove_probe", arguments: {} }),
        })
      ).status,
      409,
      "A credential for another Room must not reach the active Run",
    );
    assert.equal(
      (
        await fetch(`${endpoint}/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${currentToken}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "opengrove_probe", arguments: {} }),
        })
      ).status,
      200,
    );
    current.deactivate(bridge);
  } finally {
    server.close();
    if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
  }
}

async function assertAcpHostToolBridgeFailureClosesLifecycle(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-host-bridge-failure-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-host-bridge-failure-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-host-bridge-failure-session",
    marker: "SHOULD_NOT_PROMPT_AFTER_HOST_BRIDGE_FAILURE",
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  const listenFailure = Object.assign(new Error("listen EPERM: operation not permitted 127.0.0.1"), {
    code: "EPERM",
  });
  const provider: AcpHostToolBridgeProvider = {
    async prepare() {
      throw new AcpHostToolBridgeUnavailableError(listenFailure);
    },
    close() {},
  };
  const runtime = new AcpCliRuntime({
    kernelId: "kimi",
    title: "Kimi",
    command: cli,
    cwd,
    hostToolBridgeProvider: provider,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-kimi-host-bridge-failure",
    input: "call the host tool",
    context: createContext("kimi-host-bridge-failure-session"),
    tools: [probeHostTool()],
    skills: [],
    packs: [],
    capabilities: [],
  }))
    events.push(event);
  runtime.close();

  assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  const diagnostic = events.find(
    (event) => event.type === "runtime.diagnostic" && event.name === "kimi.acp.host_tools.unavailable",
  );
  assert.ok(diagnostic && diagnostic.type === "runtime.diagnostic");
  assert.deepEqual(diagnostic.data, {
    code: "EPERM",
    transport: "loopback-http",
    action: "restart_opengrove_or_allow_loopback",
  });
  const failure = events.find((event) => event.type === "error");
  assert.ok(failure && failure.type === "error");
  assert.match(failure.message, /Restart OpenGrove/u);
  assert.doesNotMatch(failure.message, /listen EPERM/u, "Raw listen errors are not actionable user diagnostics");
}

async function assertAcpHostToolActivationFailureCleansUp(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-host-activation-failure-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-host-activation-failure-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-host-activation-failure-session",
    marker: "SHOULD_NOT_PROMPT_AFTER_HOST_ACTIVATION_FAILURE",
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  let deactivations = 0;
  const provider: AcpHostToolBridgeProvider = {
    async prepare() {
      return {
        fingerprint: "activation-failure",
        mcpServer: {
          type: "stdio",
          name: "opengrove",
          command: process.execPath,
          args: [server],
          env: [],
        },
        activate() {
          throw new Error("acp_host_tool_activation_probe_failed");
        },
        deactivate() {
          deactivations += 1;
        },
      };
    },
    close() {},
  };
  const runtime = new AcpCliRuntime({
    kernelId: "kimi",
    title: "Kimi",
    command: cli,
    cwd,
    hostToolBridgeProvider: provider,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-kimi-host-activation-failure",
    input: "call the host tool",
    context: createContext("kimi-host-activation-failure-session"),
    tools: [probeHostTool()],
    skills: [],
    packs: [],
    capabilities: [],
  }))
    events.push(event);
  runtime.close();

  assert.equal(deactivations, 1, "Activation failure must still cross the shared cleanup boundary");
  assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  assert.ok(
    events.some((event) => event.type === "error" && event.message.includes("acp_host_tool_activation_probe_failed")),
  );
}

function probeHostTool(): ToolDefinition {
  return {
    spec: {
      id: "probe.read",
      title: "Probe",
      description: "Probe Host Tool lifecycle.",
      activity: "chat",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
      permission: { mode: "allow", reason: "Read-only lifecycle probe." },
    },
    async execute() {
      return { ok: true, value: {} };
    },
  };
}

async function assertAcpClientGenerationRevokesHostToolBindings(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-host-generation-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-host-generation-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-host-generation-session",
    marker: "FAKE_KIMI_HOST_GENERATION_OK",
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  let closes = 0;
  const provider: AcpHostToolBridgeProvider = {
    async prepare() {
      return {
        fingerprint: "host-generation",
        mcpServer: {
          type: "stdio",
          name: "opengrove",
          command: process.execPath,
          args: [server],
          env: [],
        },
        activate() {},
        deactivate() {},
      };
    },
    close() {
      closes += 1;
    },
  };
  const runtime = new AcpCliRuntime({
    kernelId: "kimi",
    title: "Kimi",
    command: cli,
    cwd,
    hostToolBridgeProvider: provider,
  });
  const context = createContext("kimi-host-generation-session");
  for (const [index, generation] of ["one", "two"].entries()) {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId: `run-kimi-host-generation-${generation}`,
      input: `generation ${generation}`,
      context,
      tools: [probeHostTool()],
      skills: [],
      packs: [],
      capabilities: [],
      runtimeEnv: { OPENGROVE_TEST_ACP_GENERATION: generation },
    }))
      events.push(event);
    assert.ok(events.some((event) => event.type === "model.response"));
    assert.equal(closes, index, "Only a replaced ACP client generation may revoke Session tokens");
  }
  runtime.close();
  assert.equal(closes, 2, "Runtime close must revoke the final ACP client generation");
}

async function assertAbortedHostToolTurnCancelsScopedSession(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-host-cancel-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-host-cancel-acp-cli");
  const notificationRecordPath = join(cwd, "kimi-host-cancel-notifications.jsonl");
  writeFileSync(notificationRecordPath, "", "utf8");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-host-cancel-session",
    marker: "FAKE_KIMI_HOST_CANCEL_OK",
    notificationRecordPath,
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  const runtime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
  const controller = new AbortController();
  const context = createContext("kimi-host-cancel-thread");
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-kimi-host-cancel",
    input: "finish before the fallback cancellation probe",
    context,
    tools: [probeHostTool()],
    skills: [],
    packs: [],
    capabilities: [],
    signal: controller.signal,
    hostToolScope: {
      sessionId: context.sessionId,
      employeeId: "employee-kimi",
      roomId: "room-current",
    },
  })) {
    events.push(event);
    if (event.type === "model.response") controller.abort();
  }
  assert.ok(
    events.some((event) => event.type === "model.response"),
    `The cancellation probe must reach a native Session: ${JSON.stringify(events)}`,
  );
  const notificationDeadline = Date.now() + 1_000;
  while (!readFileSync(notificationRecordPath, "utf8").trim() && Date.now() < notificationDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  runtime.close();

  const notifications = readFileSync(notificationRecordPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: { sessionId?: string } });
  assert.deepEqual(
    notifications,
    [
      {
        method: "session/cancel",
        params: { sessionId: "fake-kimi-host-cancel-session" },
      },
    ],
    "Host Tool scoped sessions must preserve the ACP cancellation fallback",
  );
}

async function assertAcpHostToolKeepsRoomDelegationAuthorization(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-delegation-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-delegation-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-delegation-session",
    marker: "FAKE_KIMI_DELEGATION_OK",
    mcpToolCall: {
      name: "opengrove_room.delegate.task",
      arguments: {
        targetMemberId: "employee-reviewer",
        prompt: "This non-admin delegation must be denied.",
      },
    },
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });

  const state = createBridgeState({ statePath: join(cwd, "acp-delegation-state.json") });
  try {
    const ordinary = state.app.rooms.upsertMember({
      id: "employee-ordinary",
      name: "Ordinary",
      kernel: "kimi",
      model: "k3",
      role: "",
      status: "idle",
      color: "#111827",
      lastActive: "now",
      source: "local",
    });
    const reviewer = state.app.rooms.upsertMember({
      ...ordinary,
      id: "employee-reviewer",
      name: "Reviewer",
    });
    state.app.rooms.ensureGroupRoom({
      id: "room-non-admin",
      title: "Non-admin room",
      badge: "Test",
      memberIds: [ordinary.id, reviewer.id],
      adminMemberIds: [reviewer.id],
    });
    const room = state.app.rooms.getRoom("room-non-admin");
    assert.ok(room);
    const runId = "run-kimi-non-admin-delegation";
    const posted = state.app.rooms.postUserMessage({
      roomId: room.id,
      text: "Ask the reviewer to take over.",
      targetIds: [ordinary.id],
      assistantTargets: [ordinary],
      deliveryKind: "user_direct",
    });
    const placeholder = posted.assistantMessages[0];
    assert.ok(placeholder);
    state.app.rooms.updateMessage(room.id, placeholder.id, { runId, status: "running" });

    const runtime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId,
      input: "Delegate this task.",
      context: createContext("kimi-non-admin-delegation-thread"),
      tools: [state.app.tools.require("room.delegate.task")],
      skills: [],
      packs: [],
      capabilities: [],
      hostToolScope: {
        sessionId: "kimi-non-admin-delegation-thread",
        employeeId: ordinary.id,
        roomId: room.id,
      },
    }))
      events.push(event);
    runtime.close();

    const response = events.find((event) => event.type === "model.response");
    assert.ok(response && response.type === "model.response");
    assert.match(response.response.text, /delegation_requires_room_admin/);
    assert.ok(events.some((event) => event.type === "tool.started" && event.toolId === "room.delegate.task"));
    assert.ok(events.some((event) => event.type === "tool.finished" && event.toolId === "room.delegate.task"));
    assert.equal(
      state.app.rooms
        .listMessages(room.id, { limit: 20 })
        .some(
          (message) => message.senderId === ordinary.id && message.text === "This non-admin delegation must be denied.",
        ),
      false,
      "Denied ACP delegation must not write a Room message",
    );
  } finally {
    await state.store.close?.();
  }
}

async function assertAcpHostToolsAcrossNewAndLoad(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-host-tools-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-host-tools-acp-cli");
  const sessionSetupRecordPath = join(cwd, "kimi-host-tools-session-setup.jsonl");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-host-tools-session",
    marker: "FAKE_KIMI_HOST_TOOLS_OK",
    sessionSetupRecordPath,
    mcpToolCall: {
      name: "opengrove_room.ledger.read",
      arguments: { roomId: "room-other" },
    },
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });

  let calls = 0;
  const rooms = new RoomChannelStore();
  const member = rooms.upsertMember({
    id: "employee-kimi",
    name: "Kimi",
    kernel: "kimi",
    model: "k3",
    role: "",
    status: "idle",
    color: "#111827",
    lastActive: "now",
    source: "local",
  });
  const currentRoom = rooms.createRoom({
    id: "room-current",
    title: "Current room",
    memberIds: [member.id],
  });
  const otherRoom = rooms.createRoom({
    id: "room-other",
    title: "Other room",
    memberIds: [member.id],
  });
  rooms.postUserMessage({
    roomId: currentRoom.id,
    text: "UNMENTIONED_ROOM_MESSAGE",
    targetIds: [],
    deliveryKind: "user_broadcast",
  });
  rooms.postUserMessage({
    roomId: otherRoom.id,
    text: "CROSS_ROOM_SECRET_MUST_NOT_LEAK",
    targetIds: [member.id],
    deliveryKind: "user_direct",
  });
  const ledgerSpec = {
    id: "room.ledger.read",
    title: "Read room ledger",
    description: "Read messages from the current room.",
    activity: "chat",
    risk: "read",
    input: {
      type: "json-schema",
      schema: {
        type: "object",
        properties: { roomId: { type: "string" } },
        additionalProperties: false,
      },
    },
    permission: { mode: "allow", reason: "Read-only current-room access." },
  } as const;
  const ledgerTool = createRoomLedgerReadTool(ledgerSpec, rooms);
  const tool: ToolDefinition = {
    ...ledgerTool,
    async execute(input, context) {
      calls += 1;
      return await ledgerTool.execute(input, context);
    },
  };
  const context = createContext("kimi-host-tools-thread");
  const run = async (runtime: AcpCliRuntime, runId: string) => {
    const events: AgentEvent[] = [];
    await withRoomLedgerAccessForRun(runId, { sourceRoomId: currentRoom.id }, async () => {
      for await (const event of runtime.runTurn({
        runId,
        input: "Read the current room ledger.",
        context,
        tools: [tool],
        skills: [],
        packs: [],
        capabilities: [],
        hostToolScope: {
          sessionId: context.sessionId,
          employeeId: member.id,
          roomId: currentRoom.id,
        },
      }))
        events.push(event);
    });
    const response = events.find((event) => event.type === "model.response");
    assert.ok(response && response.type === "model.response");
    assert.match(response.response.text, /UNMENTIONED_ROOM_MESSAGE/);
    assert.doesNotMatch(response.response.text, /CROSS_ROOM_SECRET_MUST_NOT_LEAK/);
    assert.ok(events.some((event) => event.type === "tool.started" && event.toolId === "room.ledger.read"));
    assert.ok(events.some((event) => event.type === "tool.finished" && event.toolId === "room.ledger.read"));
  };

  const firstRuntime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
  await run(firstRuntime, "run-kimi-host-tools-new");
  firstRuntime.close();

  const restoredRuntime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
  await run(restoredRuntime, "run-kimi-host-tools-load");
  restoredRuntime.close();

  const sessionSetup = readFileSync(sessionSetupRecordPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: { mcpServers?: unknown[] } });
  assert.deepEqual(
    sessionSetup.map((entry) => entry.method),
    ["session/new", "session/load"],
  );
  assert.ok(sessionSetup.every((entry) => entry.params.mcpServers?.length === 1));
  assert.equal(calls, 2, "Host Tool dispatcher must execute once in the new and restored ACP sessions");
}

async function assertAbortedAcpTurnCloses(cwd: string, kernelId: "opencode" | "kimi"): Promise<void> {
  const server = join(cwd, `fake-${kernelId}-abort-acp-server.mjs`);
  const cli = fakeAcpCommandPath(cwd, `fake-${kernelId}-abort-acp-cli`);
  writeFakeAcpServer(server, {
    sessionId: `fake-${kernelId}-abort-session`,
    marker: `FAKE_${kernelId.toUpperCase()}_ABORT_OK`,
  });
  writeFakeAcpCommand(cli, server, { commandName: kernelId, acpSubcommand: "acp" });
  const runtime = new AcpCliRuntime({ kernelId, title: kernelId, command: cli, cwd });
  const controller = new AbortController();
  controller.abort();
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: `run-${kernelId}-abort`,
    input: "abort this turn",
    context: createContext(`${kernelId}-abort-session`),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    signal: controller.signal,
  }))
    events.push(event);
  runtime.close();
  assert.ok(
    events.some((event) => event.type === "turn.started"),
    `${kernelId} abort must expose turn.started`,
  );
  assert.ok(
    events.some((event) => event.type === "error"),
    `${kernelId} abort must expose its terminal error`,
  );
  assert.ok(
    events.some((event) => event.type === "turn.finished"),
    `${kernelId} abort must close the started turn`,
  );
}

async function assertKimiNativeSkillInvocation(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-skill-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-skill-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-skill-session",
    marker: "FAKE_KIMI_SKILL_OK",
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  const runtime = new AcpCliRuntime({
    kernelId: "kimi",
    title: "Kimi",
    command: cli,
    cwd,
    skillInvocationPromptPlacement: "prompt-prefix",
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-kimi-native-skill",
    input: "/skill:review audit this adapter",
    context: createContext("kimi-native-skill-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    sessionHistoryMode: "native",
    requestedSkillInvocation: {
      skillId: "review",
      skillName: "review",
      title: "Review",
      content: "",
      contentPreview: "native skill",
      sourcePath: ".kimi-code/skills/review/SKILL.md",
      source: "project",
      trust: "trusted",
      context: "fork",
      args: "audit this adapter",
      allowedTools: [],
      invokedAt: new Date(0).toISOString(),
      origin: "user",
    },
  }))
    events.push(event);
  const response = events.find((event) => event.type === "model.response");
  assert.ok(response && response.type === "model.response");
  assert.match(
    response.response.text,
    /PROMPT:\/skill:review audit this adapter\n\nYou are running inside the OpenGrove host\./,
    "Kimi native skill syntax must remain at the beginning of the ACP prompt",
  );
  runtime.close();
}

async function assertKimiNativeCompaction(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-acp-session",
    marker: "FAKE_KIMI_ACP_OK",
    usageUsed: 160_000,
    usageSize: 200_000,
    compactUsageUsed: 40_000,
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  const runtime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
  for (const [index, input] of ["prime usage", "trigger compaction"].entries()) {
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      runId: `run-kimi-budget-${index}`,
      input,
      context: createContext("kimi-budget-session"),
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      contextTokenBudget: 150_000,
    }))
      events.push(event);
    if (index === 1) {
      assert.ok(
        events.some((event) => event.type === "compaction.finished"),
        "Kimi should run native /compact before the second turn",
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "runtime.diagnostic" &&
            event.name === "context.budget.applied" &&
            event.data.compactionSucceeded === true,
        ),
      );
    }
  }
  assert.deepEqual(await runtime.compactSession({ threadId: "kimi-budget-session", reason: "manual harness" }), {
    ok: true,
    compacted: true,
  });
  runtime.close();
}

async function assertKimiUnconfirmedCompactionFailsOpen(cwd: string): Promise<void> {
  const server = join(cwd, "fake-kimi-unconfirmed-acp-server.mjs");
  const cli = fakeAcpCommandPath(cwd, "fake-kimi-unconfirmed-acp-cli");
  writeFakeAcpServer(server, {
    sessionId: "fake-kimi-unconfirmed-session",
    marker: "FAKE_KIMI_UNCONFIRMED_OK",
    usageUsed: 160_000,
    usageSize: 200_000,
  });
  writeFakeAcpCommand(cli, server, { commandName: "kimi", acpSubcommand: "acp" });
  const runtime = new AcpCliRuntime({ kernelId: "kimi", title: "Kimi", command: cli, cwd });
  for await (const _event of runtime.runTurn({
    runId: "run-kimi-unconfirmed-prime",
    input: "prime usage",
    context: createContext("kimi-unconfirmed-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
  })) {
    // Prime the native usage ledger.
  }
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-kimi-unconfirmed-trigger",
    input: "must still be delivered",
    context: createContext("kimi-unconfirmed-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
  }))
    events.push(event);
  assert.ok(
    events.some((event) => event.type === "model.response" && /must still be delivered/.test(event.response.text)),
    "an unconfirmed Kimi compaction below the hard window must not drop the user's turn",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === false &&
        typeof event.data.reason === "string" &&
        event.data.reason.startsWith("kimi_compaction_not_confirmed:"),
    ),
    "Kimi must keep an honest failed-compaction diagnostic when usage did not decrease",
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  runtime.close();
}

// Regression: when the ACP agent advertises the image prompt capability, the
// runtime must append an ACP ContentBlock::Image (base64) to session/prompt.
async function assertAcpImageInput(cwd: string): Promise<void> {
  const imageServer = join(cwd, "fake-acp-image-server.mjs");
  const imageCli = fakeAcpCommandPath(cwd, "fake-acp-image-cli");
  writeFakeAcpServer(imageServer, {
    sessionId: "fake-image-acp-session",
    marker: "FAKE_IMAGE_ACP_OK",
    promptImage: true,
  });
  writeFakeAcpCommand(imageCli, imageServer, {
    commandName: "fake-acp-image-cli",
    acpSubcommand: "acp",
  });

  const runtime = new AcpCliRuntime({
    kernelId: "opencode",
    title: "OpenCode",
    command: imageCli,
    cwd,
    configuredModel: "test-model",
  });

  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
  const context = createContext("acp-image-session");
  context.page = {
    attachments: [
      {
        id: "shot",
        name: "shot.png",
        kind: "image",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${base64}`,
      },
    ],
  };

  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-acp-image",
    input: "what is in this image?",
    context,
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
  })) {
    events.push(event);
  }
  const response = events.find((event) => event.type === "model.response");
  assert.ok(response && response.type === "model.response", "ACP image turn should emit model.response");
  assert.match(
    response.response.text,
    new RegExp(`IMAGE:image/png:${base64}`),
    "ACP agent should receive the image content block",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "opencode.media_input.configured" &&
        event.data.imageInputs === 1,
    ),
    "opencode.media_input.configured diagnostic should report the image input",
  );
  runtime.close();
}

function fakeAcpCommandPath(cwd: string, name: string): string {
  return join(cwd, `${name}.${process.platform === "win32" ? "mjs" : "sh"}`);
}

function createContext(sessionId: string): AgentContext {
  return {
    sessionId,
    activity: undefined as any,
    sessions: new SessionStore(),
    memory: undefined as any,
    artifacts: undefined as any,
    skills: undefined as any,
    executions: undefined as any,
    workingState: undefined as any,
    approvals: new ApprovalInbox(),
    questions: new QuestionInbox(),
    packs: undefined as any,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
