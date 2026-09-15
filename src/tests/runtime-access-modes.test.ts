import { createBridgeState, saveBridgeSettings } from "../server/bridge-state.js";
import { AcpCliRuntime } from "../runtime/acp-cli-runtime.js";
import { PiAgentRuntime } from "../runtime/pi-runtime.js";
import { OpenClawGatewayRuntime } from "../runtime/openclaw-gateway-runtime.js";
import { ClaudeAgentSdkRuntime, type ClaudeAgentSdkQueryFunction } from "../runtime/claude-agent-sdk-runtime.js";
import { buildClaudeCodeRuntimeControls } from "../kernel/adapters/claude-code.js";
import { openCodeConfigContentForAccessMode } from "../kernel/adapters/opencode.js";
import { HermesRuntime } from "../runtime/hermes-runtime.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";
import { RoomChannelStore } from "../rooms/channel-store.js";
import { migrateNativeApprovalPresetsV2 } from "../server/migrations/native-approval-presets-v2.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentEvent, AgentTurnRequest } from "../core.js";
import { CodexRuntime } from "../runtime/codex-runtime.js";
import { resolveCodexApprovalPolicy, resolveCodexSandboxMode } from "../runtime/codex/policy.js";
import { normalizeMember as normalizeEmployee } from "../server/routes/rooms/normalizers.js";
import { mountedAppDefaultEmployees } from "../server/bridge-mounted-app-employees.js";
import { normalizeReleaseEmployee } from "../server/app-release.js";

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
    [false, false, undefined, false, true],
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
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
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

test("Claude auto review checks fresh native support before submitting any user input", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-permissions-"));
  for (const scenario of ["supported", "unsupported-model", "org-denied", "wrong-effective-mode"] as const) {
    let submitted = false;
    let preflight = false;
    let closed = false;
    let selectedMode: unknown;
    const query: ClaudeAgentSdkQueryFunction = (params) => {
      selectedMode = params.options?.permissionMode;
      async function* messages() {
        assert.equal(typeof params.prompt, "object");
        if (typeof params.prompt !== "string")
          for await (const _input of params.prompt) {
            assert.equal(preflight, true, "user input must wait for the native approval-mode acknowledgement");
            submitted = true;
          }
        yield {
          type: "system",
          subtype: "init",
          session_id: "session",
          model: "claude-test",
          permissionMode: scenario === "wrong-effective-mode" ? "default" : "auto",
          claude_code_version: "test",
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          skills: [],
        };
        yield { type: "result", subtype: "success", result: "done", session_id: "session", usage: {}, modelUsage: {} };
      }
      return Object.assign(messages(), {
        supportedModels: async () => [
          {
            value: "claude-test",
            displayName: "Claude",
            description: "test",
            supportsAutoMode: scenario !== "unsupported-model",
          },
        ],
        setPermissionMode: async (mode: string) => {
          assert.equal(mode, "auto");
          if (scenario === "org-denied") throw new Error("auto mode disabled by organization");
          preflight = true;
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
    assert.equal(submitted, scenario === "supported" || scenario === "wrong-effective-mode");
    assert.equal(
      events.some((event) => event.type === "error"),
      scenario !== "supported",
    );
    const controls = buildClaudeCodeRuntimeControls(join(cwd, scenario), undefined);
    assert.deepEqual(controls.autoReviewModelIds, scenario === "unsupported-model" ? [] : ["claude-test"]);
  }
});

for (const scenario of ["supported", "unsupported", "unverified", "missing"] as const) {
  test(`Claude native default auto review: ${scenario}`, async () => {
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
    assert.equal(submitted, scenario === "supported");
    assert.equal(acknowledged, scenario === "supported");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, scenario === "supported" ? 0 : 1);
    if (scenario !== "supported") assert.match(errors[0]!.message, /runtime_access_mode_unavailable/);
    assert.deepEqual(
      buildClaudeCodeRuntimeControls(cwd, undefined).autoReviewModelIds,
      scenario === "supported"
        ? ["default", "claude-default-concrete", "claude-code-default", "claude-other"]
        : ["claude-other"],
    );
  });
}

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
    env: { HERMES_HOME: sourceHome, HERMES_YOLO_MODE: "1" },
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
});

test("upgrading all local employee permission choices establishes full access once", () => {
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
    migrateNativeApprovalPresetsV2(rooms, () => {
      backups += 1;
    }),
    true,
  );
  assert.equal(backups, 1);
  for (const member of rooms.listMembers()) {
    assert.equal(member.accessMode, "full-access");
    assert.deepEqual(member.userOverrides, ["accessMode"]);
  }
  assert.equal(migrateNativeApprovalPresetsV2(rooms), false);
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
  migrateNativeApprovalPresetsV2(rooms);
  assert.equal(rooms.listMembers().find((member) => member.id === "gateway")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.userOverrides, undefined);
});

for (const previousVersion of [0, 1]) {
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
    legacy.store.saveFrom(legacy.app);
    legacy.settings.nativeApprovalPresetsVersion = previousVersion;
    saveBridgeSettings(legacy);
    await legacy.store.close?.();
    const migrated = createBridgeState({ statePath });
    assert.equal(
      migrated.app.rooms.listMembers().find((member) => member.id === "legacy-auto-review")?.accessMode,
      "full-access",
    );
    assert.equal(migrated.settings.nativeApprovalPresetsVersion, 2);
    assert.equal(existsSync(`${statePath}.before-native-approval-presets-v2.json`), true);
    migrated.app.rooms.patchMember("legacy-auto-review", { accessMode: "auto-review" });
    migrated.app.rooms.patchMember("pm", { accessMode: "default" });
    migrated.store.saveFrom(migrated.app);
    await migrated.store.close?.();
    const restarted = createBridgeState({ statePath });
    try {
      assert.equal(
        restarted.app.rooms.listMembers().find((member) => member.id === "legacy-auto-review")?.accessMode,
        "auto-review",
      );
      assert.equal(restarted.app.rooms.listMembers().find((member) => member.id === "pm")?.accessMode, "default");
    } finally {
      await restarted.store.close?.();
    }
  });
}

test("employee creation repairs unsupported presets and defaults new employees to full access", () => {
  for (const kernel of ["pi", "kimi", "opencode"]) {
    assert.equal(normalizeEmployee({ id: "employee", kernel, accessMode: "auto-review" }).accessMode, "default");
    assert.equal(normalizeEmployee({ id: "employee", kernel }).accessMode, "full-access");
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
      ],
      store: {
        employeeDefaults: [
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
    assert.equal(members.find((member) => member.id === "member-app-permission-import-new")?.accessMode, "full-access");
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

test("Claude ask and full access use distinct native options", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-nonauto-permissions-"));
  for (const [accessMode, nativeMode] of [
    ["default", "default"],
    ["full-access", "bypassPermissions"],
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
    assert.equal(skipAllowed, accessMode === "full-access" ? true : undefined);
  }
});
