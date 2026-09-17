import {
  createBridgeState,
  recreateBridgeApp,
  saveBridgeSettings,
  syncMountedAppSeedMember,
} from "../server/bridge-state.js";
import { AcpCliRuntime } from "../runtime/acp-cli-runtime.js";
import { PiAgentRuntime } from "../runtime/pi-runtime.js";
import { OpenClawGatewayRuntime } from "../runtime/openclaw-gateway-runtime.js";
import { ClaudeAgentSdkRuntime, type ClaudeAgentSdkQueryFunction } from "../runtime/claude-agent-sdk-runtime.js";
import { openCodeConfigContentForAccessMode } from "../kernel/adapters/opencode.js";
import { HermesRuntime } from "../runtime/hermes-runtime.js";
import { prepareHermesRuntimeEnv } from "../runtime/hermes/home-env.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";
import { RoomChannelStore, type RoomChannelMember } from "../rooms/channel-store.js";
import { migrateNativeApprovalPresetsV4 } from "../server/migrations/native-approval-presets-v4.js";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent, AgentTurnRequest } from "../core.js";
import { CodexRuntime } from "../runtime/codex-runtime.js";
import { resolveCodexApprovalPolicy, resolveCodexSandboxMode } from "../runtime/codex/policy.js";
import { normalizeMember as normalizeEmployee } from "../server/routes/rooms/normalizers.js";
import { mountedAppDefaultEmployees } from "../server/bridge-mounted-app-employees.js";
import { normalizeEmployeeAccessMode } from "../server/employee-access-mode.js";
import { normalizeReleaseEmployee } from "../server/app-release.js";
import { dispatchBridgeRoutes } from "../server/router.js";
import { createBridgeRoutes } from "../server/routes/bridge-registry.js";
import { bridgeSettingsPath, defaultBridgeSettings } from "../server/bridge-settings-store.js";
import { recordRoomRunEvent } from "../server/room-runs.js";
import { persistedRoomRunParts } from "../server/room-runs/persisted-parts.js";
import { OPENGROVE_PM_MEMBER_ID } from "../rooms/room-pm.js";
import { createJsonStateStore } from "../storage/json-state-store.js";

function context(cwd: string): AgentTurnRequest["context"] {
  const app = createOpenGrove({ cwd, readPage: async () => ({}), runtime: { async *runTurn() {} } });
  return {
    sessionId: "permission-presets",
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
}

test("startup cleans abandoned owned Hermes homes without touching live processes or unknown directories", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-recovery-test-"));
  const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
  const makeHome = (name: string, owner?: object) => {
    const home = join(cwd, `opengrove-hermes-${name}`);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, ".env"), "TEST_TOKEN=fixture");
    if (owner) writeFileSync(join(home, ".opengrove-owner.json"), JSON.stringify(owner), { mode: 0o600 });
    return home;
  };
  const dead = makeHome("dead", { schemaVersion: 1, hostPid: deadPid, phase: "preparing" });
  const live = makeHome("live", { schemaVersion: 1, hostPid: process.pid, phase: "preparing" });
  const childLive = makeHome("child-live", {
    schemaVersion: 1,
    hostPid: deadPid,
    phase: "running",
    gatewayPid: process.pid,
  });
  const uncertain = makeHome("launching", { schemaVersion: 1, hostPid: deadPid, phase: "launching" });
  const unknown = makeHome("unknown");
  symlinkSync(unknown, join(cwd, "opengrove-hermes-linked"), "dir");
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = cwd;
  const state = createBridgeState({ statePath: join(cwd, "state.sqlite") });
  try {
    assert.equal(existsSync(dead), false);
    for (const home of [live, childLive, uncertain, unknown]) assert.equal(existsSync(join(home, ".env")), true, home);
  } finally {
    await state.store.close?.();
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Hermes honors native homes and sends full access to the native gate", () => {
  const home = mkdtempSync(join(tmpdir(), "opengrove-hermes-native-test-"));
  const config = "approvals:\n  mode: manual\n";
  writeFileSync(join(home, "config.yaml"), config);
  writeFileSync(join(home, "state.db"), "existing native state");
  const prepared = prepareHermesRuntimeEnv({
    runtimeEnv: { HERMES_HOME: home },
    providerConfig: undefined,
    nativeSkillDir: undefined,
    isolatedHome: undefined,
    accessMode: "full-access",
  });
  try {
    assert.equal(prepared.env.HERMES_HOME, home);
    assert.equal(prepared.env.HERMES_YOLO_MODE, "1");
    assert.equal(prepared.isolatedHome, undefined);
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), config);
    assert.equal(readFileSync(join(home, "state.db"), "utf8"), "existing native state");
  } finally {
    if (prepared.isolatedHome) rmSync(prepared.isolatedHome, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Hermes rejects invalid config without leaking credentials or YAML contents", (t) => {
  const home = mkdtempSync(join(tmpdir(), "opengrove-hermes-config-test-"));
  writeFileSync(join(home, ".env"), "TEST_SECRET=private-marker");
  writeFileSync(join(home, "config.yaml"), "private-marker: [broken yaml");
  const scratch = join(home, "scratch");
  mkdirSync(scratch);
  t.mock.property(process, "env", { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
  try {
    assert.throws(
      () =>
        prepareHermesRuntimeEnv({
          runtimeEnv: { HERMES_HOME: home },
          providerConfig: {
            providerKey: "test",
            name: "Test",
            baseUrl: "https://example.test",
            apiMode: "chat_completions",
          },
          nativeSkillDir: undefined,
          isolatedHome: undefined,
        }),
      /^Error: hermes_config_invalid:.*config.yaml.*format/,
    );
    assert.deepEqual(readdirSync(scratch), []);
    writeFileSync(join(home, "config.yaml"), "approvals: manual\n");
    assert.doesNotThrow(() =>
      prepareHermesRuntimeEnv({
        runtimeEnv: { HERMES_HOME: home },
        providerConfig: undefined,
        nativeSkillDir: undefined,
        isolatedHome: undefined,
      }),
    );
    writeFileSync(join(home, "config.yaml"), "approvals:\n  mode: manual\n");
    mkdirSync(join(home, "auth.json"));
    assert.throws(
      () =>
        prepareHermesRuntimeEnv({
          runtimeEnv: { HERMES_HOME: home, OPENGROVE_HERMES_ISOLATED_HOME: "1" },
          providerConfig: undefined,
          nativeSkillDir: undefined,
          isolatedHome: undefined,
        }),
      /hermes_credentials_unreadable/,
    );
    assert.deepEqual(
      readdirSync(scratch),
      [],
      "a credential-copy failure after copying .env cleans the whole owned home",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex sends the three desktop presets on new and resumed turns", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-permission-presets-"));
  const server = join(cwd, "codex.mjs");
  const calls = join(cwd, "calls.jsonl");
  writeFileSync(
    server,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(m) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex-cli/99.0.0' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'thread' }, model: 'gpt-test' } });
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + ++count;
    send({ id: m.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      const item = { id: turnId + '-answer', type: 'agentMessage', phase: 'final_answer', text: 'done' };
      send({ method: 'item/completed', params: { threadId: 'thread', turnId, item } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed', items: [item] } } });
    }, 10);
  }
}
`,
  );
  const runtime = new CodexRuntime({
    command: process.execPath,
    args: [server],
    cwd,
    statePath: join(cwd, "bindings.json"),
    requestTimeoutMs: 2_000,
    sandbox: "workspace-write",
    approvalPolicy: "never",
  });
  const ctx = context(cwd);
  try {
    for (const accessMode of ["default", "auto-review", "full-access", "default", undefined] as const) {
      const events: AgentEvent[] = [];
      for await (const event of runtime.runTurn({ input: "hello", context: ctx, tools: [], accessMode }))
        events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === "error"),
        [],
      );
    }
  } finally {
    runtime.close();
  }
  const messages = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const threads = messages.filter((m) => m.method === "thread/start" || m.method === "thread/resume");
  assert.deepEqual(
    threads.map((m) => [m.params.sandbox, m.params.approvalPolicy, m.params.approvalsReviewer]),
    [
      ["workspace-write", "on-request", "user"],
      ["workspace-write", "on-request", "auto_review"],
      ["danger-full-access", "never", "user"],
      ["workspace-write", "on-request", "user"],
      ["workspace-write", "never", "user"],
    ],
  );
  assert.deepEqual(
    threads.map((m) => m.params.config["sandbox_workspace_write.network_access"]),
    [false, false, undefined, false, undefined],
  );
  const turns = messages.filter((m) => m.method === "turn/start");
  assert.deepEqual(
    turns.map((m) => m.params.sandboxPolicy),
    [
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      { type: "dangerFullAccess" },
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      undefined,
    ],
  );
});

test("Codex omitted presets retain the existing unconfigured defaults", () => {
  const request: AgentTurnRequest = { input: "hello", context: context(process.cwd()), tools: [] };
  assert.equal(resolveCodexApprovalPolicy(undefined, undefined), "never");
  assert.equal(resolveCodexSandboxMode(request, undefined), "danger-full-access");
});

test("unsupported auto review fails before launching a kernel", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-unsupported-permissions-"));
  const request: AgentTurnRequest = { input: "run", context: context(cwd), tools: [], accessMode: "auto-review" };
  for (const kernelId of ["kimi", "opencode"] as const) {
    const runtime = new AcpCliRuntime({ kernelId, title: kernelId, command: "must-not-launch", cwd });
    await assert.rejects(async () => {
      for await (const _event of runtime.runTurn(request)) {
      }
    }, /runtime_access_mode_unavailable/);
    runtime.close();
  }
  const pi = new PiAgentRuntime({
    createSession: () => {
      throw new Error("must not create a session");
    },
  });
  await assert.rejects(async () => {
    for await (const _event of pi.runTurn(request)) {
    }
  }, /runtime_access_mode_unavailable/);
  const claw = new OpenClawGatewayRuntime({ url: "ws://127.0.0.1:1" });
  for (const accessMode of ["auto-review", "full-access"] as const) {
    await assert.rejects(async () => {
      for await (const _event of claw.runTurn({ ...request, accessMode })) {
      }
    }, /gateway-managed/);
  }
});

test("OpenCode presets preserve explicit deny rules and only allow reads in ask mode", () => {
  const config = JSON.stringify({ permission: { bash: { "*": "allow", "rm *": "deny" }, edit: "deny" } });
  const manual = JSON.parse(openCodeConfigContentForAccessMode(config, "default"));
  assert.deepEqual(manual.permission, {
    "*": "ask",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: { "*": "ask", "rm *": "deny" },
    edit: "deny",
  });
  const full = JSON.parse(openCodeConfigContentForAccessMode(config, "full-access"));
  assert.deepEqual(full.permission, { "*": "allow", bash: { "*": "allow", "rm *": "deny" }, edit: "deny" });
  assert.equal(
    JSON.parse(openCodeConfigContentForAccessMode('{"permission":"deny"}', "full-access")).permission,
    "deny",
  );
  assert.equal(
    JSON.parse(openCodeConfigContentForAccessMode('{"permission":{"*":"deny"}}', "full-access")).permission,
    "deny",
  );
  assert.throws(() => openCodeConfigContentForAccessMode(config, "auto-review"), /runtime_access_mode_unavailable/);
});

test("Pi full access preserves explicit native and Host tool denials", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-pi-denials-"));
  const decisions: string[] = [];
  const runtime = new PiAgentRuntime({
    workspaceRoot: cwd,
    createSession: () => ({
      async *run(_input, ctx) {
        for (const source of ["native", "host"] as const) {
          const result = await ctx.beforeToolCall({
            source,
            toolId: source === "native" ? "write" : "host.write",
            input: { path: "a.txt" },
          });
          decisions.push(result.mode);
        }
        yield { type: "model.response", runId: ctx.runId, response: { text: "done" } };
      },
    }),
  });
  for await (const _event of runtime.runTurn({
    input: "write",
    context: context(cwd),
    accessMode: "full-access",
    policy: [{ id: "deny-writes", risk: "write", mode: "deny", reason: "App policy" }],
    tools: [
      {
        spec: {
          id: "host.write",
          title: "Write",
          description: "write",
          activity: "chat",
          permission: { mode: "ask", reason: "test" },
          risk: "write",
          input: { type: "json-schema", schema: { type: "object" } },
        },
        execute: async () => {
          throw new Error("must not execute");
        },
      },
    ],
  })) {
  }
  assert.deepEqual(decisions, ["deny", "deny"]);
});

test("Claude auto review uses native activation without a blocking model catalog lookup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-permissions-"));
  for (const scenario of ["supported", "unsupported-model", "org-denied", "wrong-effective-mode"] as const) {
    let submitted = 0;
    let queries = 0;
    let acknowledged = false;
    let closed = false;
    let selectedMode: unknown;
    const modeChanges: string[] = [];
    let catalogStarted = false;
    const query: ClaudeAgentSdkQueryFunction = (params) => {
      queries++;
      selectedMode = params.options?.permissionMode;
      async function* messages() {
        assert.equal(typeof params.prompt, "object");
        if (typeof params.prompt !== "string")
          for await (const _input of params.prompt) {
            assert.equal(acknowledged, true, "user input must wait for the native approval-mode acknowledgement");
            submitted++;
          }
        yield {
          type: "system",
          subtype: "init",
          session_id: "session",
          model: "claude-test",
          permissionMode: scenario === "wrong-effective-mode" ? "default" : modeChanges.at(-1),
          claude_code_version: "test",
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          skills: [],
        };
        yield { type: "result", subtype: "success", result: "done", session_id: "session", usage: {}, modelUsage: {} };
      }
      return Object.assign(messages(), {
        supportedModels: async () => {
          catalogStarted = true;
          return [{ value: "claude-discovered", supportsAutoMode: true }];
        },
        setPermissionMode: async (mode: string) => {
          modeChanges.push(mode);
          assert.equal(catalogStarted, true, "model metadata refresh starts even if Auto activation fails");
          if (mode === "auto" && scenario === "org-denied") throw new Error("auto mode disabled by settings");
          if (mode === "auto" && scenario === "unsupported-model")
            throw new Error("auto mode unavailable for this model");
          acknowledged = true;
        },
        close: () => {
          closed = true;
        },
      }) as unknown as ReturnType<ClaudeAgentSdkQueryFunction>;
    };
    const runtime = new ClaudeAgentSdkRuntime({
      cwd,
      configuredModel: "claude-test",
      env: { CLAUDE_CONFIG_DIR: join(cwd, scenario) },
      query,
    });
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      input: "hello",
      context: context(cwd),
      tools: [],
      accessMode: "auto-review",
    }))
      events.push(event);
    assert.equal(selectedMode, "auto");
    assert.equal(closed, true);
    assert.equal(submitted, 1, "fallback must not replay user input");
    assert.equal(queries, 1, "fallback stays in the original native session");
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.deepEqual(modeChanges, scenario === "supported" ? ["auto"] : ["auto", "default"]);
    const fallback = events.find(
      (event) => event.type === "runtime.diagnostic" && event.name === "claude.auto_review.fallback",
    );
    assert.equal(Boolean(fallback), scenario !== "supported");
    if (fallback?.type === "runtime.diagnostic") {
      assert.equal(fallback.data.to, "default");
      assert.equal(typeof fallback.data.reason, "string");
    }
    assert.equal(existsSync(join(cwd, scenario, "opengrove-models-cache.json")), true);
  }
});

for (const scenario of ["ask-rejected", "canceled"] as const) {
  test(`Claude Auto fallback never claims success when ${scenario}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-auto-fallback-"));
    const controller = new AbortController();
    const modes: string[] = [];
    let submitted = 0;
    const query: ClaudeAgentSdkQueryFunction = (params) =>
      Object.assign(
        (async function* () {
          if (typeof params.prompt !== "string") for await (const _input of params.prompt) submitted++;
        })(),
        {
          setPermissionMode: async (mode: string) => {
            modes.push(mode);
            if (scenario === "canceled") controller.abort();
            throw new Error(mode === "auto" ? "auto mode disabled by settings" : "connection closed");
          },
          close() {},
        },
      ) as unknown as ReturnType<ClaudeAgentSdkQueryFunction>;
    const runtime = new ClaudeAgentSdkRuntime({ cwd, query });
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      input: "hello",
      context: context(cwd),
      tools: [],
      accessMode: "auto-review",
      signal: controller.signal,
    }))
      events.push(event);
    assert.equal(submitted, 0);
    assert.deepEqual(modes, scenario === "canceled" ? ["auto"] : ["auto", "default"]);
    assert.equal(
      events.some((event) => event.type === "runtime.diagnostic" && event.name === "claude.auto_review.fallback"),
      false,
    );
    assert.ok(events.some((event) => event.type === "error"));
    if (scenario === "ask-rejected")
      assert.ok(
        events.some(
          (event) =>
            event.type === "error" &&
            event.message.includes("claude_auto_review_fallback_failed") &&
            event.message.includes("connection closed"),
        ),
      );
    rmSync(cwd, { recursive: true, force: true });
  });
}

test("Auto fallback updates the Employee and PM bindings without inventing a user edit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-auto-employee-fallback-"));
  const statePath = join(cwd, "state.sqlite");
  const state = createBridgeState({ statePath });
  const employee = state.app.rooms.listMembers().find((member) => member.id === OPENGROVE_PM_MEMBER_ID)!;
  assert.equal(employee.accessMode, "auto-review");
  const binding = { ...employee, id: "member-app-test-pm", appId: "test" };
  state.app.rooms.upsertMember(binding);
  const event: AgentEvent = {
    type: "runtime.diagnostic",
    runId: "auto-fallback-test",
    at: new Date().toISOString(),
    name: "claude.auto_review.fallback",
    data: { kernel: "claude-code", from: "auto-review", to: "default", reason: "auto mode disabled by settings" },
  };
  const record = (captured: typeof employee) =>
    recordRoomRunEvent({
      state,
      activeExecutionState: state,
      eventSourceApp: state.app,
      event,
      events: [],
      model: captured.model,
      sessionId: "fallback-session",
      userInput: "hello",
      ...{ employee: captured },
    });
  record(binding);
  for (const id of [employee.id, binding.id]) {
    const saved = state.app.rooms.listMembers().find((member) => member.id === id)!;
    assert.equal(saved.accessMode, "default");
    assert.deepEqual(saved.userOverrides, employee.userOverrides);
  }
  const parts = persistedRoomRunParts([event], event.runId, "", { language: "zh-CN" });
  assert.ok(
    parts.some(
      (part) =>
        part.tone === "warn" &&
        String(part.text).includes("请求批准") &&
        String(part.text).includes("auto mode disabled by settings"),
    ),
  );
  await state.store.close?.();
  const restored = createBridgeState({ statePath });
  assert.equal(restored.app.rooms.listMembers().find((member) => member.id === employee.id)?.accessMode, "default");
  // A late event from an earlier turn must not overwrite a newer selection.
  restored.app.rooms.patchMember(employee.id, { accessMode: "full-access" });
  recordRoomRunEvent({
    state: restored,
    activeExecutionState: restored,
    eventSourceApp: restored.app,
    event,
    events: [],
    model: employee.model,
    sessionId: "fallback-session",
    userInput: "hello",
    ...{ employee },
  });
  assert.equal(restored.app.rooms.listMembers().find((member) => member.id === employee.id)?.accessMode, "full-access");
  await restored.store.close?.();
  rmSync(cwd, { recursive: true, force: true });
});

for (const scenario of ["supported", "unsupported", "unverified", "missing"] as const) {
  test(`Claude native activation succeeds independently of model metadata: ${scenario}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-default-permissions-"));
    let submitted = false;
    let acknowledged = false;
    let closed = false;
    const query: ClaudeAgentSdkQueryFunction = (params) => {
      assert.equal(params.options?.model, undefined, "the native default must remain selected by Claude");
      async function* messages() {
        assert.notEqual(typeof params.prompt, "string");
        if (typeof params.prompt !== "string") {
          for await (const _input of params.prompt) {
            assert.equal(acknowledged, true);
            submitted = true;
          }
        }
        yield {
          type: "system",
          subtype: "init",
          session_id: "default-session",
          model: "claude-default-concrete",
          permissionMode: "auto",
          claude_code_version: "test",
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          skills: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: "default-session",
          usage: {},
          modelUsage: {},
        };
      }
      return Object.assign(messages(), {
        supportedModels: async () => [
          ...(scenario === "missing"
            ? []
            : [
                {
                  value: "default",
                  displayName: "Default",
                  description: "Native configuration",
                  resolvedModel: "claude-default-concrete",
                  ...(scenario === "unverified" ? {} : { supportsAutoMode: scenario === "supported" }),
                },
              ]),
          { value: "claude-other", displayName: "Other", description: "Another model", supportsAutoMode: true },
        ],
        setPermissionMode: async (mode: string) => {
          assert.equal(mode, "auto");
          acknowledged = true;
        },
        close: () => {
          closed = true;
        },
      }) as unknown as ReturnType<ClaudeAgentSdkQueryFunction>;
    };
    const runtime = new ClaudeAgentSdkRuntime({
      cwd,
      env: { CLAUDE_CONFIG_DIR: cwd },
      query,
    });
    const events: AgentEvent[] = [];
    for await (const event of runtime.runTurn({
      input: "hello",
      context: context(cwd),
      requestedModelId: "claude-code-default",
      tools: [],
      accessMode: "auto-review",
    }))
      events.push(event);

    assert.equal(closed, true);
    assert.equal(submitted, true);
    assert.equal(acknowledged, true);
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 0);
  });
}

test("Claude permissions use the kernel default without model metadata", () => {
  assert.equal(normalizeEmployeeAccessMode("claude-code", undefined), "auto-review");
  assert.equal(normalizeEmployeeAccessMode("claude-code", "auto-review"), "auto-review");
  assert.equal(normalizeEmployeeAccessMode("claude-code", "default"), "default");
  assert.equal(normalizeEmployeeAccessMode("claude-code", "full-access"), "full-access");
});

test("unrecognized App permissions resolve to Ask instead of the kernel default", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-invalid-permissions-"));
  const invalidModes = ["ask", "read-only", "auto", "", false, 123, {}, null];
  try {
    mkdirSync(join(appRoot, "workspace"));
    writeFileSync(
      join(appRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "invalid-permissions",
        title: "Invalid permissions",
        workspace: { path: "workspace" },
        employees: [
          ...invalidModes.map((accessMode, index) => ({
            id: `writer${index}`,
            kernel: "claude-code",
            model: "deepseek-v4-flash",
            accessMode,
          })),
          { id: "omitted", kernel: "claude-code", model: "deepseek-v4-flash" },
        ],
      }),
    );
    const members = mountedAppDefaultEmployees({
      ...defaultBridgeSettings(),
      mountedApps: [{ id: "invalid-permissions", path: appRoot, enabled: true }],
    });
    for (const [index, invalid] of invalidModes.entries()) {
      const member = members.find((candidate) => candidate.id === `member-app-invalid-permissions-writer${index}`);
      assert.equal(member?.accessMode, "default", JSON.stringify(invalid));
      assert.equal(member?.manifestDefaults?.accessMode, "default");
      for (const kernel of ["codex", "claude-code", "hermes"])
        assert.equal(normalizeEmployeeAccessMode(kernel, invalid), "default", `${kernel}: ${JSON.stringify(invalid)}`);
    }
    assert.equal(
      members.find((member) => member.id === "member-app-invalid-permissions-omitted")?.accessMode,
      "auto-review",
      "omitting a permission still uses the product default",
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("Hermes presets use separate native homes, preserve denials and still ask user questions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-presets-"));
  const sourceHome = join(cwd, "source");
  mkdirSync(sourceHome);
  const sourceConfig =
    "approvals:\n  mode: off\n  deny_rules: [never-delete]\nauxiliary:\n  approval:\n    model: reviewer\n";
  writeFileSync(join(sourceHome, "config.yaml"), sourceConfig);
  const gateway = join(cwd, "gateway.mjs");
  writeFakeHermesGateway(gateway, { includeConfigEcho: true, serverRequests: true });
  const runtime = new HermesRuntime({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [gateway],
    cwd,
    env: { HERMES_HOME: sourceHome, HERMES_YOLO_MODE: "1", OPENGROVE_HERMES_ISOLATED_HOME: "1" },
    approvalTimeoutMs: 1000,
  });
  const homes = new Map<string, string>();
  try {
    for (const [accessMode, mode] of [
      ["default", "manual"],
      ["auto-review", "smart"],
      ["full-access", "off"],
      ["default", "manual"],
    ] as const) {
      const ctx = context(cwd);
      let answer = "";
      for await (const event of runtime.runTurn({ input: "hi", context: ctx, tools: [], accessMode })) {
        if (event.type === "approval.requested") ctx.approvals.decide(event.request.id, "approved");
        if (event.type === "question.requested")
          ctx.questions.decide(event.question.id, "answered", { answer: "alpha" });
        if (event.type === "model.response") answer = event.response.text;
        if (event.type === "error") assert.fail(event.message);
      }
      assert.match(answer, new RegExp(`mode: ['"]?${mode}\\b`));
      assert.match(answer, /never-delete/);
      assert.match(answer, /reviewer/);
      assert.match(answer, /ANSWER:alpha/);
      const home = answer.match(/HERMES_HOME:([^\n]+)/)?.[1];
      assert.ok(home);
      assert.notEqual(home, sourceHome);
      if (homes.has(mode)) assert.equal(home, homes.get(mode));
      homes.set(mode, home);
    }
    assert.equal(new Set(homes.values()).size, 3);
    assert.equal(readFileSync(join(sourceHome, "config.yaml"), "utf8"), sourceConfig);
  } finally {
    runtime.close();
  }
  for (const home of homes.values()) assert.equal(existsSync(home), false, "closing removes owned credential copies");
});

test("Hermes omitted permission retains native approval mode and YOLO configuration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-omitted-"));
  const gateway = join(cwd, "gateway.mjs");
  writeFileSync(join(cwd, "config.yaml"), "approvals:\n  mode: smart\n");
  writeFakeHermesGateway(gateway, { approvalMode: "smart", skipBlockingPrompts: true });
  const prepared = prepareHermesRuntimeEnv({
    runtimeEnv: { HERMES_HOME: cwd, HERMES_YOLO_MODE: "1" },
    providerConfig: undefined,
    nativeSkillDir: undefined,
    isolatedHome: undefined,
  });
  assert.equal(prepared.env.HERMES_YOLO_MODE, "1");
  const runtime = new HermesRuntime({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [gateway],
    cwd,
    env: { HERMES_HOME: cwd },
  });
  try {
    const events = [];
    for await (const event of runtime.runTurn({ input: "hi", context: context(cwd), tools: [] })) events.push(event);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "model.response"),
      true,
    );
    const copied = prepareHermesRuntimeEnv({
      runtimeEnv: { HERMES_HOME: cwd, OPENGROVE_HERMES_ISOLATED_HOME: "1" },
      providerConfig: undefined,
      nativeSkillDir: undefined,
      isolatedHome: undefined,
    });
    try {
      assert.match(readFileSync(join(copied.isolatedHome!, "config.yaml"), "utf8"), /mode: smart/);
    } finally {
      rmSync(copied.isolatedHome!, { recursive: true, force: true });
    }
  } finally {
    runtime.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Hermes checks native mode even for custom gateway commands before submitting a prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-mode-test-"));
  const gateway = join(cwd, "gateway.mjs");
  writeFakeHermesGateway(gateway, { approvalMode: "manual", skipBlockingPrompts: true });
  const runtime = new HermesRuntime({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [gateway],
    cwd,
    env: { HERMES_HOME: cwd, OPENGROVE_HERMES_ISOLATED_HOME: "1" },
  });
  try {
    const events = [];
    for await (const event of runtime.runTurn({
      input: "hi",
      context: context(cwd),
      tools: [],
      accessMode: "auto-review",
    }))
      events.push(event);
    assert.ok(
      events.some((event) => event.type === "error" && event.message.includes("runtime_access_mode_unavailable")),
    );
    assert.equal(
      events.some((event) => event.type === "model.requested"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "model.response"),
      false,
    );
  } finally {
    runtime.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const ending of ["timeout", "gateway-close"] as const) {
  test(`Hermes settles pending approvals on ${ending} without caller timeout configuration`, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-hermes-pending-test-"));
    const gateway = join(cwd, "gateway.mjs");
    writeFakeHermesGateway(gateway, { serverRequests: true });
    const runtime = new HermesRuntime({
      command: process.execPath,
      gatewayCommand: process.execPath,
      gatewayArgs: [gateway],
      cwd,
      env: { HERMES_HOME: cwd, OPENGROVE_HERMES_ISOLATED_HOME: "1" },
    });
    const ctx = context(cwd);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let approvalId = "";
    try {
      for await (const event of runtime.runTurn({ input: "hi", context: ctx, tools: [], accessMode: "full-access" })) {
        if (event.type === "approval.requested") {
          approvalId = event.request.id;
          if (ending === "timeout") t.mock.timers.tick(300_000);
          else runtime.close();
        }
        if (event.type === "question.requested")
          ctx.questions.decide(event.question.id, "answered", { answer: "alpha" });
      }
      assert.ok(approvalId);
      assert.notEqual(ctx.approvals.get(approvalId)?.status, "pending");
      assert.notEqual(ctx.approvals.get(approvalId)?.status, "approved");
      assert.equal(ctx.approvals.get(approvalId)?.status, ending === "timeout" ? "rejected" : "canceled");
    } finally {
      runtime.close();
      t.mock.timers.reset();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("stored malformed permissions resolve to Ask instead of becoming unset", () => {
  const rooms = new RoomChannelStore();
  for (const kernel of ["codex", "claude-code", "hermes"])
    for (const mode of ["ask", "read-only", "auto"]) {
      rooms.upsertMember({
        id: `${kernel}-${mode}`,
        name: mode,
        kernel,
        model: "test-model",
        role: "",
        status: "idle",
        color: "",
        lastActive: "",
        // Malformed persisted data can predate current write-boundary validation.
        accessMode: mode as RoomChannelMember["accessMode"],
      });
    }
  for (const member of rooms.listMembers()) assert.equal(member.accessMode, "default", member.id);
});

test("upgrading raises supported Ask to Auto, preserves Full and repairs unsupported modes", () => {
  const rooms = new RoomChannelStore();
  for (const kernel of ["codex", "claude-code", "hermes", "pi", "kimi", "opencode"])
    for (const accessMode of ["default", "auto-review", "full-access", undefined] as const)
      rooms.upsertMember({
        id: `${kernel}-${accessMode ?? "unset"}`,
        name: accessMode ?? "unset",
        kernel,
        model: "gpt-test",
        role: "",
        status: "idle",
        color: "",
        lastActive: "",
        accessMode,
      });
  let backups = 0;
  assert.equal(
    migrateNativeApprovalPresetsV4(rooms, () => {
      backups += 1;
    }),
    true,
  );
  assert.equal(backups, 1);
  for (const member of rooms.listMembers()) {
    const original = member.id.slice(member.kernel.length + 1);
    const unsupportedAuto = original === "auto-review" && ["pi", "kimi", "opencode"].includes(member.kernel);
    const supportsAuto = ["codex", "claude-code", "hermes"].includes(member.kernel);
    const expected =
      supportsAuto && ["unset", "default"].includes(original)
        ? "auto-review"
        : original === "unset"
          ? "default"
          : unsupportedAuto
            ? "default"
            : original;
    assert.equal(member.accessMode, expected, member.id);
    assert.equal(member.userOverrides, undefined, "system migration must not invent user edits");
  }
  assert.equal(migrateNativeApprovalPresetsV4(rooms), false);
});

test("a migrated App permission survives unchanged defaults without taking ownership from the manifest", () => {
  const rooms = new RoomChannelStore();
  const seed = {
    id: "member-app-ownership-writer",
    appId: "ownership",
    name: "Writer",
    kernel: "codex",
    model: "gpt-test",
    role: "",
    status: "idle" as const,
    color: "",
    lastActive: "",
    accessMode: "default" as const,
    manifestDefaults: { accessMode: "default" as const },
    userOverrides: ["name"],
  };
  rooms.upsertMember(seed);
  migrateNativeApprovalPresetsV4(rooms);
  const migrated = rooms.listMembers()[0]!;
  assert.deepEqual(migrated.userOverrides, ["name"]);
  const synced = syncMountedAppSeedMember(migrated, seed);
  assert.equal(synced.accessMode, "auto-review");
  const updated = syncMountedAppSeedMember(synced, {
    ...seed,
    accessMode: "full-access",
    manifestDefaults: { accessMode: "full-access" },
  });
  assert.equal(updated.accessMode, "full-access", "a changed App declaration still owns its default");
});

test("permission migration uses Claude kernel support independently of the model", () => {
  const rooms = new RoomChannelStore();
  const models = ["claude-opus-5", "claude-opus-4-8", "deepseek-v4-flash", "claude-custom"];
  for (const model of models)
    for (const accessMode of ["default", "auto-review", "full-access"] as const)
      rooms.upsertMember({
        id: `${model}-${accessMode}`,
        name: model,
        kernel: "claude-code",
        model,
        role: "",
        status: "idle",
        color: "",
        lastActive: "",
        accessMode,
        userOverrides: ["accessMode"],
      });
  migrateNativeApprovalPresetsV4(rooms);
  const members = new Map(rooms.listMembers().map((member) => [member.id, member]));
  for (const model of models) {
    assert.equal(members.get(`${model}-default`)?.accessMode, "auto-review");
    assert.equal(members.get(`${model}-auto-review`)?.accessMode, "auto-review");
    assert.equal(members.get(`${model}-full-access`)?.accessMode, "full-access");
  }
});

test("permission migration keeps Gateway and remote permission ownership", () => {
  const rooms = new RoomChannelStore();
  rooms.upsertMember({
    id: "gateway",
    name: "Gateway",
    role: "",
    status: "idle",
    color: "",
    lastActive: "",
    kernel: "openclaw",
    model: "native",
    accessMode: "full-access",
  });
  rooms.upsertMember({
    id: "remote",
    name: "Remote",
    role: "",
    status: "idle",
    color: "",
    lastActive: "",
    kernel: "codex",
    model: "native",
    source: "remote",
    accessMode: "default",
  });
  migrateNativeApprovalPresetsV4(rooms);
  assert.equal(rooms.listMembers().find((member) => member.id === "gateway")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.userOverrides, undefined);
});

for (const kind of ["sqlite", "json"] as const)
  for (const damage of ["missing", "corrupt"] as const) {
    test(`${kind} employee migrations survive ${damage} settings without repeating the Auto upgrade`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "opengrove-migration-ledger-"));
      const statePath = join(cwd, `state.${kind}`);
      const openState = () =>
        createBridgeState(kind === "json" ? { store: createJsonStateStore(statePath) } : { statePath });
      let state = openState();
      const damageSettings = () => {
        if (damage === "missing") rmSync(bridgeSettingsPath(state), { force: true });
        else writeFileSync(bridgeSettingsPath(state), "{ broken settings");
      };
      try {
        state.app.rooms.upsertMember({
          id: "legacy-pinned",
          name: "Legacy",
          kernel: "claude-code",
          model: "native",
          accessMode: "default",
          userOverrides: ["model"],
          role: "",
          status: "idle",
          color: "",
          lastActive: "",
        });
        // Model an old database, before migration completion was stored with its Employees.
        state.app.rooms.restore(Object.assign(state.app.rooms.snapshot(), { employeeMigrationVersions: undefined }));
        state.store.saveFrom(state.app);
        damageSettings();
        await state.store.close?.();
        state = openState();
        const migrated = state.app.rooms.listMembers().find((member) => member.id === "legacy-pinned")!;
        assert.equal(migrated.model, "deepseek-v4-flash");
        assert.equal(migrated.accessMode, "auto-review");
        state.app.rooms.patchMember(migrated.id, { accessMode: "default", userOverrides: ["accessMode"] });
        state.store.saveFrom(state.app);
        damageSettings();
        await state.store.close?.();
        state = openState();
        assert.equal(state.app.rooms.listMembers().find((member) => member.id === migrated.id)?.accessMode, "default");
      } finally {
        await state.store.close?.();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

for (const previousVersion of [0, 1, 2, 3]) {
  test(`permission migration from version ${previousVersion} preserves later user choices`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-persisted-permission-migration-"));
    const statePath = join(cwd, "state.sqlite");
    const legacy = createBridgeState({ statePath });
    legacy.app.rooms.upsertMember({
      id: "legacy-auto-review",
      name: "Legacy",
      kernel: "codex",
      model: "gpt-test",
      role: "",
      status: "idle",
      color: "",
      lastActive: "",
      accessMode: "auto-review",
      source: "local",
    });
    legacy.app.rooms.upsertMember({
      id: "unsupported-auto",
      name: "Unsupported",
      kernel: "pi",
      model: "pi-test",
      role: "",
      status: "idle",
      color: "",
      lastActive: "",
      accessMode: "auto-review",
    });
    legacy.app.rooms.patchMember("pm", { accessMode: "default", userOverrides: ["accessMode"] });
    legacy.app.rooms.restore(Object.assign(legacy.app.rooms.snapshot(), { employeeMigrationVersions: undefined }));
    legacy.store.saveFrom(legacy.app);
    legacy.settings.nativeApprovalPresetsVersion = previousVersion;
    saveBridgeSettings(legacy);
    await legacy.store.close?.();
    const migrated = createBridgeState({ statePath });
    assert.equal(
      migrated.app.rooms.listMembers().find((member) => member.id === "legacy-auto-review")?.accessMode,
      "auto-review",
    );
    assert.equal(migrated.app.rooms.listMembers().find((m) => m.id === "pm")?.accessMode, "auto-review");
    assert.equal(migrated.app.rooms.listMembers().find((m) => m.id === "unsupported-auto")?.accessMode, "default");
    assert.equal(migrated.settings.nativeApprovalPresetsVersion, 4);
    assert.equal(existsSync(`${statePath}.before-native-approval-presets-v4.json`), true);
    migrated.app.rooms.patchMember("legacy-auto-review", { accessMode: "default" });
    migrated.app.rooms.patchMember("pm", { accessMode: "default", userOverrides: undefined });
    migrated.store.saveFrom(migrated.app);
    await migrated.store.close?.();
    const restarted = createBridgeState({ statePath });
    try {
      assert.equal(
        restarted.app.rooms.listMembers().find((member) => member.id === "legacy-auto-review")?.accessMode,
        "default",
      );
      assert.equal(restarted.app.rooms.listMembers().find((member) => member.id === "pm")?.accessMode, "default");
    } finally {
      await restarted.store.close?.();
    }
  });
}

test("one-time Auto migration preserves Full, protects App choices and resolves legacy models first", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-auto-floor-"));
  const statePath = join(cwd, "state.sqlite");
  const appRoot = join(cwd, "app");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "permission-floor",
      title: "Permission floor",
      workspace: { path: "workspace" },
      employees: [
        { id: "writer", kernel: "codex", model: "gpt-test", accessMode: "default" },
        { id: "full", kernel: "codex", model: "gpt-test", accessMode: "default" },
      ],
    }),
  );
  let state = createBridgeState({ statePath });
  const restart = async () => {
    state.store.saveFrom(state.app);
    saveBridgeSettings(state);
    await state.store.close?.();
    state = createBridgeState({ statePath });
  };
  try {
    state.settings.mountedApps = [{ id: "permission-floor", path: appRoot, enabled: true }];
    await restart();
    state.settings.nativeApprovalPresetsVersion = 3;
    state.app.rooms.restore(Object.assign(state.app.rooms.snapshot(), { employeeMigrationVersions: undefined }));
    state.settings.employeeModelMigrationVersion = 0;
    state.app.rooms.patchMember("pm", { accessMode: "full-access", userOverrides: undefined });
    state.app.rooms.patchMember("grove-guide", { accessMode: "default", model: "native", userOverrides: undefined });
    state.app.rooms.patchMember("member-app-permission-floor-full", {
      accessMode: "full-access",
      userOverrides: undefined,
    });
    await restart();
    const member = (id: string) => state.app.rooms.listMembers().find((entry) => entry.id === id)!;
    assert.equal(member("pm").accessMode, "full-access");
    assert.equal(member("grove-guide").accessMode, "auto-review");
    assert.equal(member("member-app-permission-floor-writer").accessMode, "auto-review");
    assert.equal(member("member-app-permission-floor-full").accessMode, "full-access");
    const pmBindings = state.app.rooms
      .listMembers()
      .filter((entry) => entry.appId && entry.employeeDefinitionId === "pm");
    assert.ok(pmBindings.length > 0);
    for (const binding of pmBindings) assert.equal(binding.accessMode, "full-access");
    const backupPath = `${statePath}.before-native-approval-presets-v4.json`;
    const backup = readFileSync(backupPath, "utf8");
    state.app.rooms.patchMember("pm", { accessMode: "default", userOverrides: undefined });
    state.app.rooms.patchMember("member-app-permission-floor-writer", {
      accessMode: "default",
      userOverrides: ["accessMode"],
    });
    await restart();
    assert.equal(member("pm").accessMode, "default");
    assert.equal(member("member-app-permission-floor-writer").accessMode, "default");
    assert.equal(member("member-app-permission-floor-full").accessMode, "full-access");
    assert.equal(readFileSync(backupPath, "utf8"), backup);
    for (const binding of state.app.rooms
      .listMembers()
      .filter((entry) => entry.appId && entry.employeeDefinitionId === "pm"))
      assert.equal(binding.accessMode, "default");
  } finally {
    await state.store.close?.();
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const initialSupport of [false, true]) {
  test(`saved Employee permissions survive Claude cache refresh and loss (initial support: ${initialSupport})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-permission-cache-drift-"));
    const configHome = join(cwd, "claude");
    const statePath = join(cwd, "state.sqlite");
    const appRoot = join(cwd, "app");
    const writeSupport = (supportsAutoMode: boolean) => {
      mkdirSync(configHome, { recursive: true });
      writeFileSync(
        join(configHome, "opengrove-models-cache.json"),
        JSON.stringify({
          updatedAt: "2026-09-15T00:00:00Z",
          models: ["deepseek-v4-flash", "claude-custom"].map((id) => ({ id, supportsAutoMode })),
        }),
      );
    };
    writeSupport(initialSupport);
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    const manifest = {
      id: "cache-drift",
      title: "Cache drift",
      workspace: { path: "workspace" },
      employees: [
        { id: "writer", kernel: "claude-code", model: "claude-custom" },
        { id: "store", kernel: "claude-code", model: "claude-custom" },
        { id: "declared", kernel: "claude-code", model: "claude-custom", accessMode: "full-access" },
      ],
      store: {
        employeeDefaults: [
          {
            memberId: "member-app-cache-drift-store",
            name: "Store",
            kernel: "claude-code",
            model: "claude-custom",
          },
        ],
      },
    };
    writeFileSync(join(appRoot, "opengrove.app.json"), JSON.stringify(manifest));
    let state = createBridgeState({ statePath });
    const restart = async () => {
      saveBridgeSettings(state);
      state.store.saveFrom(state.app);
      await state.store.close?.();
      state = createBridgeState({ statePath });
    };
    try {
      state.settings.kernelPathOverrides["claude-code"] = { configHome };
      state.settings.mountedApps = [{ id: "cache-drift", path: appRoot, enabled: true, appBuilderEnabled: true }];
      state.settings.nativeApprovalPresetsVersion = 4;
      state.app.rooms.patchMember("grove-guide", { accessMode: initialSupport ? "auto-review" : "default" });
      state.app.rooms.patchMember("app-builder", { accessMode: initialSupport ? "auto-review" : "default" });
      await restart();
      const expected = initialSupport ? "auto-review" : "default";
      const assertSavedPermissions = (declared: "default" | "full-access" = "full-access") => {
        const members = state.app.rooms.listMembers();
        const stable = members.filter(
          (member) =>
            ["grove-guide", "app-builder", "member-app-cache-drift-writer", "member-app-cache-drift-store"].includes(
              member.id,
            ) ||
            (member.appId === "cache-drift" && member.employeeDefinitionId === "app-builder"),
        );
        assert.equal(stable.length, 5);
        for (const member of stable) {
          assert.equal(
            member.accessMode,
            ["member-app-cache-drift-writer", "member-app-cache-drift-store"].includes(member.id)
              ? "auto-review"
              : expected,
            member.id,
          );
          assert.equal(
            member.userOverrides?.includes("accessMode") ?? false,
            false,
            "a saved default remains distinct from a user override",
          );
        }
        assert.equal(members.find((member) => member.id === "member-app-cache-drift-declared")?.accessMode, declared);
        const pms = members.filter((member) => member.employeeDefinitionId === "pm");
        assert.equal(pms.length, 2, "the global PM and its App binding share the product default");
        for (const pm of pms) {
          assert.equal(pm.accessMode, "auto-review", pm.id);
          assert.equal(pm.model, "deepseek-v4-flash", pm.id);
        }
      };
      assertSavedPermissions();
      for (const support of [!initialSupport, initialSupport, undefined]) {
        if (support === undefined) rmSync(join(configHome, "opengrove-models-cache.json"));
        else writeSupport(support);
        await restart();
        assertSavedPermissions();
      }
      writeSupport(!initialSupport);
      manifest.employees.find((employee) => employee.id === "declared")!.accessMode = "default";
      manifest.employees.push({ id: "fresh", kernel: "claude-code", model: "claude-custom" });
      writeFileSync(join(appRoot, "opengrove.app.json"), JSON.stringify(manifest));
      await restart();
      assertSavedPermissions("default");
      assert.equal(
        state.app.rooms.listMembers().find((member) => member.id === "member-app-cache-drift-fresh")?.accessMode,
        "auto-review",
        "new Claude Employees use the kernel default regardless of metadata",
      );
    } finally {
      await state.store.close?.();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const declaration of ["omitted", "manifest", "store"] as const) {
  test(`restoring App defaults ignores user edits after restart (${declaration})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-app-default-permission-"));
    const appRoot = join(cwd, "app");
    const memberId = "member-app-defaults-writer";
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(appRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "defaults",
        title: "Defaults",
        workspace: { path: "workspace" },
        employees: [
          {
            id: "writer",
            name: "App writer",
            kernel: "codex",
            model: "gpt-test",
            ...(declaration === "manifest" ? { accessMode: "default" } : {}),
          },
        ],
        ...(declaration === "store"
          ? {
              store: {
                employeeDefaults: [
                  { memberId, name: "App writer", kernel: "codex", model: "gpt-test", accessMode: "default" },
                ],
              },
            }
          : {}),
      }),
    );
    const statePath = join(cwd, "state.sqlite");
    let state = createBridgeState({ statePath });
    const restart = async () => {
      state.store.saveFrom(state.app);
      saveBridgeSettings(state);
      await state.store.close?.();
      state = createBridgeState({ statePath });
    };
    const member = () => state.app.rooms.listMembers().find((value) => value.id === memberId)!;
    try {
      state.settings.mountedApps = [{ id: "defaults", path: appRoot, enabled: true }];
      await restart();
      state.app.rooms.patchMember(memberId, {
        name: "My writer",
        accessMode: "full-access",
        userOverrides: ["name", "accessMode"],
      });
      await restart();
      assert.equal(member().accessMode, "full-access", "ordinary startup preserves user permission");
      assert.equal(member().manifestDefaults?.accessMode, declaration === "omitted" ? undefined : "default");
      assert.equal(member().manifestDefaults?.name, "App writer");
      const request = new IncomingMessage(new Socket());
      request.method = "POST";
      const response = new ServerResponse(request);
      let status = 0;
      try {
        await dispatchBridgeRoutes(createBridgeRoutes(), {
          traceId: "restore-default-test",
          security: { authMode: "bridge-token", allowedOrigins: [] },
          request,
          response,
          state,
          url: new URL(`http://opengrove.test/rooms/members/${memberId}/restore-app-defaults`),
          readJsonBody: async () => ({}),
          sendJson: (_response, code) => {
            status = code;
          },
        });
      } finally {
        request.destroy();
        request.socket.destroy();
      }
      assert.equal(status, 200);
      const expected = declaration === "omitted" ? "auto-review" : "default";
      assert.equal(member().accessMode, expected);
      assert.equal(member().name, "App writer");
      await restart();
      assert.equal(member().accessMode, expected, "restored defaults survive restart");
      state.app.rooms.patchMember(memberId, { accessMode: "full-access", userOverrides: ["accessMode"] });
      state.store.saveFrom(state.app);
      recreateBridgeApp(state, { authoritativeEmployeeConfigAppId: "defaults" });
      assert.equal(member().accessMode, expected, "App activation reapplies its defaults");
    } finally {
      await state.store.close?.();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const configuredSupport of [true, false]) {
  test(`Claude employee lifecycle ignores conflicting permission caches (${configuredSupport})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-configured-claude-permissions-"));
    const configuredHome = join(cwd, "configured-claude");
    const ambientHome = join(cwd, "ambient-claude");
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    for (const [home, supportsAutoMode] of [
      [configuredHome, configuredSupport],
      [ambientHome, !configuredSupport],
    ] as const) {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "opengrove-models-cache.json"),
        JSON.stringify({
          updatedAt: "2026-09-15T00:00:00Z",
          models: ["default", "deepseek-v4-flash", "claude-custom"].map((id) => ({ id, supportsAutoMode })),
        }),
      );
    }
    process.env.CLAUDE_CONFIG_DIR = ambientHome;
    const statePath = join(cwd, "state.sqlite");
    let state = createBridgeState({ statePath });
    try {
      state.settings.kernelPathOverrides["claude-code"] = { configHome: configuredHome };
      state.settings.nativeApprovalPresetsVersion = 0;
      state.app.rooms.restore(Object.assign(state.app.rooms.snapshot(), { employeeMigrationVersions: undefined }));
      for (const id of ["grove-guide", "app-builder"]) state.app.rooms.patchMember(id, { accessMode: undefined });
      state.app.rooms.upsertMember({
        ...state.app.rooms.listMembers().find((member) => member.id === "app-builder")!,
        id: "configuration-migration",
        model: "claude-custom",
        accessMode: undefined,
      });
      saveBridgeSettings(state);
      state.store.saveFrom(state.app);
      await state.store.close?.();
      state = createBridgeState({ statePath });
      for (const id of ["grove-guide", "app-builder", "configuration-migration"]) {
        assert.equal(state.app.rooms.listMembers().find((member) => member.id === id)?.accessMode, "auto-review", id);
      }
      assert.equal(state.app.rooms.listMembers().find((member) => member.id === "pm")?.accessMode, "auto-review");
      const expected = "auto-review";
      const mutateMember = async (
        path: string,
        method: string,
        body: Record<string, unknown>,
        expectedStatus = 200,
      ) => {
        const socket = new Socket();
        const request = new IncomingMessage(socket);
        request.method = method;
        const response = new ServerResponse(request);
        let responseStatus: number | undefined;
        try {
          assert.equal(
            await dispatchBridgeRoutes(createBridgeRoutes(), {
              traceId: "permission-test",
              security: { authMode: "bridge-token", allowedOrigins: [] },
              request,
              response,
              url: new URL(path, "http://opengrove.test"),
              state,
              readJsonBody: async () => body,
              sendJson: (_response, status) => {
                responseStatus = status;
              },
            }),
            true,
          );
          assert.equal(responseStatus, expectedStatus);
        } finally {
          request.destroy();
          socket.destroy();
        }
      };
      await mutateMember("/rooms/members", "POST", {
        id: "new-claude",
        kernel: "claude-code",
        model: "claude-custom",
      });
      const memberById = (id: string) => state.app.rooms.listMembers().find((member) => member.id === id)!;
      assert.equal(memberById("new-claude").accessMode, expected, "upsert route");
      const roomId = state.app.rooms.createRoom({
        id: "permission-context-room",
        title: "Permission Context",
        memberIds: ["new-claude"],
      }).id;
      await mutateMember(`/rooms/${encodeURIComponent(roomId)}/members`, "POST", {
        id: "room-claude",
        kernel: "claude-code",
        model: "claude-custom",
      });
      assert.equal(memberById("room-claude").accessMode, expected, "room add route");
      await mutateMember("/rooms/dm", "POST", {
        memberId: "direct-claude",
        member: { id: "direct-claude", kernel: "claude-code", model: "claude-custom" },
      });
      assert.equal(memberById("direct-claude").accessMode, expected, "direct room creation uses the configured home");
      await mutateMember(
        "/rooms/members",
        "POST",
        {
          id: "explicit-auto",
          kernel: "claude-code",
          model: "claude-custom",
          accessMode: "auto-review",
        },
        200,
      );
      assert.equal(memberById("explicit-auto").accessMode, "auto-review");
      state.app.rooms.patchMember("grove-guide", { model: "claude-custom", accessMode: undefined });
      await mutateMember("/rooms/members/grove-guide", "PATCH", { kernel: "claude-code", model: null });
      assert.equal(
        memberById("grove-guide").accessMode,
        "auto-review",
        "resolve the reset model before its permission default",
      );
      state.app.rooms.patchMember("new-claude", { kernel: "codex", accessMode: undefined });
      await mutateMember("/rooms/members/new-claude", "PATCH", { kernel: "claude-code" });
      assert.equal(memberById("new-claude").accessMode, expected, "kernel switch route");
      await mutateMember("/rooms/members/new-claude", "PATCH", { accessMode: "full-access" });
      assert.equal(memberById("new-claude").accessMode, "full-access", "explicit permission survives");
      await mutateMember("/rooms/members/grove-guide", "PATCH", { accessMode: "full-access" });
      await mutateMember("/rooms/members/grove-guide", "PATCH", { accessMode: null });
      assert.equal(memberById("grove-guide").accessMode, "auto-review", "null clears to the product default");
      assert.equal(memberById("grove-guide").userOverrides?.includes("accessMode"), false);
      await mutateMember("/rooms/members/grove-guide", "PATCH", { model: "claude-custom" });
      assert.equal(memberById("grove-guide").model, "claude-custom");
      assert.equal(memberById("grove-guide").accessMode, "auto-review", "unknown metadata preserves saved Auto");
      await mutateMember("/rooms/members/grove-guide", "PATCH", { providerId: "custom-provider" });
      assert.equal(memberById("grove-guide").providerId, "custom-provider");
      await mutateMember("/rooms/members/grove-guide", "PATCH", {
        kernel: "claude-code",
        model: "another-custom-model",
        accessMode: "auto-review",
      });
      assert.equal(memberById("grove-guide").accessMode, "auto-review", "full edits may repeat the saved preset");
      const savedAutoEdit = {
        id: "grove-guide",
        kernel: "claude-code",
        model: "another-custom-model",
        accessMode: "auto-review",
      };
      await mutateMember("/rooms/members", "POST", savedAutoEdit);
      await mutateMember(`/rooms/${encodeURIComponent(roomId)}/members`, "POST", savedAutoEdit);
      assert.equal(memberById("grove-guide").accessMode, "auto-review", "upsert and room add retain saved Auto");
      await mutateMember("/rooms/members/grove-guide", "PATCH", { kernel: "pi", model: "pi-test" });
      assert.equal(memberById("grove-guide").accessMode, "default", "a kernel without Auto still normalizes to Ask");

      const appRoot = join(cwd, "app");
      mkdirSync(join(appRoot, "workspace"), { recursive: true });
      writeFileSync(
        join(appRoot, "opengrove.app.json"),
        JSON.stringify({
          id: "permission-context",
          title: "Permission Context",
          workspace: { path: "workspace" },
          employees: [{ id: "writer", kernel: "claude-code", model: "claude-custom" }],
          store: {
            employeeDefaults: [
              {
                memberId: "member-app-permission-context-writer",
                name: "Writer",
                kernel: "claude-code",
                model: "claude-custom",
              },
            ],
          },
        }),
      );
      const mountedMembers = mountedAppDefaultEmployees({
        ...state.settings,
        mountedApps: [{ id: "permission-context", path: appRoot, enabled: true, appBuilderEnabled: true }],
      });
      const appEmployees = mountedMembers.filter((member) => member.employeeDefinitionId !== "pm");
      assert.equal(appEmployees.length, 2);
      for (const member of appEmployees) {
        assert.equal(
          member.accessMode,
          member.employeeDefinitionId === "app-builder" ? "auto-review" : expected,
          `mounted ${member.id}`,
        );
      }
      state.app.rooms.patchMember("new-claude", {
        appId: "permission-context",
        userOverrides: ["accessMode"],
        manifestDefaults: { kernel: "claude-code", model: "claude-custom" },
      });
      await mutateMember("/rooms/members/new-claude/restore-app-defaults", "POST", {});
      assert.equal(memberById("new-claude").accessMode, expected, "restore App defaults route");
    } finally {
      await state.store.close?.();
      if (previousHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousHome;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("employee creation prefers auto only where supported and preserves explicit choices", () => {
  for (const kernel of ["codex", "hermes"]) {
    assert.equal(normalizeEmployee({ id: "employee", kernel }).accessMode, "auto-review");
    assert.equal(normalizeEmployee({ id: "employee", kernel, accessMode: "full-access" }).accessMode, "full-access");
    assert.equal(normalizeEmployee({ id: "employee", kernel, accessMode: "default" }).accessMode, "default");
  }
  for (const kernel of ["pi", "kimi", "opencode"]) {
    assert.equal(normalizeEmployee({ id: "employee", kernel, accessMode: "auto-review" }).accessMode, "default");
    assert.equal(normalizeEmployee({ id: "employee", kernel }).accessMode, "default");
    assert.equal(normalizeEmployee({ id: "employee", kernel, accessMode: "default" }).accessMode, "default");
  }
  assert.equal(
    normalizeEmployee({ id: "employee", kernel: "openclaw", accessMode: "full-access" }).accessMode,
    "default",
  );
  assert.equal(
    normalizeEmployee({ id: "employee", kernel: "claude-code", accessMode: "auto-review" }).accessMode,
    "auto-review",
  );
});

test("App installation repairs both manifest and Store employee permission defaults", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-app-permission-import-"));
  const state = createBridgeState({ statePath: join(cwd, "state.sqlite") });
  const appRoot = join(cwd, "app");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "permission-import",
      title: "Permission import",
      workspace: { path: "workspace" },
      employees: [
        { id: "pi", name: "Pi", kernel: "pi", accessMode: "auto-review" },
        { id: "kimi", name: "Kimi", kernel: "kimi", accessMode: "auto-review" },
        { id: "opencode", name: "OpenCode", kernel: "opencode" },
        { id: "gateway", name: "Gateway", kernel: "openclaw", accessMode: "full-access" },
        { id: "new", name: "New", kernel: "codex" },
        { id: "declared-full", name: "Full", kernel: "claude-code", accessMode: "full-access" },
        { id: "declared-ask", name: "Ask", kernel: "codex", accessMode: "default" },
      ],
      store: {
        employeeDefaults: [
          {
            memberId: "member-app-permission-import-declared%2Dfull",
            name: "Full",
            kernel: "claude-code",
            model: "custom-model",
          },
          {
            memberId: "member-app-permission-import-opencode",
            name: "OpenCode",
            model: "opencode-default",
            kernel: "opencode",
            accessMode: "auto-review",
          },
        ],
      },
    }),
  );
  try {
    const members = mountedAppDefaultEmployees({
      ...state.settings,
      mountedApps: [{ id: "permission-import", path: appRoot, enabled: true }],
    });
    for (const id of ["pi", "kimi", "opencode", "gateway"])
      assert.equal(members.find((member) => member.id === `member-app-permission-import-${id}`)?.accessMode, "default");
    assert.equal(members.find((member) => member.id === "member-app-permission-import-new")?.accessMode, "auto-review");
    assert.equal(
      members.find((member) => member.id === "member-app-permission-import-declared%2Dfull")?.accessMode,
      "full-access",
    );
    assert.equal(
      members.find((member) => member.id === "member-app-permission-import-declared%2Dask")?.accessMode,
      "default",
    );
  } finally {
    await state.store.close?.();
  }
});

test("App publishing rejects impossible presets without treating unverified Claude support as impossible", () => {
  const employee = { memberId: "writer", name: "Writer", model: "native", color: "#000000" };
  for (const kernel of ["pi", "kimi", "opencode", "openclaw"]) {
    assert.throws(
      () => normalizeReleaseEmployee({ ...employee, kernel, accessMode: "auto-review" }),
      /runtime_access_mode_unavailable/,
    );
  }
  assert.throws(
    () => normalizeReleaseEmployee({ ...employee, kernel: "openclaw", accessMode: "full-access" }),
    /runtime_access_mode_unavailable/,
  );
  assert.equal(
    normalizeReleaseEmployee({ ...employee, kernel: "claude-code", accessMode: "auto-review" }).accessMode,
    "auto-review",
  );
});

test("Claude explicit presets and omitted permission defaults use distinct native options", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-nonauto-permissions-"));
  for (const [accessMode, nativeMode] of [
    ["default", "default"],
    ["full-access", "bypassPermissions"],
    [undefined, "bypassPermissions"],
  ] as const) {
    let selectedMode: unknown;
    let skipAllowed: unknown;
    const query: ClaudeAgentSdkQueryFunction = (params) => {
      selectedMode = params.options?.permissionMode;
      skipAllowed = params.options?.allowDangerouslySkipPermissions;
      async function* messages() {
        yield { type: "result", subtype: "success", result: "done", session_id: "session", usage: {}, modelUsage: {} };
      }
      return Object.assign(messages(), { close() {} }) as unknown as ReturnType<ClaudeAgentSdkQueryFunction>;
    };
    const runtime = new ClaudeAgentSdkRuntime({ cwd, configuredModel: "claude-test", query });
    for await (const _event of runtime.runTurn({ input: "hi", context: context(cwd), tools: [], accessMode })) {
    }
    assert.equal(selectedMode, nativeMode);
    assert.equal(skipAllowed, nativeMode === "bypassPermissions" ? true : undefined);
  }
});
