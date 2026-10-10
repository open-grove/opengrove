import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../dist/app/create-opengrove.js";
import { CodexRuntime } from "../dist/runtime/codex-runtime.js";

// Opt-in native probe; uses existing Codex login and only isolated example data.
const command = process.env.AGENT_HOST_CODEX;
if (!command) throw new Error("Set AGENT_HOST_CODEX to the Codex 0.162.0 executable");
const cwd = mkdtempSync(join(tmpdir(), "opengrove-agent-host-probe-"));
const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime: { async *runTurn() {} } });
const options = { command, cwd, statePath: join(cwd, "bindings.json"), sandbox: "read-only", approvalPolicy: "never" };
let runtime = new CodexRuntime(options);
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
  const events = await Array.fromAsync(
    runtime.runTurn({
      input,
      context,
      tools,
      signal: AbortSignal.timeout(120_000),
      sessionInstructions:
        "Use only the explicitly requested product tool. Do not use shell or modify files. Answer concisely.",
    }),
  );
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
  runtime.close();
  runtime = new CodexRuntime(options);
  const two = await run("What word did I ask you to remember? Reply with only the word. Do not call tools.");
  assert.match(two.find((e) => e.type === "model.response").response.text, /CEDAR/);
  assert.equal(
    one.find((e) => e.type === "model.requested").request.session.sessionId,
    two.find((e) => e.type === "model.requested").request.session.sessionId,
  );
  assert.equal(calls, 1);
  console.log(
    "PASS OpenGrove → packaged Agent Host → Codex: product tool, response lifecycle and restart continuation",
  );
} finally {
  runtime.close();
}
