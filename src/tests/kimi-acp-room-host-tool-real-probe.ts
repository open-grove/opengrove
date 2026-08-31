import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentContext, AgentEvent, ToolSpec } from "../core.js";
import type { AcpCliRuntime as AcpCliRuntimeType } from "../runtime/acp-cli-runtime.js";

const packagedAppRoot = process.env.OPENGROVE_PACKAGED_APP_ROOT?.trim();
const runtimeDistRoot = packagedAppRoot
  ? process.platform === "darwin"
    ? join(resolve(packagedAppRoot), "Contents", "Resources", "app.asar", "dist")
    : join(resolve(packagedAppRoot), "resources", "app.asar", "dist")
  : resolve(import.meta.dirname, "..");
const [core, roomsModule, kimiModule, runtimeModule, roomToolsModule] = await Promise.all([
  import(pathToFileURL(join(runtimeDistRoot, "core.js")).href),
  import(pathToFileURL(join(runtimeDistRoot, "rooms", "channel-store.js")).href),
  import(pathToFileURL(join(runtimeDistRoot, "kernel", "adapters", "kimi.js")).href),
  import(pathToFileURL(join(runtimeDistRoot, "runtime", "acp-cli-runtime.js")).href),
  import(pathToFileURL(join(runtimeDistRoot, "tools", "rooms.js")).href),
]);
const { ApprovalInbox, QuestionInbox, SessionStore } = core;
const { RoomChannelStore } = roomsModule;
const { resolveKimiCommand } = kimiModule;
const { AcpCliRuntime } = runtimeModule;
const { createRoomLedgerReadTool, withRoomLedgerAccessForRun } = roomToolsModule;

const command = resolveKimiCommand();
assert.ok(command, "Kimi Code executable is required for the real ACP Host Tool probe");

const rooms = new RoomChannelStore();
const employee = rooms.upsertMember({
  id: "employee-kimi-real-probe",
  name: "Kimi real probe",
  kernel: "kimi",
  model: "kimi-default",
  role: "Verify OpenGrove Host Tools through ACP.",
  status: "idle",
  color: "#111827",
  lastActive: "now",
  source: "local",
  accessMode: "full-access",
});
const currentRoom = rooms.createRoom({
  id: "room-kimi-real-probe-current",
  title: "Kimi real probe current room",
  memberIds: [employee.id],
});
const otherRoom = rooms.createRoom({
  id: "room-kimi-real-probe-other",
  title: "Kimi real probe other room",
  memberIds: [employee.id],
});
const marker = `KIMI_ACP_UNMENTIONED_${Date.now()}`;
rooms.postUserMessage({
  roomId: currentRoom.id,
  text: marker,
  targetIds: [],
  deliveryKind: "user_broadcast",
});
rooms.postUserMessage({
  roomId: otherRoom.id,
  text: `CROSS_ROOM_SECRET_${marker}`,
  targetIds: [employee.id],
  deliveryKind: "user_direct",
});

const ledgerSpec: ToolSpec = {
  id: "room.ledger.read",
  title: "Read room ledger",
  description: "Read messages and current member state from the Room bound to this Run.",
  activity: "chat",
  risk: "read",
  input: {
    type: "json-schema",
    schema: {
      type: "object",
      properties: {
        roomId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  permission: { mode: "allow", reason: "Read-only access to the current Room." },
};
const ledgerTool = createRoomLedgerReadTool(ledgerSpec, rooms);
const context = createContext("kimi-acp-room-host-tool-real-probe");
const isolatedPackagedRuntimeEnv = packagedAppRoot ? { ELECTRON_RUN_AS_NODE: undefined } : undefined;

const first = new AcpCliRuntime({
  kernelId: "kimi",
  title: "Kimi Code",
  command,
  acpArgs: ["acp"],
  cwd: resolve(process.cwd()),
  setModelFailure: "ignore",
  env: isolatedPackagedRuntimeEnv,
});
const firstProbe = await runProbe(first, "run-kimi-acp-host-tool-new", false).finally(() => first.close());

const restored = new AcpCliRuntime({
  kernelId: "kimi",
  title: "Kimi Code",
  command,
  acpArgs: ["acp"],
  cwd: resolve(process.cwd()),
  setModelFailure: "ignore",
  env: isolatedPackagedRuntimeEnv,
});
const restoredProbe = await runProbe(restored, "run-kimi-acp-host-tool-load", true).finally(() => restored.close());

console.log(
  JSON.stringify(
    {
      ok: true,
      command,
      marker,
      first: { attempts: firstProbe.attempts, ...summarize(firstProbe.events) },
      restored: { attempts: restoredProbe.attempts, ...summarize(restoredProbe.events) },
    },
    null,
    2,
  ),
);

async function runProbe(
  runtime: AcpCliRuntimeType,
  runId: string,
  expectedResuming: boolean,
): Promise<{ attempts: number; events: AgentEvent[] }> {
  const attempts: AgentEvent[][] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const events = await runProbeTurn(
      runtime,
      attempt === 1 ? runId : `${runId}-retry-${attempt}`,
      attempt === 1 ? expectedResuming : true,
      attempt,
    );
    attempts.push(events);
    const started = events.filter((event) => event.type === "tool.started" && event.toolId === ledgerSpec.id);
    if (started.length === 1) {
      assertSuccessfulHostToolCall(events);
      return { attempts: attempt, events };
    }
    const runtimeError = events.find((event) => event.type === "error");
    assert.equal(runtimeError, undefined, `Kimi ACP failed before the Host Tool call: ${JSON.stringify(runtimeError)}`);
  }
  assert.fail(`Kimi did not call room.ledger.read after two attempts: ${JSON.stringify(attempts.map(summarize))}`);
}

async function runProbeTurn(
  runtime: AcpCliRuntimeType,
  runId: string,
  expectedResuming: boolean,
  attempt: number,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    await withRoomLedgerAccessForRun(runId, { sourceRoomId: currentRoom.id }, async () => {
      for await (const event of runtime.runTurn({
        runId,
        input: [
          `Real runtime probe attempt ${attempt}: call the OpenGrove room.ledger.read tool before replying.`,
          `Search for ${marker} and report its sourceRoomId.`,
          `Even though the tool input accepts roomId, pass ${otherRoom.id} so the probe can verify Host-side current-Room binding.`,
          "Do not inspect files, use a shell, or answer from the prompt. The Host Tool call is required.",
        ].join(" "),
        context,
        tools: [ledgerTool],
        accessMode: "full-access",
        skills: [],
        packs: [],
        capabilities: [],
        signal: controller.signal,
        hostToolScope: {
          sessionId: context.sessionId,
          employeeId: employee.id,
          roomId: currentRoom.id,
        },
      }))
        events.push(event);
    });
  } finally {
    clearTimeout(timeout);
  }

  const session = events.find((event) => event.type === "runtime.diagnostic" && event.name === "kimi.acp.session");
  assert.ok(session && session.type === "runtime.diagnostic");
  assert.equal(session.data.resuming, expectedResuming);
  assert.equal(session.data.hostToolMcpServers, 1);
  return events;
}

function assertSuccessfulHostToolCall(events: AgentEvent[]): void {
  const started = events.filter((event) => event.type === "tool.started" && event.toolId === ledgerSpec.id);
  const finished = events.filter((event) => event.type === "tool.finished" && event.toolId === ledgerSpec.id);
  assert.equal(started.length, 1, "Kimi must call room.ledger.read once through the ACP MCP bridge");
  assert.equal(finished.length, 1, "room.ledger.read must record exactly one terminal event");
  assert.ok(
    finished[0]?.type === "tool.finished" && finished[0].result.ok,
    "room.ledger.read must finish successfully",
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.finished") &&
        event.toolId.startsWith("kimi.mcp__opengrove__"),
    ),
    false,
    "ACP must not duplicate OpenGrove Host Tool events as native tool events",
  );
  assert.equal((finished[0].result.value as { sourceRoomId?: string } | undefined)?.sourceRoomId, currentRoom.id);
  assert.match(JSON.stringify(finished[0].result.value), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(finished[0].result.value), /CROSS_ROOM_SECRET_/u);
}

function summarize(events: AgentEvent[]) {
  const eventCounts: Record<string, number> = {};
  for (const event of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  }
  return {
    eventCounts,
    toolEvents: events
      .filter(
        (event): event is Extract<AgentEvent, { type: "tool.started" | "tool.finished" }> =>
          event.type === "tool.started" || event.type === "tool.finished",
      )
      .map((event) => ({ type: event.type, toolId: event.toolId, callId: event.callId })),
    hostToolStarted: events.some((event) => event.type === "tool.started" && event.toolId === ledgerSpec.id),
    hostToolFinished: events.some(
      (event) => event.type === "tool.finished" && event.toolId === ledgerSpec.id && event.result.ok,
    ),
    response: events.find((event) => event.type === "model.response" && event.response.text)?.type === "model.response",
  };
}

function createContext(sessionId: string): AgentContext {
  return {
    sessionId,
    activity: "chat",
    sessions: new SessionStore(),
    approvals: new ApprovalInbox(),
    questions: new QuestionInbox(),
    memory: undefined as never,
    artifacts: undefined as never,
    skills: undefined as never,
    packs: undefined as never,
    executions: undefined as never,
    workingState: undefined as never,
  };
}
