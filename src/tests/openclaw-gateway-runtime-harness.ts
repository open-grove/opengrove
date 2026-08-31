import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { ApprovalInbox, QuestionInbox, type AgentContext, type AgentEvent } from "../core.js";
import {
  discoverOpenClawGatewayProviderProfiles,
  OpenClawGatewayRuntime,
  resolveOpenClawGatewayConnection,
} from "../runtime/openclaw-gateway-runtime.js";

const OPENCLAW_TEST_MODEL = "Custom-AI-T8Star-CN/Qwen/Qwen2.5-Coder";

async function main() {
  testResolveOpenClawGatewayConnection();
  const gateway = await startFakeOpenClawGateway();
  const runtime = new OpenClawGatewayRuntime({
    url: gateway.url,
    requestTimeoutMs: 5_000,
  });

  const discoveredProviders = await discoverOpenClawGatewayProviderProfiles({
    url: gateway.url,
  });
  assert.deepEqual(
    discoveredProviders,
    [
      {
        id: "openclaw-gateway-custom-ai-t8star-cn",
        name: "Custom AI T8Star CN",
        protocol: "custom-gateway",
        custom: true,
        enabled: true,
        origin: "discovered",
        sourceKernel: "openclaw",
        source: "OpenClaw Gateway",
        authConfigured: true,
        routeKind: "provider",
        credentialKind: "gateway-managed",
        modelsPinned: false,
        models: [
          {
            id: OPENCLAW_TEST_MODEL,
            label: "Qwen 2.5 Coder",
            description: "OpenClaw Gateway model",
          },
        ],
      },
    ],
    "Gateway discovery must expose concrete Providers instead of a synthetic Login route",
  );

  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-openclaw-harness",
    input: "first line\nsecond line",
    context: createContext("openclaw-harness-session"),
    tools: [],
    replyLanguagePreference: "zh-CN",
    skills: [],
    packs: [],
    capabilities: [],
    requestedModelId: OPENCLAW_TEST_MODEL,
    requestedSkillInvocation: {
      skillId: "skill.openclaw-host-fallback",
      skillName: "openclaw-host-fallback",
      title: "OpenClaw Host Fallback",
      content: "OPENCLAW_SELECTED_SKILL_INSTRUCTIONS",
      contentPreview: "OPENCLAW_SELECTED_SKILL_INSTRUCTIONS",
      sourcePath: "/tmp/openclaw-host-fallback/SKILL.md",
      source: "user",
      trust: "trusted",
      context: "inline",
      args: "OPENCLAW_SKILL_ARGUMENTS",
      allowedTools: [],
      invokedAt: new Date().toISOString(),
      origin: "user",
    },
    contextTokenBudget: 150_000,
    assembledContext: {
      id: "ctx-openclaw",
      createdAt: new Date().toISOString(),
      summary: "fake OpenClaw context",
      items: [],
      budget: {
        maxItems: 10,
        usedItems: 0,
        maxCharacters: 1000,
        usedCharacters: 0,
        truncated: false,
      },
      promptBlock: "Host marker: OPENCLAW_CONTEXT_VISIBLE",
    },
  })) {
    events.push(event);
  }

  runtime.close();
  await gateway.close();

  assert.ok(
    gateway.capturedPrompt.includes("first line\nsecond line"),
    "Gateway prompt should preserve multiline user input",
  );
  assert.ok(
    gateway.capturedPrompt.includes("OPENCLAW_CONTEXT_VISIBLE"),
    "Gateway prompt should include assembled host context",
  );
  assert.ok(
    gateway.capturedPrompt.includes("OPENCLAW_SELECTED_SKILL_INSTRUCTIONS"),
    "Gateway fallback should carry the selected skill body when native publication is not provable",
  );
  assert.ok(
    gateway.capturedPrompt.includes("OPENCLAW_SKILL_ARGUMENTS"),
    "Gateway fallback should preserve selected skill arguments",
  );
  assert.ok(
    gateway.capturedPrompt.includes("Default response language: Simplified Chinese"),
    "Gateway prompt should include the user language preference",
  );
  assert.equal(gateway.capturedSessionKey, "openclaw-harness-session");
  assert.equal(gateway.capturedSessionModel, OPENCLAW_TEST_MODEL);
  assert.ok(
    gateway.callOrder.indexOf("sessions.patch") < gateway.callOrder.indexOf("chat.send"),
    "OpenClaw must pin the exact session model before sending the user message",
  );
  assert.equal(gateway.compactionCount, 1, "OpenClaw should call native sessions.compact before an over-budget turn");
  assert.equal(gateway.capturedConnectParams?.minProtocol, 3);
  assert.equal(gateway.capturedConnectParams?.maxProtocol, 4);

  const response = events.find((event) => event.type === "model.response");
  assert.ok(response && response.type === "model.response", "OpenClaw Gateway runtime should emit model.response");
  assert.equal(response.response.text, "gateway ok");
  assert.equal(
    events
      .filter((event): event is Extract<AgentEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
      .map((event) => event.text)
      .join(""),
    "gateway ok",
  );
  assert.equal(
    events.some((event) => event.type === "assistant.delta" && event.text.includes('"payloads"')),
    false,
  );
  assert.ok(events.some((event) => event.type === "compaction.finished"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.usageSource === "native" &&
        event.data.compactionSucceeded === true,
    ),
  );
  await assertCompressionFailureFailsOpen();
  await assertUnconfiguredBudgetPreservesKernelBehavior();
  await assertAbortedTurnCloses();
}

async function assertAbortedTurnCloses(): Promise<void> {
  const gateway = await startFakeOpenClawGateway();
  const runtime = new OpenClawGatewayRuntime({
    url: gateway.url,
    configuredModel: OPENCLAW_TEST_MODEL,
    requestTimeoutMs: 5_000,
  });
  const controller = new AbortController();
  controller.abort();
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-openclaw-abort",
    input: "abort this turn",
    context: createContext("openclaw-abort-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    signal: controller.signal,
  }))
    events.push(event);
  runtime.close();
  await gateway.close();
  assert.ok(
    events.some((event) => event.type === "turn.started"),
    "OpenClaw abort must expose turn.started",
  );
  assert.ok(
    events.some((event) => event.type === "error"),
    "OpenClaw abort must expose its terminal error",
  );
  assert.ok(
    events.some((event) => event.type === "turn.finished"),
    "OpenClaw abort must close the started turn",
  );
}

async function assertUnconfiguredBudgetPreservesKernelBehavior(): Promise<void> {
  const gateway = await startFakeOpenClawGateway();
  const runtime = new OpenClawGatewayRuntime({
    url: gateway.url,
    configuredModel: OPENCLAW_TEST_MODEL,
    requestTimeoutMs: 5_000,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-openclaw-unconfigured",
    input: "follow the kernel default",
    context: createContext("openclaw-harness-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
  }))
    events.push(event);
  runtime.close();
  await gateway.close();
  assert.equal(gateway.compactionCount, 0, "an undeclared employee budget must not trigger OpenGrove compaction");
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.budgetSource === "unconfigured" &&
        event.data.requestedBudget === undefined &&
        event.data.effectiveBudget === undefined &&
        event.data.modelContextWindow === 200000 &&
        event.data.compactionTriggered === false,
    ),
    "the model hard window should be observed without becoming an employee budget",
  );
}

async function assertCompressionFailureFailsOpen(): Promise<void> {
  const gateway = await startFakeOpenClawGateway({ compactFails: true });
  const runtime = new OpenClawGatewayRuntime({
    url: gateway.url,
    configuredModel: OPENCLAW_TEST_MODEL,
    requestTimeoutMs: 5_000,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn({
    runId: "run-openclaw-fail-open",
    input: "this message must still run",
    context: createContext("openclaw-harness-session"),
    tools: [],
    skills: [],
    packs: [],
    capabilities: [],
    contextTokenBudget: 150_000,
  }))
    events.push(event);
  runtime.close();
  await gateway.close();
  assert.ok(
    events.some((event) => event.type === "model.response"),
    "OpenClaw should submit the turn after a soft-budget compaction failure",
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "context.budget.applied" &&
        event.data.compactionTriggered === true &&
        event.data.compactionSucceeded === false,
    ),
    "OpenClaw should record the failed native compaction without killing the user message",
  );
}

function testResolveOpenClawGatewayConnection(): void {
  const configHome = mkdtempSync(join(tmpdir(), "opengrove-openclaw-"));
  try {
    writeFileSync(
      join(configHome, "openclaw.json"),
      JSON.stringify({
        gateway: {
          port: 19876,
          auth: { mode: "token", token: "local-token" },
        },
      }),
    );
    const local = resolveOpenClawGatewayConnection({}, { configHome });
    assert.equal(local?.url, "ws://127.0.0.1:19876");
    assert.equal(local?.token, "local-token");

    const explicit = resolveOpenClawGatewayConnection(
      {
        OPENGROVE_OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19999",
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      { configHome },
    );
    assert.equal(explicit?.url, "ws://127.0.0.1:19999");
    assert.equal(explicit?.token, "env-token");

    writeFileSync(
      join(configHome, "openclaw.json"),
      JSON.stringify({
        gateway: {
          mode: "remote",
          remote: { url: "https://remote.example/ws", token: "remote-token" },
        },
      }),
    );
    const remote = resolveOpenClawGatewayConnection({}, { configHome });
    assert.equal(remote?.url, "wss://remote.example/ws");
    assert.equal(remote?.token, "remote-token");
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
}

function createContext(sessionId: string): AgentContext {
  return {
    sessionId,
    activity: undefined as any,
    sessions: undefined as any,
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

async function startFakeOpenClawGateway(options: { compactFails?: boolean } = {}): Promise<{
  url: string;
  capturedConnectParams: Record<string, unknown> | undefined;
  capturedPrompt: string;
  capturedSessionKey: string;
  capturedSessionModel: string;
  callOrder: string[];
  compactionCount: number;
  close(): Promise<void>;
}> {
  let capturedConnectParams: Record<string, unknown> | undefined;
  let capturedPrompt = "";
  let capturedSessionKey = "";
  let capturedSessionModel = "";
  const callOrder: string[] = [];
  let compactionCount = 0;
  const sockets = new Set<Duplex>();
  const server = createServer();

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${webSocketAccept(key)}`,
        "\r\n",
      ].join("\r\n"),
    );

    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeClientTextFrames(buffered);
      buffered = decoded.remaining;
      for (const text of decoded.messages) {
        handleGatewayRequest(
          socket,
          text,
          (params) => {
            capturedConnectParams = params;
          },
          (prompt) => {
            capturedPrompt = prompt;
          },
          (sessionKey) => {
            capturedSessionKey = sessionKey;
          },
          (model) => {
            capturedSessionModel = model;
          },
          callOrder,
          () => {
            compactionCount += 1;
          },
          options,
        );
      }
    });
  });

  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get capturedConnectParams() {
      return capturedConnectParams;
    },
    get capturedPrompt() {
      return capturedPrompt;
    },
    get capturedSessionKey() {
      return capturedSessionKey;
    },
    get capturedSessionModel() {
      return capturedSessionModel;
    },
    callOrder,
    get compactionCount() {
      return compactionCount;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function handleGatewayRequest(
  socket: Duplex,
  text: string,
  captureConnectParams: (params: Record<string, unknown>) => void,
  capturePrompt: (prompt: string) => void,
  captureSessionKey: (sessionKey: string) => void,
  captureSessionModel: (model: string) => void,
  callOrder: string[],
  captureCompaction: () => void,
  options: { compactFails?: boolean },
): void {
  const frame = JSON.parse(text) as {
    type?: string;
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (frame.type !== "req" || !frame.id || !frame.method) return;
  callOrder.push(frame.method);
  if (frame.method === "connect") {
    captureConnectParams(frame.params ?? {});
    sendTextFrame(socket, JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 3 } }));
    return;
  }
  if (frame.method === "chat.send") {
    capturePrompt(typeof frame.params?.message === "string" ? frame.params.message : "");
    captureSessionKey(typeof frame.params?.sessionKey === "string" ? frame.params.sessionKey : "");
    sendTextFrame(
      socket,
      JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "native-openclaw-run" } }),
    );
    return;
  }
  if (frame.method === "models.list") {
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          models: [
            {
              id: "Qwen/Qwen2.5-Coder",
              name: "Qwen 2.5 Coder",
              provider: "Custom-AI-T8Star-CN",
              available: true,
            },
          ],
        },
      }),
    );
    return;
  }
  if (frame.method === "sessions.patch") {
    const model = typeof frame.params?.model === "string" ? frame.params.model : "";
    captureSessionModel(model);
    const separator = model.indexOf("/");
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          ok: true,
          key: frame.params?.key,
          resolved: {
            // Gateways may normalize Provider casing in their canonical response.
            modelProvider: model.slice(0, separator).toLowerCase(),
            model: model.slice(separator + 1),
          },
        },
      }),
    );
    return;
  }
  if (frame.method === "sessions.list") {
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          sessions: [
            {
              key: "openclaw-harness-session",
              totalTokens: 160000,
              totalTokensFresh: true,
              contextTokens: 200000,
            },
          ],
        },
      }),
    );
    return;
  }
  if (frame.method === "sessions.compact") {
    captureCompaction();
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: options.compactFails
          ? { ok: false, compacted: false, reason: "sessions.compact unavailable" }
          : { ok: true, compacted: true, result: { tokensBefore: 160000, tokensAfter: 40000 } },
      }),
    );
    return;
  }
  if (frame.method === "agent.wait") {
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          runId: "native-openclaw-run",
          stream: "assistant",
          data: { text: "gateway " },
        },
        seq: 1,
      }),
    );
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          runId: "native-openclaw-run",
          stream: "assistant",
          data: { text: "gateway ok" },
        },
        seq: 2,
      }),
    );
    sendTextFrame(socket, JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "ok" } }));
    return;
  }
  if (frame.method === "chat.history") {
    sendTextFrame(
      socket,
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { messages: [{ role: "assistant", text: "history fallback" }] },
      }),
    );
    return;
  }
  sendTextFrame(socket, JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "unknown_method" } }));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function webSocketAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function decodeClientTextFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      throw new Error("fake gateway does not support oversized frames");
    }
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, frameEnd));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
    }
    if (opcode === 1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 8) {
      return { messages, remaining: Buffer.alloc(0) };
    }
    offset = frameEnd;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

function sendTextFrame(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
