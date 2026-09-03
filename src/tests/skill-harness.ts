import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import { buildGroveGuideStatus } from "../tools/grove-guide.js";
import type { AgentEvent, AgentRuntime, AgentTurnRequest } from "../core.js";
import { APP_CONFIG_DIR, APP_ENV_PREFIX } from "../identity.js";
import { createRuntimeKernelAdapter } from "../kernel/adapter.js";
import {
  buildCodexDeveloperInstructions,
  buildCodexTurnInput,
  buildCodexTurnInputItems,
} from "../runtime/codex/input.js";
import { createSkillCatalog } from "../skills/catalog.js";
import { createJsonStateStore } from "../storage/json-state-store.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-skill-"));
  const userHome = join(cwd, "user-home");
  const agentSkillDir = join(userHome, ".agents", "skills", "independent-cli");
  mkdirSync(agentSkillDir, { recursive: true });
  writeFileSync(
    join(agentSkillDir, "SKILL.md"),
    [
      "---",
      "name: independent-cli",
      "description: Skill installed independently for multiple Agent hosts.",
      "---",
      "",
      "Use the independently installed command.",
    ].join("\n"),
    "utf8",
  );
  const projectSkillDir = join(cwd, APP_CONFIG_DIR, "skills", "demo-inline");
  mkdirSync(projectSkillDir, { recursive: true });
  writeFileSync(
    join(projectSkillDir, "SKILL.md"),
    [
      "---",
      "title: Demo Inline",
      "description: Demo inline skill for harness verification.",
      "when_to_use: When validating the harness.",
      "allowed-tools:",
      "  - host.ui.requestChoices",
      "arguments:",
      "  - topic",
      "user-invocable: true",
      "---",
      "# Demo Inline",
      "",
      "Demo unique marker: KEEP_OUT_OF_SYSTEM_PROMPT",
      "",
      "Topic argument: ${topic}",
      `Session value: \${${APP_ENV_PREFIX}_SESSION_ID}`,
    ].join("\n"),
    "utf8",
  );
  const aliasedSkillDir = join(cwd, APP_CONFIG_DIR, "skills", "legacy-directory-name");
  mkdirSync(aliasedSkillDir, { recursive: true });
  writeFileSync(
    join(aliasedSkillDir, "SKILL.md"),
    [
      "---",
      "name: canonical-skill-name",
      "description: Canonical frontmatter name wins over the directory name.",
      "---",
      "",
      "Canonical skill body.",
    ].join("\n"),
    "utf8",
  );
  const modelDisabledSkillDir = join(cwd, APP_CONFIG_DIR, "skills", "model-disabled");
  mkdirSync(modelDisabledSkillDir, { recursive: true });
  writeFileSync(
    join(modelDisabledSkillDir, "SKILL.md"),
    [
      "---",
      "name: model-disabled",
      "description: This Skill must never be exposed to a model.",
      "user-invocable: false",
      "disable-model-invocation: true",
      "---",
      "",
      "Marker: MODEL_DISABLED_BODY",
    ].join("\n"),
    "utf8",
  );

  const catalog = createSkillCatalog({ cwd, userHome });
  const manifest = catalog.resolve("demo-inline");
  assert.ok(manifest, "project skill should be discovered");
  assert.equal(manifest?.name, "demo-inline");
  assert.deepEqual(manifest?.allowedTools, ["host.ui.requestChoices"]);
  assert.equal(catalog.resolve("canonical-skill-name")?.name, "canonical-skill-name");
  assert.equal(catalog.resolve("legacy-directory-name")?.name, "canonical-skill-name");
  assert.equal(
    catalog.resolve("independent-cli")?.source,
    "user",
    "Skills installed into ~/.agents/skills should be available for explicit Employee assignment",
  );

  const mountedAppRoots = ["alpha-app", "beta-app"].map((appId) => {
    const appRoot = join(cwd, appId);
    const skillRoot = join(appRoot, "skills", "shared-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), JSON.stringify({ id: appId, title: appId }), "utf8");
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: shared-skill",
        `description: Shared skill owned by ${appId}.`,
        "---",
        "",
        `Owner marker: ${appId}`,
      ].join("\n"),
      "utf8",
    );
    return { id: appId, path: appRoot };
  });
  const mountedCatalog = createSkillCatalog({ cwd, mountedApps: mountedAppRoots });
  assert.equal(mountedCatalog.resolve("shared-skill"), undefined, "cross-App duplicate names must be explicit");
  assert.equal(mountedCatalog.resolve("app:alpha-app/shared-skill")?.packId, "app.alpha-app");
  assert.match(mountedCatalog.load("app:beta-app/shared-skill", undefined, "session_beta").content, /beta-app/);

  const loaded = catalog.load("demo-inline", "packaging", "session_test");
  assert.ok(loaded.content.includes("Base directory for this skill"));
  assert.ok(loaded.content.includes("KEEP_OUT_OF_SYSTEM_PROMPT"));
  assert.ok(loaded.content.includes("packaging"));
  assert.ok(loaded.content.includes("session_test"));

  let capturedHarnessRequest: AgentTurnRequest | undefined;
  const app = createOpenGrove({
    cwd,
    readPage: () => ({
      title: "Harness Page",
      url: "https://example.com/harness",
      selection: "A selected paragraph used for harness validation.",
      locator: "demo-selection",
      visibleText: "A selected paragraph used for harness validation.",
    }),
    runtime: createHarnessRuntime((request) => {
      capturedHarnessRequest = request;
    }),
    sessionId: "skill-harness",
    userId: "local-user",
  });
  assert.ok(app.skills.resolve("grove-guide"), "bundled Grove guide skill should be available");
  assert.ok(app.skills.resolve("opengrove-app-builder"), "bundled App Builder skill should be available");
  assert.ok(app.skills.resolve("opengrove-developer-mode-guard"), "bundled App workspace guard should be available");
  const appBuilderSkill = app.skills.load("opengrove-app-builder", undefined, "skill-harness").content;
  assert.match(
    appBuilderSkill,
    /pack.*publish.*exclude the workspace root/s,
    "App Builder must warn that published packages omit workspace state",
  );
  assert.match(
    appBuilderSkill,
    /extract it into\s+an empty directory.*first launch or the first real command/s,
    "App Builder must require a fresh-package first-run smoke test",
  );
  assert.equal(app.skills.resolve("app-import"), undefined, "App import is merged into App Builder");
  assert.equal(catalog.resolve("opengrove-project-brief"), undefined, "unused bundled project brief skill is removed");
  const groveStatusTool = app.tools.get("opengrove.guide.status");
  assert.ok(groveStatusTool, "Grove guide status tool should be registered");
  const appCreatorImportTool = app.tools.get("opengrove.app.import");
  assert.ok(appCreatorImportTool, "App Creator import tool should be registered");
  const groveStatus = await groveStatusTool.execute({}, undefined as any);
  assert.equal(groveStatus.ok, true);
  // The local runtime status must not fabricate a retired remote pairing command.
  assert.match(JSON.stringify(groveStatus.value), /local-runtime/);
  assert.doesNotMatch(JSON.stringify(groveStatus.value), /maple-724/);
  // Without an explicit Host language preference the guide copy defaults to English.
  assert.match(JSON.stringify(groveStatus.value), /Sidebar -> Resources -> App Store/);
  assert.match(JSON.stringify(groveStatus.value), /Sidebar -> My Apps -> New App/);
  assert.doesNotMatch(JSON.stringify(groveStatus.value), /左侧栏/);
  const localizedGroveStatus = buildGroveGuideStatus({ language: () => "zh-CN" });
  assert.match(JSON.stringify(localizedGroveStatus), /左侧栏 -> 资源 -> App 商店/);
  assert.match(JSON.stringify(localizedGroveStatus), /左侧栏 -> 我的App -> 新建应用/);

  const plainSlashEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("/demo-inline explain")) {
    plainSlashEvents.push(event);
  }
  assert.ok(
    !plainSlashEvents.some((event) => event.type === "skill.invoked"),
    "plain slash input should pass through to the kernel instead of implicitly invoking a skill",
  );
  const plainRequest = plainSlashEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(plainRequest);
  assert.equal(
    plainRequest.request.skills.some((skill) => skill.name === "model-disabled"),
    false,
    "disable-model-invocation Skills must stay out of an unrestricted model turn",
  );
  const disabledRequiredEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("required disabled skill", {
    requiredSkillNames: ["model-disabled"],
  })) {
    disabledRequiredEvents.push(event);
  }
  const disabledRequiredRequest = disabledRequiredEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(
    disabledRequiredRequest,
    "a disabled required Skill should reach the model instead of aborting in the Host",
  );
  assert.match(
    disabledRequiredRequest.request.context?.promptBlock ?? "",
    /Host policy does not allow this Skill to be loaded by the model/,
  );
  assert.ok(
    !disabledRequiredEvents.some((event) => event.type === "model.response"),
    "the Host must not synthesize a user-visible error response for a disabled required Skill",
  );

  const hostContextEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("hello host context", {
    sessionInstructions: "Employee session marker: EMPLOYEE_IDENTITY_STABLE",
    hostContextPromptBlock: "Room host marker: HOST_CONTEXT_VISIBLE",
  })) {
    hostContextEvents.push(event);
  }
  const hostContextRequest = hostContextEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(hostContextRequest, "host context run should emit model.requested");
  assert.equal(hostContextRequest.request.userInput, "hello host context");
  assert.ok(
    hostContextRequest.request.context?.promptBlock.includes("HOST_CONTEXT_VISIBLE"),
    "hostContextPromptBlock should be delivered through assembledContext.promptBlock",
  );
  assert.ok(
    !hostContextRequest.request.userInput.includes("HOST_CONTEXT_VISIBLE"),
    "hostContextPromptBlock must not be mixed into the user input",
  );
  const codexInput = buildCodexTurnInput({
    input: "hello host context",
    assembledContext: hostContextRequest.request.context,
  } as any);
  const codexDeveloperInstructions = buildCodexDeveloperInstructions({
    sessionInstructions: "Employee session marker: EMPLOYEE_IDENTITY_STABLE",
  });
  assert.ok(
    codexInput.includes("HOST_CONTEXT_VISIBLE"),
    "Codex must receive mutable Host context in the current Turn input",
  );
  assert.ok(
    !codexDeveloperInstructions.includes("HOST_CONTEXT_VISIBLE"),
    "mutable Host context must not become a Codex thread-start instruction",
  );
  assert.ok(
    codexDeveloperInstructions.includes("EMPLOYEE_IDENTITY_STABLE"),
    "stable Employee instructions must be delivered through Codex thread-start instructions",
  );
  assert.ok(
    !codexInput.includes("EMPLOYEE_IDENTITY_STABLE"),
    "stable Employee instructions must not be repeated in the Codex Turn input",
  );
  assert.match(
    codexDeveloperInstructions,
    /native `request_user_input` tool/,
    "Codex should use its native blocking question interaction instead of a second host form protocol",
  );
  assert.doesNotMatch(
    codexDeveloperInstructions,
    /host submit button sends the user's choice as the next user turn/,
    "Codex questions must resume the same pending turn",
  );
  const optionalSkillCodexTurn = buildCodexTurnInput({
    input: "use an optional skill when needed",
    skills: [manifest],
  } as any);
  assert.match(optionalSkillCodexTurn, /Employee optional skill scope/);
  assert.ok(optionalSkillCodexTurn.includes(manifest.entry));

  const missingRequiredEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("missing required skill", {
    requiredSkillNames: ["missing-required-skill"],
  })) {
    missingRequiredEvents.push(event);
  }
  const missingRequiredRequest = missingRequiredEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(missingRequiredRequest, "a missing required Skill should still reach the model");
  assert.match(
    missingRequiredRequest.request.context?.promptBlock ?? "",
    /required_skill_not_found:missing-required-skill/,
    "the model should receive the real Host preflight failure",
  );
  assert.ok(
    !missingRequiredEvents.some((event) => event.type === "model.response"),
    "the Host must not synthesize a user-visible missing-Skill response",
  );

  const requiredSkillEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("hello required skill", {
    requiredSkillNames: ["demo-inline"],
    hostContextPromptBlock: "Room host marker: REQUIRED_SKILL_ROOM_CONTEXT",
  })) {
    requiredSkillEvents.push(event);
  }
  const requiredSkillRequest = requiredSkillEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(requiredSkillRequest, "required skill run should emit model.requested");
  assert.ok(
    requiredSkillRequest.request.context?.promptBlock.includes("OpenGrove required employee skills"),
    "required skills should be marked as host-mandated context",
  );
  assert.ok(
    requiredSkillRequest.request.context?.promptBlock.includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "required skill body should be loaded into the host context",
  );
  assert.ok(
    requiredSkillRequest.request.context?.promptBlock.includes("REQUIRED_SKILL_ROOM_CONTEXT"),
    "required skill injection should preserve the normal room host context",
  );
  assert.ok(
    !requiredSkillRequest.request.userInput.includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "required skill body must not be mixed into the user message",
  );
  const requiredSkillCodexTurn = buildCodexTurnInput({
    input: requiredSkillRequest.request.userInput,
    assembledContext: requiredSkillRequest.request.context,
  } as any);
  assert.ok(
    requiredSkillCodexTurn.includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "Codex should receive required Skill content in the current Turn",
  );
  assert.ok(
    app.knowledge
      .listDeliveries()
      .some(
        (delivery) =>
          delivery.knowledgeId === `skill.${manifest.id.replace(/^skill\./, "")}` &&
          delivery.mode === "prompt_snippet" &&
          delivery.includeInPrompt,
      ),
    "required skill delivery should be recorded as prompt context",
  );

  capturedHarnessRequest = undefined;
  const appBuilderBusinessEvents: AgentEvent[] = [];
  for await (const event of app.runTurn("新增一个当前没有真实字段的数据卡片", {
    requiredSkillNames: ["opengrove-app-builder"],
  })) {
    appBuilderBusinessEvents.push(event);
  }
  const appBuilderBusinessRequest = appBuilderBusinessEvents.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(appBuilderBusinessRequest, "App Builder business request should reach the kernel");
  const appBuilderBusinessTurn = capturedHarnessRequest as AgentTurnRequest | undefined;
  assert.ok(appBuilderBusinessTurn, "the harness must capture the App Builder Agent turn");
  const appBuilderBusinessInstructions = buildCodexTurnInput(appBuilderBusinessTurn);
  assert.match(
    appBuilderBusinessInstructions,
    /complete now.*can build ahead of backend\s+support.*needs backend support/is,
    "the kernel must receive the three-way App capability classification",
  );
  assert.match(
    appBuilderBusinessInstructions,
    /continue with every\s+part.*does not depend on the missing data/is,
    "the kernel must receive the partial-delivery requirement",
  );
  assert.match(
    appBuilderBusinessInstructions,
    /Never use invented data.*connected to real\s+data/is,
    "the kernel must receive the honest-data requirement",
  );
  assert.match(
    appBuilderBusinessInstructions,
    /backend handoff.*business purpose.*expected\s+data.*current delivery status/is,
    "the kernel must receive the transferable backend-handoff contract",
  );

  const events: AgentEvent[] = [];
  for await (const event of app.runTurn("explain", {
    requestedSkillName: "demo-inline",
    requestedSkillArgs: "explain",
  })) {
    events.push(event);
  }

  assert.ok(
    events.some((event) => event.type === "skill.invoked"),
    "selected skill should emit skill.invoked",
  );
  assert.ok(
    events.some((event) => event.type === "skill.loaded"),
    "selected skill should emit skill.loaded",
  );

  const request = events.find(
    (event): event is Extract<AgentEvent, { type: "model.requested" }> => event.type === "model.requested",
  );
  assert.ok(request, "model.requested should be emitted");
  assert.ok(
    !request.request.systemPrompt.includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "skill body must not be embedded into the system prompt",
  );
  assert.ok(
    !request.request.context?.promptBlock.includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "skill body should not be expanded into the assembled context for every turn",
  );
  assert.ok(
    app.knowledge
      .listDeliveries()
      .some(
        (delivery) =>
          delivery.knowledgeId === `skill.${manifest.id.replace(/^skill\./, "")}` &&
          delivery.mode === "loaded_skill" &&
          !delivery.includeInPrompt,
      ),
    "selected skill should be recorded as loaded through the skill channel, not duplicated in prompt context",
  );

  const workingState = app.workingState.get();
  assert.equal(workingState.activeSkillId, undefined);
  assert.ok(workingState.invokedSkills.some((item) => item.skillName === "demo-inline"));

  let nativeClaudeRequest: AgentTurnRequest | undefined;
  const nativeClaudeApp = createOpenGrove({
    cwd,
    workspaceRoot: cwd,
    readPage: () => ({
      title: "Harness Page",
      url: "https://example.com/harness",
      selection: "",
      locator: "demo-selection",
    }),
    kernel: createRuntimeKernelAdapter({
      id: "claude-code",
      title: "Claude",
      runtime: createHarnessRuntime((request) => {
        nativeClaudeRequest = request;
      }),
      capabilities: {
        knowledge: {
          nativeSkills: true,
          toolMediatedSkills: false,
          progressiveDisclosure: true,
          nativeArtifacts: false,
          deliveryLedger: true,
        },
      },
    }),
    sessionId: "skill-native-claude-harness",
    userId: "local-user",
  });
  for await (const _event of nativeClaudeApp.runTurn("native task", {
    requestedSkillName: "demo-inline",
    requestedSkillArgs: "native task",
  })) {
    // Consume the public event stream so the runtime receives the request.
  }
  assert.ok(nativeClaudeRequest, "native Claude skill turn should reach the runtime");
  assert.equal(
    nativeClaudeRequest.input,
    "/demo-inline native task",
    "Claude explicit skill invocation should use the native slash-command form in one turn",
  );

  nativeClaudeRequest = undefined;
  for await (const _event of nativeClaudeApp.runTurn("native required task", {
    requiredSkillNames: ["demo-inline"],
  })) {
    // Consume the public event stream so the runtime receives the request.
  }
  const nativeRequiredRequest = nativeClaudeRequest as AgentTurnRequest | undefined;
  assert.ok(nativeRequiredRequest, "native required Skill turn should reach the runtime");
  assert.equal(nativeRequiredRequest.input, "native required task");
  assert.deepEqual(nativeRequiredRequest.requiredSkills, []);
  assert.equal(nativeRequiredRequest.requiredSkillRequirements?.length, 1);
  assert.equal(nativeRequiredRequest.requiredSkillRequirements?.[0]?.hostLoadStatus, "available");
  assert.equal(nativeRequiredRequest.requiredSkillRequirements?.[0]?.modelLoadAllowed, true);
  assert.match(nativeRequiredRequest.assembledContext?.promptBlock ?? "", /Load this Skill before acting/);
  assert.ok(
    !(nativeRequiredRequest.assembledContext?.promptBlock ?? "").includes("KEEP_OUT_OF_SYSTEM_PROMPT"),
    "native required Skill bodies must not be injected into Host context",
  );
  const nativeDefaultOnlyRequest: AgentTurnRequest = {
    ...nativeRequiredRequest,
    skills: [nativeRequiredRequest.requiredSkillRequirements![0]!.manifest!],
  };
  const nativeRequiredCodexTurn = buildCodexTurnInput(nativeDefaultOnlyRequest);
  assert.match(nativeRequiredCodexTurn, /Load this Skill before acting/);
  assert.doesNotMatch(nativeRequiredCodexTurn, /Employee optional skill scope/);
  assert.deepEqual(
    buildCodexTurnInputItems(nativeDefaultOnlyRequest, buildCodexTurnInput(nativeDefaultOnlyRequest)).map(
      (item) => item.type,
    ),
    ["text"],
    "a default Skill requirement must not masquerade as an explicit user Skill invocation",
  );

  const statePath = join(cwd, "state.json");
  const store = createJsonStateStore(statePath);
  store.saveFrom(app);

  const restored = createOpenGrove({
    cwd,
    readPage: () => ({
      title: "Harness Page",
      url: "https://example.com/harness",
      selection: "",
      locator: "demo-selection",
    }),
    runtime: createHarnessRuntime(),
    sessionId: "skill-harness",
    userId: "local-user",
  });
  store.loadInto(restored);
  assert.ok(
    restored.workingState.get().invokedSkills.some((item) => item.skillName === "demo-inline"),
    "invoked skill state should survive persistence and restore",
  );

  console.log(JSON.stringify({ ok: true, eventTypes: events.map((event) => event.type) }, null, 2));
}

function createHarnessRuntime(onRequest?: (request: AgentTurnRequest) => void): AgentRuntime {
  return {
    async *runTurn(request) {
      onRequest?.(request);
      const runId = request.runId ?? "skill-harness-run";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      if (request.assembledContext) {
        yield { type: "context.assembled", runId, context: request.assembledContext };
      }
      yield {
        type: "model.requested",
        runId,
        request: {
          systemPrompt: "",
          userInput: request.input,
          context: request.assembledContext,
          tools: request.tools.map((tool) => tool.spec),
          skills: request.skills ?? [],
          packs: request.packs ?? [],
          capabilities: request.capabilities ?? [],
        },
      };
      yield { type: "assistant.delta", runId, text: "ok" };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    },
  };
}

await main();
