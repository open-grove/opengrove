import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../dist/app/create-opengrove.js";
import { OpenClawGatewayRuntime } from "../dist/runtime/openclaw-gateway-runtime.js";
import { AcpCliRuntime } from "../dist/runtime/acp-cli-runtime.js";
import { ClaudeAgentSdkRuntime } from "../dist/runtime/claude-agent-sdk-runtime.js";
import { PiAgentRuntime } from "../dist/runtime/pi-runtime.js";
import { createNativePiSessionFactory } from "../dist/runtime/native-pi-session.js";

// Opt-in model-backed probe, using existing local credentials and isolated product data.
const kernel = process.argv[2];
if (!["openclaw", "opencode", "kimi", "claude", "pi"].includes(kernel))
  throw new Error("Choose openclaw|opencode|kimi|claude|pi");
const command = process.env.AGENT_HOST_COMMAND;
const cwd = mkdtempSync(join(tmpdir(), "opengrove-agent-host-probe-"));
const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime: { async *runTurn() {} } });
const model = process.env.AGENT_HOST_MODEL;
const createRuntime = () => {
  if (kernel === "openclaw")
    return new OpenClawGatewayRuntime({
      url: process.env.AGENT_HOST_OPENCLAW_URL,
      token: process.env.AGENT_HOST_OPENCLAW_TOKEN,
      configuredModel: model,
    });
  if (kernel === "claude")
    return new ClaudeAgentSdkRuntime({
      cwd,
      cliPath: command,
      configuredModel: model,
      configuredBaseUrl: process.env.ANTHROPIC_BASE_URL,
      configuredAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
      env: { ...process.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" },
    });
  if (kernel === "pi")
    return new PiAgentRuntime({
      workspaceRoot: cwd,
      createSession: createNativePiSessionFactory({
        cwd,
        sessionRoot: join(cwd, "pi-native"),
        model: {
          id: model,
          name: "Native probe",
          provider: "opengrove-anthropic",
          api: "anthropic-messages",
          baseUrl: process.env.ANTHROPIC_BASE_URL,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        getApiKey: () => process.env.ANTHROPIC_API_KEY,
      }),
    });
  return new AcpCliRuntime({
    kernelId: kernel,
    title: kernel,
    command: command ?? kernel,
    cwd,
    configuredModel: model,
    resumeSessions: true,
  });
};
let runtime = createRuntime();
const close = async () => {
  await runtime.close?.();
  await runtime.dispose?.();
};
const context = {
  sessionId: "native-package-probe",
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
let calls = 0;
const tools = [
  {
    spec: {
      id: "host.record_probe",
      title: "Record probe",
      description: "Record the probe word in this test product.",
      activity: "local",
      risk: "read",
      permission: { mode: "allow", reason: "Isolated probe" },
      input: {
        type: "json-schema",
        schema: {
          type: "object",
          properties: { word: { type: "string" } },
          required: ["word"],
          additionalProperties: false,
        },
      },
    },
    async execute(input) {
      calls++;
      assert.equal(input.word, "CEDAR");
      return { ok: true, value: { recorded: input.word } };
    },
  },
];
async function run(input) {
  const events = [];
  for await (const event of runtime.runTurn({
    input,
    context,
    tools,
    signal: AbortSignal.timeout(120_000),
    sessionInstructions:
      "Use only the explicitly requested product tool. Do not use shell or modify files. Answer concisely.",
  })) {
    events.push(event);
    if (event.type === "approval.requested")
      app.approvals.decide(
        event.request.id,
        JSON.stringify(event.request).includes("record_probe") ? "approved" : "rejected",
      );
    if (
      process.env.AGENT_HOST_PROBE_DEBUG === "1" &&
      ["approval.requested", "question.requested", "model.response", "error"].includes(event.type)
    )
      console.log(JSON.stringify(event));
  }
  const terminal = events.find((e) => e.type === "turn.finished");
  assert.equal(
    terminal?.outcome.taskState,
    "TASK_STATE_COMPLETED",
    JSON.stringify(events.filter((e) => e.type === "error" || e.type === "turn.finished")),
  );
  assert.equal(events.filter((e) => e.type === "model.response").length, 1);
  return events;
}
try {
  const one = await run(
    "Remember CEDAR. Call the record_probe product tool exactly once with word CEDAR and say saved.",
  );
  assert.equal(calls, 1);
  await close();
  runtime = createRuntime();
  const two = await run("What word did I ask you to remember? Reply with only the word. Do not call tools.");
  assert.match(two.find((e) => e.type === "model.response").response.text, /CEDAR/);
  assert.equal(
    one.find((e) => e.type === "model.requested").request.session.sessionId,
    two.find((e) => e.type === "model.requested").request.session.sessionId,
  );
  assert.equal(calls, 1);
  console.log(
    `PASS OpenGrove → packaged Agent Host → ${kernel}: product tool, response lifecycle and restart continuation`,
  );
} finally {
  await close();
}
