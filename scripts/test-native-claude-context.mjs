// Run after build:server. Uses the real installed SDK/CLI and a loopback model API;
// no provider credentials or model inference are needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createOpenGrove } from "../dist/app/create-opengrove.js";
import { ClaudeAgentSdkRuntime } from "../dist/runtime/claude-agent-sdk-runtime.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-native-context-"));
const configDir = join(root, "claude");
mkdirSync(configDir);
const requests = [];
const restoredContexts = [];
const snapshots = [];
let seedLegacy = true;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url?.includes("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end('{"input_tokens":100}');
    return;
  }
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      content: [],
      model: request.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "CONTEXT_OK" } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
  send("message_stop", {});
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const app = createOpenGrove({ cwd: root, runtime: { async *runTurn() {} }, readPage: async () => ({}) });
const context = {
  sessionId: "real-sdk-context",
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
const env = {
  HOME: root,
  USERPROFILE: root,
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  ANTHROPIC_API_KEY: "local-fixture-key",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  HTTPS_PROXY: "",
  HTTP_PROXY: "",
  ALL_PROXY: "",
  https_proxy: "",
  http_proxy: "",
  all_proxy: "",
};
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
env.ANTHROPIC_AUTH_TOKEN = "local-fixture-token";
const runtime = new ClaudeAgentSdkRuntime({
  cwd: root,
  env,
  configuredBaseUrl: `http://127.0.0.1:${server.address().port}`,
  configuredAuthToken: "local-fixture-token",
  configuredModel: "claude-sonnet-4-6",
  cliPath: process.env.OPENGROVE_TEST_CLAUDE_CLI,
  // Disable tools only for this network capture. Prompt/session handling is the
  // production adapter and the installed, unmodified native SDK/CLI.
  query: ({ prompt, options }) => {
    assert.equal(options.env.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
    snapshots.push(options.systemPrompt?.snapshot);
    if (seedLegacy)
      options = {
        ...options,
        systemPrompt: { type: "preset", preset: "claude_code", append: "LEGACY_ROOM_IN_SYSTEM", snapshot: true },
      };
    const hooks = {
      ...options.hooks,
      SessionStart: options.hooks.SessionStart.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map((callback) => async (...args) => {
          const result = await callback(...args);
          if (args[0].source === "compact") restoredContexts.push(result.hookSpecificOutput?.additionalContext);
          return result;
        }),
      })),
    };
    return query({
      prompt,
      options: { ...options, hooks, canUseTool: undefined, tools: [], mcpServers: {}, maxTurns: 1 },
    });
  },
});
async function sendTurn(number, room) {
  const errors = [];
  for await (const event of runtime.runTurn({
    input: `TURN_${number}`,
    context,
    tools: [],
    skills: [],
    sessionInstructions: "STABLE_EMPLOYEE_RULE",
    replyLanguagePreference: number > 1 ? "en" : "zh-CN",
    signal: AbortSignal.timeout(45000),
    assembledContext: {
      id: `ctx_${number}`,
      createdAt: new Date().toISOString(),
      summary: "fixture",
      hostState: [{ id: "room", text: room }],
      items: [],
      promptBlock: `ATTACHMENT_${number}`,
      budget: { maxItems: 8, usedItems: 0, maxCharacters: 6000, usedCharacters: 12, truncated: false },
    },
  })) {
    if (event.type === "error") errors.push(event.message);
  }
  assert.deepEqual(errors, [], `turn ${number}`);
}
try {
  await sendTurn(0, "LEGACY_ROOM");
  seedLegacy = false;
  const legacySession = app.sessions.get(context.sessionId);
  app.sessions.ensureSession({
    id: context.sessionId,
    activity: context.activity,
    metadata: {
      ...legacySession.metadata,
      claudeCodeHostPromptHashes: {},
    },
  });
  for (const [i, room] of ["ROOM_A", "ROOM_B", "ROOM_B"].entries()) await sendTurn(i + 1, room);
  assert.deepEqual(
    snapshots,
    [true, false, false, false],
    "old sessions bypass their stale system snapshot until compaction",
  );
  const captured = [1, 2, 3].map((n) =>
    requests.find((request) =>
      JSON.stringify(request.messages.filter((message) => message.role === "user").at(-1)).includes(`TURN_${n}`),
    ),
  );
  assert.ok(captured.every(Boolean), "three real Messages API requests must be captured");
  const [first, second, third] = captured;
  const latestUser = (request) => request.messages.filter((message) => message.role === "user").at(-1);
  const system = JSON.stringify(first.system);
  const hostSystem = (request) =>
    request.system
      .map((block) => block.text)
      .join("\n")
      .split("You are running inside the OpenGrove host.")[1];
  assert.match(system, /STABLE_EMPLOYEE_RULE/);
  assert.doesNotMatch(system, /ROOM_A|ROOM_B|LEGACY_ROOM_IN_SYSTEM|ATTACHMENT_|Default response language/);
  assert.equal(hostSystem(second), hostSystem(first), "Host append stays stable across native resume");
  assert.equal(hostSystem(third), hostSystem(first));
  assert.match(JSON.stringify(latestUser(first)), /ROOM_A/);
  assert.match(JSON.stringify(latestUser(second)), /ROOM_B/);
  assert.doesNotMatch(JSON.stringify(latestUser(second)), /ROOM_A/);
  assert.doesNotMatch(JSON.stringify(latestUser(third)), /ROOM_B|Default response language/);
  assert.match(JSON.stringify(latestUser(third)), /ATTACHMENT_3/);
  assert.match(JSON.stringify(second.messages.slice(0, -1)), /TURN_1/, "native resume retains prior history");
  const compact = await runtime.compactSession({ threadId: context.sessionId });
  assert.equal(compact.compacted, true, JSON.stringify(compact));
  assert.ok(
    restoredContexts.some((text) => text?.includes("ROOM_B")),
    "real native compact must request current Host state before continuing",
  );
  assert.ok(
    restoredContexts.every((text) => !text?.includes("ATTACHMENT_")),
    "compaction recovery must not promote task materials into Host rules",
  );
  await sendTurn(4, "ROOM_B");
  assert.equal(snapshots.at(-1), true, "native compaction enables stable snapshots again");
  const afterCompact = requests.find((request) => JSON.stringify(latestUser(request)).includes("TURN_4"));
  assert.ok(afterCompact);
  assert.match(JSON.stringify(latestUser(afterCompact)), /ROOM_B/, "next turn after compaction sends full state");
  assert.equal(hostSystem(afterCompact), hostSystem(first));
  console.log(
    "native Claude context: real API requests verified: legacy snapshot migration, stable Host append, fresh user context, native resume, state delta, compact recovery",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
