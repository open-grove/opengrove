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
import { migrateNativeApprovalPresetsV3 } from "../server/migrations/native-approval-presets-v3.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { writeClaudeModelsCache } from "../runtime/claude-models-cache.js";
import { normalizeReleaseEmployee } from "../server/app-release.js";
import { handleRoomMemberRoutes } from "../server/routes/rooms/member-routes.js";

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
    let submitted = false;
    let acknowledged = false;
    let closed = false;
    let selectedMode: unknown;
    const query: ClaudeAgentSdkQueryFunction = (params) => {
      selectedMode = params.options?.permissionMode;
      async function* messages() {
        assert.equal(typeof params.prompt, "object");
        if (typeof params.prompt !== "string")
          for await (const _input of params.prompt) {
            assert.equal(acknowledged, true, "user input must wait for the native approval-mode acknowledgement");
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
        supportedModels: async () => {
          throw new Error("model catalog unavailable");
        },
        setPermissionMode: async (mode: string) => {
          assert.equal(mode, "auto");
          if (scenario === "org-denied") throw new Error("auto mode disabled by organization");
          if (scenario === "unsupported-model") throw new Error("auto mode unavailable for this model");
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
    assert.equal(submitted, scenario === "supported" || scenario === "wrong-effective-mode");
    assert.equal(
      events.some((event) => event.type === "error"),
      scenario !== "supported",
    );
  }
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

test("Opus 5 and Opus 4.8 advertise auto review and default to it without cached support", () => {
  const configHome = mkdtempSync(join(tmpdir(), "opengrove-known-claude-permissions-"));
  try {
    for (const support of [undefined, false, true]) {
      if (support !== undefined) {
        writeClaudeModelsCache(
          ["claude-opus-5", "claude-opus-4-8"].map((value) => ({ value, supportsAutoMode: support })),
          { configHome, now: "2026-09-15T00:00:00Z" },
        );
      }
      const controls = buildClaudeCodeRuntimeControls(configHome, undefined);
      assert.deepEqual(controls.autoReviewModelIds, ["claude-opus-5", "claude-opus-4-8"]);
      for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
        assert.equal(normalizeEmployeeAccessMode("claude-code", undefined, model, configHome), "auto-review");
        assert.equal(normalizeEmployeeAccessMode("claude-code", "default", model, configHome), "default");
      }
      assert.equal(controls.autoReviewModelIds.includes("claude-code-default"), false);
      assert.equal(normalizeEmployeeAccessMode("claude-code", undefined, "claude-custom", configHome), "default");
    }
  } finally {
    rmSync(configHome, { recursive: true, force: true });
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

test("upgrading preserves compatible employee choices and repairs unsupported modes", () => {
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
    migrateNativeApprovalPresetsV3(rooms, () => {
      backups += 1;
    }),
    true,
  );
  assert.equal(backups, 1);
  for (const member of rooms.listMembers()) {
    const original = member.id.slice(member.kernel.length + 1);
    const unsupportedAuto = original === "auto-review" && ["pi", "kimi", "opencode"].includes(member.kernel);
    const expected =
      original === "unset"
        ? ["codex", "hermes"].includes(member.kernel)
          ? "auto-review"
          : "default"
        : unsupportedAuto
          ? "default"
          : original;
    assert.equal(member.accessMode, expected, member.id);
    assert.deepEqual(member.userOverrides, unsupportedAuto ? ["accessMode"] : undefined);
  }
  assert.equal(migrateNativeApprovalPresetsV3(rooms), false);
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
  migrateNativeApprovalPresetsV3(rooms);
  assert.equal(rooms.listMembers().find((member) => member.id === "gateway")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.accessMode, "default");
  assert.equal(rooms.listMembers().find((member) => member.id === "remote")?.userOverrides, undefined);
});

for (const previousVersion of [0, 1, 2]) {
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
    legacy.app.rooms.patchMember("pm", { accessMode: "default", userOverrides: undefined });
    legacy.store.saveFrom(legacy.app);
    legacy.settings.nativeApprovalPresetsVersion = previousVersion;
    saveBridgeSettings(legacy);
    await legacy.store.close?.();
    const migrated = createBridgeState({ statePath });
    assert.equal(
      migrated.app.rooms.listMembers().find((member) => member.id === "legacy-auto-review")?.accessMode,
      "auto-review",
    );
    assert.equal(migrated.app.rooms.listMembers().find((m) => m.id === "pm")?.accessMode, "full-access");
    assert.equal(migrated.app.rooms.listMembers().find((m) => m.id === "unsupported-auto")?.accessMode, "default");
    assert.equal(migrated.settings.nativeApprovalPresetsVersion, 3);
    assert.equal(existsSync(`${statePath}.before-native-approval-presets-v3.json`), true);
    migrated.app.rooms.patchMember("legacy-auto-review", { accessMode: "auto-review" });
    migrated.app.rooms.patchMember("pm", { accessMode: "default", userOverrides: ["accessMode"] });
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

for (const initialSupport of [false, true]) {
  test(`saved Employee permissions survive Claude cache refresh and loss (initial support: ${initialSupport})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-permission-cache-drift-"));
    const configHome = join(cwd, "claude");
    const statePath = join(cwd, "state.sqlite");
    const appRoot = join(cwd, "app");
    const writeSupport = (supportsAutoMode: boolean) =>
      writeClaudeModelsCache(
        ["deepseek-v4-flash", "claude-custom"].map((value) => ({ value, supportsAutoMode })),
        { configHome, now: "2026-09-15T00:00:00Z" },
      );
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
      state.settings.nativeApprovalPresetsVersion = 0;
      state.app.rooms.patchMember("grove-guide", { accessMode: undefined });
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
          assert.equal(member.accessMode, expected, member.id);
          assert.equal(
            member.userOverrides?.includes("accessMode") ?? false,
            false,
            "a saved default remains distinct from a user override",
          );
        }
        assert.equal(members.find((member) => member.id === "member-app-cache-drift-declared")?.accessMode, declared);
        assert.equal(members.find((member) => member.id === "pm")?.accessMode, "full-access");
      };
      assertSavedPermissions();
      for (const support of [!initialSupport, initialSupport, undefined]) {
        if (support === undefined) rmSync(join(configHome, "opengrove-models-cache.json"));
        else writeSupport(support);
        await restart();
        assert.equal(
          buildClaudeCodeRuntimeControls(configHome, undefined).autoReviewModelIds?.includes("claude-custom"),
          support === true,
        );
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
        initialSupport ? "default" : "auto-review",
        "new Employees still use the current capability result",
      );
    } finally {
      await state.store.close?.();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const configuredSupport of [true, false]) {
  test(`Claude employee lifecycle uses the configured cache (${configuredSupport}) instead of the ambient cache`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opengrove-configured-claude-permissions-"));
    const configuredHome = join(cwd, "configured-claude");
    const ambientHome = join(cwd, "ambient-claude");
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    const models = (supported: boolean) => [
      { value: "default", supportsAutoMode: supported },
      { value: "deepseek-v4-flash", supportsAutoMode: supported },
      { value: "claude-custom", supportsAutoMode: supported },
    ];
    writeClaudeModelsCache(models(configuredSupport), { configHome: configuredHome, now: "2026-09-15T00:00:00Z" });
    writeClaudeModelsCache(models(!configuredSupport), { configHome: ambientHome, now: "2026-09-15T00:00:00Z" });
    process.env.CLAUDE_CONFIG_DIR = ambientHome;
    const statePath = join(cwd, "state.sqlite");
    let state = createBridgeState({ statePath });
    try {
      state.settings.kernelPathOverrides["claude-code"] = { configHome: configuredHome };
      state.settings.nativeApprovalPresetsVersion = 0;
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
      const controls = buildClaudeCodeRuntimeControls(configuredHome, undefined);
      assert.equal(controls.autoReviewModelIds?.includes("claude-code-default"), configuredSupport);
      for (const id of ["grove-guide", "app-builder", "configuration-migration"]) {
        assert.equal(
          state.app.rooms.listMembers().find((member) => member.id === id)?.accessMode,
          id === "app-builder" || configuredSupport ? "auto-review" : "default",
          id,
        );
      }
      assert.equal(state.app.rooms.listMembers().find((member) => member.id === "pm")?.accessMode, "full-access");
      const expected = configuredSupport ? "auto-review" : "default";
      const mutateMember = async (path: string, method: string, body: Record<string, unknown>) => {
        const socket = new Socket();
        const request = new IncomingMessage(socket);
        request.method = method;
        const response = new ServerResponse(request);
        let responseStatus: number | undefined;
        try {
          assert.equal(
            await handleRoomMemberRoutes({
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
          assert.equal(responseStatus, 200);
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
      state.app.rooms.patchMember("new-claude", { kernel: "codex", accessMode: undefined });
      await mutateMember("/rooms/members/new-claude", "PATCH", { kernel: "claude-code" });
      assert.equal(memberById("new-claude").accessMode, expected, "kernel switch route");
      await mutateMember("/rooms/members/new-claude", "PATCH", { accessMode: "full-access" });
      assert.equal(memberById("new-claude").accessMode, "full-access", "explicit permission survives");

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

test("Unlisted Claude models use cached support or resolve to a declared model", () => {
  const configHome = mkdtempSync(join(tmpdir(), "opengrove-claude-default-permissions-"));
  assert.equal(normalizeEmployeeAccessMode("claude-code", undefined, "claude-code-default", configHome), "default");
  writeClaudeModelsCache(
    [
      { value: "default", supportsAutoMode: true },
      { value: "supported", resolvedModel: "resolved-supported", supportsAutoMode: true },
      { value: "known-alias", resolvedModel: "claude-opus-5", supportsAutoMode: false },
      { value: "unsupported", supportsAutoMode: false },
    ],
    { configHome, now: "2026-09-15T00:00:00Z" },
  );
  for (const model of ["claude-code-default", "supported", "resolved-supported", "known-alias"])
    assert.equal(normalizeEmployeeAccessMode("claude-code", undefined, model, configHome), "auto-review");
  for (const model of ["unsupported", "deepseek-test"])
    assert.equal(normalizeEmployeeAccessMode("claude-code", undefined, model, configHome), "default");
  assert.equal(normalizeEmployeeAccessMode("claude-code", "full-access", "supported", configHome), "full-access");
  assert.equal(normalizeEmployeeAccessMode("claude-code", "default", "supported", configHome), "default");
});
