import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "../core.js";
import { GROVE_GUIDE_SKILL_NAME } from "../rooms/channel-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { PM_AGENT_SKILL_NAME } from "../server/bridge-mounted-app-employees.js";
import { scheduleRoomAssistantRuns } from "../server/room-runs.js";
import {
  clearActiveRoomRunExecutionState,
  registerActiveRoomRunExecutionState,
} from "../server/room-runs/scheduler.js";
import { buildRoomRunEnvelope } from "../server/room-runs/envelope.js";
import {
  resolveRoomExecutionTarget,
  roomExecutionState,
  roomProviderRouteErrorMessage,
} from "../server/room-runs/execution-state.js";
import { resolveVisibleRoomTargets } from "../server/routes/rooms/normalizers.js";
import { clearRemovedProviderSettingsReferences } from "../server/routes/settings.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-room-run-envelope-"));
const stores: Array<ReturnType<typeof createBridgeState>["store"]> = [];

try {
  const state = createBridgeState({ statePath: join(dir, "state.json") });
  stores.push(state.store);
  state.settings.languagePreference = "en";
  const originalSkillResolve = state.app.skills.resolve.bind(state.app.skills);
  const storyWriterSkillTemplate = originalSkillResolve(GROVE_GUIDE_SKILL_NAME, { includeDisabled: true });
  assert.ok(storyWriterSkillTemplate);
  let storyWriterSkillMetadata = {
    description: "把故事种子整理成可执行的大纲。",
    whenToUse: "需要设计故事或章节结构时使用。",
    disableModelInvocation: false,
  };
  state.app.skills.resolve = (name, options = {}) => {
    if (name !== "story-writer") return originalSkillResolve(name, options);
    return {
      ...storyWriterSkillTemplate,
      id: "skill-story-writer",
      name: "story-writer",
      ...storyWriterSkillMetadata,
    };
  };
  const writer = state.app.rooms.upsertMember({
    id: "employee-writer",
    name: "故事架构师",
    displayName: "Story Architect",
    kernel: state.kernel,
    model: state.model,
    role: [
      "INTERNAL_WRITER_ROLE_MUST_NOT_REACH_ROUTER",
      "App instructions:",
      "Workspace scope: /private/story-writer",
    ].join("\n"),
    publicDescription: "负责把故事种子整理为故事设计和章节大纲。",
    displayPublicDescription: "Develops story concepts and chapter outlines.",
    status: "idle",
    color: "#168a53",
    lastActive: "now",
    source: "local",
    defaultSkillIds: ["story-writer"],
  });
  const editor = state.app.rooms.upsertMember({
    id: "employee-editor",
    name: "金牌编辑",
    displayName: "Lead Editor",
    kernel: state.kernel,
    model: state.model,
    role: "INTERNAL_EDITOR_ROLE_MUST_NOT_REACH_ROUTER\nApp workspace: /private/story-editor",
    publicDescription: "负责独立审核故事设计和章节大纲。",
    displayPublicDescription: "Independently reviews story concepts and chapter outlines.",
    status: "idle",
    color: "#c2410c",
    lastActive: "now",
    source: "local",
  });
  const pm = state.app.rooms.upsertMember({
    id: "employee-pm",
    employeeDefinitionId: "pm",
    name: "故事种子 PM",
    displayName: "Story Seed PM",
    kernel: state.kernel,
    model: state.model,
    role: "负责把未明确 @ 的用户消息路由给合适员工。",
    status: "idle",
    color: "#2563eb",
    lastActive: "now",
    source: "local",
    defaultSkillIds: [PM_AGENT_SKILL_NAME],
  });
  const roomId = "room-envelope-story-seed";
  state.app.rooms.ensureGroupRoom({
    id: roomId,
    title: "Story Seed",
    badge: "App",
    memberIds: [writer.id, editor.id, pm.id],
  });
  const ledgerSpec = state.app.tools.require("room.ledger.read").spec;
  assert.equal(ledgerSpec.title, "读取房间账本");
  assert.match(ledgerSpec.description, /当前获授权房间的可见消息/);

  const directPost = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 请继续完善章节大纲。",
    targetIds: [writer.id],
    assistantTargets: [writer],
    deliveryKind: "user_direct",
    selectedFile: { path: "项目/长安客/章节大纲.md" },
  });
  const direct = directPost.userMessage;
  const directEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: writer,
    hostTools: true,
  });
  const providerOverrideEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: { ...writer, providerId: "deepseek" },
    hostTools: true,
  });
  assert.notEqual(
    providerOverrideEnvelope.sessionId,
    directEnvelope.sessionId,
    "Changing the resolved Provider must create a different native thread boundary",
  );
  assert.throws(
    () => roomExecutionState(state, { ...writer, providerId: "deepseek" }),
    /room_member_provider_unavailable:deepseek:disabled/,
    "An inactive Employee Provider must fail explicitly instead of falling back to native credentials",
  );
  const originalRoutingSettings = {
    modelProviderBindings: [...state.settings.modelProviderBindings],
    customProviders: [...state.settings.customProviders],
  };
  let missingRouteError: unknown;
  try {
    roomExecutionState(state, {
      ...writer,
      model: "model-without-a-user-provider-selection",
      providerId: undefined,
    });
  } catch (error) {
    missingRouteError = error;
  }
  assert.match(
    missingRouteError instanceof Error ? missingRouteError.message : "",
    /room_member_provider_selection_required:/,
    "a missing user Provider selection must fail before any native Kernel credentials are used",
  );
  assert.equal(
    roomProviderRouteErrorMessage(missingRouteError, "zh-CN"),
    "模型 model-without-a-user-provider-selection 还没有选择 Provider。请为这位员工选择 Provider，或在设置中配置该模型的默认 Provider。",
    "Room UI errors must translate the stable route code instead of exposing an internal token",
  );
  state.settings.languagePreference = "zh-CN";
  // The built-in DeepSeek preset is inactive here. Later this harness
  // adds a ready custom Provider with the same id for the Hermes recovery case.
  const unavailableProviderTarget = { ...writer, providerId: "deepseek" };
  const unavailableProviderPost = state.app.rooms.postUserMessage({
    roomId,
    text: "请用未配置凭据的 Provider 执行。",
    targetIds: [writer.id],
    assistantTargets: [unavailableProviderTarget],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: unavailableProviderPost.userMessage.id,
    targets: [unavailableProviderTarget],
    assistantMessages: unavailableProviderPost.assistantMessages,
  });
  const unavailableProviderMessageId = unavailableProviderPost.assistantMessages[0]!.id;
  await waitFor(
    () => state.app.rooms.getMessage(roomId, unavailableProviderMessageId)?.status === "failed",
    "unavailable Provider Room Run failure",
  );
  const unavailableProviderMessage = state.app.rooms.getMessage(roomId, unavailableProviderMessageId);
  assert.equal(unavailableProviderMessage?.text, "这次运行失败了，请查看运行详情。");
  assert.match(
    JSON.stringify(unavailableProviderMessage?.parts),
    /所选 Provider deepseek 当前不可用（已停用）/,
    "an unavailable Employee Provider must become a localized failed Room reply",
  );

  state.settings.languagePreference = "en";

  state.settings.customProviders.push({
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://api.deepseek.example/v1",
    apiKey: "test-deepseek-key",
    enabled: true,
    credentialKind: "api-key",
    modelsPinned: false,
    models: [{ id: writer.model, label: writer.model }],
  });
  const previousHermesBin = process.env.OPENGROVE_HERMES_BIN;
  try {
    state.settings.languagePreference = "zh-CN";
    process.env.OPENGROVE_HERMES_BIN = join(dir, "temporarily-missing-hermes");
    const unavailableHermesState = roomExecutionState(state, {
      ...writer,
      kernel: "hermes",
      providerId: "deepseek",
    });
    assert.equal(
      unavailableHermesState.kernelUnavailableReason,
      "Hermes 当前不可用。未找到可用的 Hermes 可执行程序或运行环境。",
    );
    const unavailableHermesTarget = { ...writer, kernel: "hermes", providerId: "deepseek" };
    const unavailableHermesPost = state.app.rooms.postUserMessage({
      roomId,
      text: "请使用未安装的 Hermes 执行。",
      targetIds: [writer.id],
      assistantTargets: [unavailableHermesTarget],
      deliveryKind: "user_direct",
    });
    scheduleRoomAssistantRuns(state, {
      roomId,
      triggerMessageId: unavailableHermesPost.userMessage.id,
      targets: [unavailableHermesTarget],
      assistantMessages: unavailableHermesPost.assistantMessages,
    });
    const unavailableHermesMessageId = unavailableHermesPost.assistantMessages[0]!.id;
    await waitFor(
      () => state.app.rooms.getMessage(roomId, unavailableHermesMessageId)?.status === "failed",
      "unavailable Kernel runtime Room Run failure",
    );
    const unavailableHermesMessage = state.app.rooms.getMessage(roomId, unavailableHermesMessageId);
    assert.equal(unavailableHermesMessage?.text, "这次运行失败了，请查看运行详情。");
    assert.match(
      JSON.stringify(unavailableHermesMessage?.parts),
      /Hermes 当前不可用。未找到可用的 Hermes 可执行程序或运行环境/,
      "an unavailable Kernel runtime must become a localized failed Room reply",
    );

    process.env.OPENGROVE_HERMES_BIN = process.execPath;
    const recoveredHermesState = roomExecutionState(state, {
      ...writer,
      kernel: "hermes",
      providerId: "deepseek",
    });
    assert.notEqual(
      recoveredHermesState.kernelAdapter,
      unavailableHermesState.kernelAdapter,
      "an unavailable adapter must not poison the Room worker pool after its Engine becomes available",
    );
    assert.equal(recoveredHermesState.kernelUnavailableReason, undefined);
    state.kernelUnavailableCode = "root_kernel_unavailable";
    state.kernelUnavailableReason = "the root Kernel is unavailable";
    const cachedRecoveredHermesState = roomExecutionState(state, {
      ...writer,
      kernel: "hermes",
      providerId: "deepseek",
    });
    assert.equal(cachedRecoveredHermesState.kernelAdapter, recoveredHermesState.kernelAdapter);
    assert.equal(
      cachedRecoveredHermesState.kernelUnavailableReason,
      undefined,
      "a healthy scoped worker must not inherit unrelated root Kernel diagnostics",
    );
    state.kernelUnavailableCode = undefined;
    state.kernelUnavailableReason = undefined;
  } finally {
    state.settings.languagePreference = "en";
    if (previousHermesBin === undefined) delete process.env.OPENGROVE_HERMES_BIN;
    else process.env.OPENGROVE_HERMES_BIN = previousHermesBin;
  }
  state.settings.kernelPathOverrides[writer.kernel] = { binaryPath: process.execPath };
  const firstDeepSeekState = roomExecutionState(state, { ...writer, providerId: "deepseek" });
  state.settings.languagePreference = "zh-CN";
  const lateMember = state.app.rooms.upsertMember({
    ...editor,
    id: "employee-added-after-worker",
    name: "后加入员工",
  });
  state.store.saveFrom(state.app);
  const secondDeepSeekState = roomExecutionState(state, { ...writer, providerId: "deepseek" });
  assert.notEqual(firstDeepSeekState, state);
  assert.notEqual(
    firstDeepSeekState,
    secondDeepSeekState,
    "Each Run needs a fresh application view instead of a stale pooled BridgeState",
  );
  assert.equal(
    firstDeepSeekState.kernelAdapter,
    secondDeepSeekState.kernelAdapter,
    "The same Provider credential realm should still reuse one Kernel worker",
  );
  assert.equal(secondDeepSeekState.settings.languagePreference, "zh-CN");
  assert.ok(secondDeepSeekState.app.rooms.listMembers().some((member) => member.id === lateMember.id));
  assert.equal(firstDeepSeekState.kernelProviderId, "deepseek");
  assert.deepEqual(firstDeepSeekState.runtimeOverride, {
    kernel: writer.kernel,
    model: writer.model,
    providerOverride: { providerId: "deepseek" },
  });
  assert.deepEqual(
    firstDeepSeekState.settings.modelProviderBindings,
    state.settings.modelProviderBindings,
    "an Employee runtime override must not masquerade as a persisted model default",
  );
  state.settings.languagePreference = "en";

  state.settings.kernelPathOverrides.opencode = { binaryPath: process.execPath };
  const firstOpenCodeModelState = roomExecutionState(state, {
    ...writer,
    kernel: "opencode",
    model: "model-a",
    providerId: "deepseek",
  });
  const repeatedOpenCodeModelState = roomExecutionState(state, {
    ...writer,
    kernel: "opencode",
    model: "model-a",
    providerId: "deepseek",
  });
  const secondOpenCodeModelState = roomExecutionState(state, {
    ...writer,
    kernel: "opencode",
    model: "model-b",
    providerId: "deepseek",
  });
  assert.notEqual(firstOpenCodeModelState, repeatedOpenCodeModelState);
  assert.equal(
    firstOpenCodeModelState.kernelAdapter,
    repeatedOpenCodeModelState.kernelAdapter,
    "the same non-reusable model boundary should reuse its Kernel worker but not its application view",
  );
  assert.notEqual(
    firstOpenCodeModelState.kernelAdapter,
    secondOpenCodeModelState.kernelAdapter,
    "a Kernel that cannot reuse workers across model changes must include the runtime model in its pool identity",
  );

  state.settings.customProviders.push({
    id: "ww",
    name: "WW",
    protocol: "anthropic-compatible",
    anthropicBaseUrl: "https://api.ww.example/v1",
    apiKey: "test-ww-key",
    credentialKind: "api-key",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ],
  });
  const deepSeekProfile = state.settings.customProviders.find((provider) => provider.id === "deepseek");
  assert.ok(deepSeekProfile);
  deepSeekProfile.models = [...(deepSeekProfile.models ?? []), { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }];
  state.settings.modelProviderBindings.push(
    {
      modelId: "deepseek-v4-pro",
      providerId: "deepseek",
    },
    {
      modelId: "deepseek-v4-flash",
      providerId: "ww",
    },
  );
  const claudeDeepSeekTarget = {
    ...writer,
    id: "employee-claude-deepseek",
    kernel: "claude-code" as const,
    model: "deepseek-v4-pro",
  };
  const claudeDeepSeekExecution = resolveRoomExecutionTarget(state, claudeDeepSeekTarget);
  assert.equal(claudeDeepSeekExecution.providerRoute.providerId, "deepseek");
  assert.equal(claudeDeepSeekExecution.target.model, "opus");
  assert.equal(
    claudeDeepSeekExecution.executionState.kernelProviderId,
    "deepseek",
    "The worker Provider chosen from the requested model must survive runtime model normalization",
  );
  state.settings.kernelPathOverrides["claude-code"] = { binaryPath: process.execPath };
  const claudeWwFlashExecution = resolveRoomExecutionTarget(state, {
    ...writer,
    id: "employee-claude-ww-flash",
    kernel: "claude-code",
    model: "deepseek-v4-flash",
    providerId: "ww",
  });
  const repeatedClaudeWwFlashExecution = resolveRoomExecutionTarget(state, {
    ...writer,
    id: "employee-claude-ww-flash-repeat",
    kernel: "claude-code",
    model: "deepseek-v4-flash",
    providerId: "ww",
  });
  const claudeWwProExecution = resolveRoomExecutionTarget(state, {
    ...writer,
    id: "employee-claude-ww-pro",
    kernel: "claude-code",
    model: "deepseek-v4-pro",
    providerId: "ww",
  });
  assert.equal(claudeWwFlashExecution.executionState.model, "deepseek-v4-flash");
  assert.equal(claudeWwFlashExecution.executionState.kernelRuntimeModel, "opus");
  assert.equal(claudeWwFlashExecution.providerRoute.providerId, "ww");
  assert.equal(
    claudeWwFlashExecution.executionState.kernelAdapter,
    repeatedClaudeWwFlashExecution.executionState.kernelAdapter,
    "the same concrete Claude Provider model should reuse its worker",
  );
  assert.notEqual(
    claudeWwFlashExecution.executionState.kernelAdapter,
    claudeWwProExecution.executionState.kernelAdapter,
    "Claude workers with static Provider model env must not be reused across concrete models that share the opus alias",
  );
  state.settings.kernelPathOverrides.hermes = { binaryPath: process.execPath };
  const hermesWwFlashState = roomExecutionState(state, {
    ...writer,
    kernel: "hermes",
    model: "deepseek-v4-flash",
    providerId: "ww",
  });
  const repeatedHermesWwFlashState = roomExecutionState(state, {
    ...writer,
    kernel: "hermes",
    model: "deepseek-v4-flash",
    providerId: "ww",
  });
  const hermesWwProState = roomExecutionState(state, {
    ...writer,
    kernel: "hermes",
    model: "deepseek-v4-pro",
    providerId: "ww",
  });
  assert.equal(hermesWwFlashState.kernelAdapter, repeatedHermesWwFlashState.kernelAdapter);
  assert.notEqual(
    hermesWwFlashState.kernelAdapter,
    hermesWwProState.kernelAdapter,
    "Hermes workers with a generated static Provider config must be isolated by concrete model",
  );
  const routedDeepSeekEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: claudeDeepSeekExecution.target,
    hostTools: false,
    providerRoute: claudeDeepSeekExecution.providerRoute,
  });
  const reparsedNormalizedEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: claudeDeepSeekExecution.target,
    hostTools: false,
  });
  assert.notEqual(
    routedDeepSeekEnvelope.sessionId,
    reparsedNormalizedEnvelope.sessionId,
    "The regression fixture must distinguish the original DeepSeek route from normalized-model WW fallback",
  );
  state.settings.modelProviderBindings = originalRoutingSettings.modelProviderBindings;
  state.settings.customProviders = originalRoutingSettings.customProviders;

  const lifecycleState = createBridgeState({ statePath: join(dir, "lifecycle-state.json") });
  stores.push(lifecycleState.store);
  const activeAdapter = lifecycleState.kernelAdapter;
  assert.ok(activeAdapter);
  let activeAdapterDisposeCount = 0;
  activeAdapter.dispose = async () => {
    activeAdapterDisposeCount += 1;
  };
  lifecycleState.roomKernelAdapters = new Map([["active-worker", activeAdapter]]);
  registerActiveRoomRunExecutionState(lifecycleState, "active-run", lifecycleState);
  recreateBridgeApp(lifecycleState);
  await delay(0);
  assert.equal(
    activeAdapterDisposeCount,
    0,
    "Recreating settings must not dispose an adapter used by an active Room Run",
  );
  clearActiveRoomRunExecutionState(lifecycleState, "active-run");
  await delay(0);
  assert.equal(activeAdapterDisposeCount, 1, "A retired adapter should be disposed after its active Run ends");

  const cleanupState = createBridgeState({ statePath: join(dir, "provider-cleanup-state.json") });
  stores.push(cleanupState.store);
  const deletedProviderId = "deleted-provider";
  cleanupState.settings.customProviders.push({
    id: deletedProviderId,
    name: "Deleted Provider",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://deleted.example/v1",
    apiKey: "deleted-key",
    credentialKind: "api-key",
    models: [{ id: cleanupState.model, label: cleanupState.model }],
  });
  cleanupState.settings.modelProviderBindings.push({
    modelId: cleanupState.model,
    providerId: deletedProviderId,
  });
  const settingsAfterProviderDelete = clearRemovedProviderSettingsReferences(
    cleanupState.settings,
    new Set([deletedProviderId]),
  );
  assert.equal(settingsAfterProviderDelete.modelProviderBindings.length, 0);

  assert.match(directEnvelope.sessionInstructions, /Story Architect/);
  assert.doesNotMatch(directEnvelope.sessionInstructions, /故事架构师|stored name:/);
  assert.match(
    directEnvelope.sessionInstructions,
    /Name usage: Use the App and employee display names provided by the Host exactly as shown/,
  );
  assert.match(directEnvelope.sessionInstructions, /room\.ledger\.read/);
  assert.doesNotMatch(
    directEnvelope.sessionInstructions,
    /If another employee or PM auto-routing sent the message, call room\.ledger\.read before acting\./,
  );
  assert.match(directEnvelope.sessionInstructions, /room\.delegate\.task/);
  assert.match(
    directEnvelope.sessionInstructions,
    /not a current room administrator and cannot call room\.delegate\.task/,
  );
  assert.doesNotMatch(
    directEnvelope.sessionInstructions,
    /When the user asks you to contact.*must call room\.delegate\.task/,
  );
  assert.doesNotMatch(directEnvelope.sessionInstructions, /room-envelope-story-seed/);
  assert.doesNotMatch(directEnvelope.sessionInstructions, /章节大纲\.md/);
  assert.match(directEnvelope.sessionInstructions, /Room collaboration rules:/);
  assert.match(directEnvelope.sessionInstructions, /includeMembers: true/);
  assert.doesNotMatch(directEnvelope.sessionInstructions, /Default skill index:/);
  assert.match(directEnvelope.turnInstructions, /Current room: Story Seed/);
  assert.match(
    directEnvelope.turnInstructions,
    /For this Room turn, treat the content inside <current-message> as the current input/,
  );
  assert.match(directEnvelope.turnInstructions, /room-envelope-story-seed/);
  assert.match(directEnvelope.turnInstructions, /Current room members/);
  assert.doesNotMatch(directEnvelope.turnInstructions, /includeMembers: true/);
  assert.doesNotMatch(directEnvelope.turnInstructions, /Session continuation/);
  assert.match(directEnvelope.turnInstructions, /Lead Editor \(employee-editor\)/);
  assert.doesNotMatch(directEnvelope.turnInstructions, /故事架构师|金牌编辑|故事种子 PM|stored name/);
  assert.deepEqual(resolveVisibleRoomTargets(state, roomId, "@Lead Editor review this", []), [editor.id]);
  assert.deepEqual(resolveVisibleRoomTargets(state, roomId, "@金牌编辑 review this", []), [editor.id]);
  assert.equal(
    directEnvelope.userInput,
    [
      "[Message context]",
      "Selected file: 项目/长安客/章节大纲.md",
      'Note: This is only the user\'s current UI selection, not a request to operate on the file. Treat it as the task target only when this request explicitly mentions it or refers to it as "this file".',
      "",
      `[Current message #${direct.channelSeq}]`,
      "",
      "<current-message>",
      "@故事架构师 请继续完善章节大纲。",
      "</current-message>",
    ].join("\n"),
  );
  assert.deepEqual(directEnvelope.attachments, []);

  const ambiguousEnglishPost = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 hi",
    targetIds: [writer.id],
    assistantTargets: [writer],
    deliveryKind: "user_direct",
  });
  const ambiguousEnglishEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: ambiguousEnglishPost.userMessage.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    ambiguousEnglishEnvelope.userInput,
    [
      `[Current message #${ambiguousEnglishPost.userMessage.channelSeq}]`,
      "",
      "<current-message>",
      "@故事架构师 hi",
      "</current-message>",
    ].join("\n"),
  );
  assert.match(ambiguousEnglishEnvelope.turnInstructions, /Session continuation/);

  state.settings.languagePreference = "zh-CN";
  const chinesePost = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 请用中文继续。",
    targetIds: [writer.id],
    assistantTargets: [writer],
    deliveryKind: "user_direct",
  });
  const chineseEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: chinesePost.userMessage.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    chineseEnvelope.userInput,
    [
      `【当前消息 #${chinesePost.userMessage.channelSeq}】`,
      "",
      "<current-message>",
      "@故事架构师 请用中文继续。",
      "</current-message>",
    ].join("\n"),
  );
  assert.match(chineseEnvelope.sessionInstructions, /名称使用规则：App 和员工名称以 Host 提供的当前界面展示名为准/);
  assert.match(chineseEnvelope.sessionInstructions, /房间协作规则：/);
  assert.match(chineseEnvelope.sessionInstructions, /includeMembers: true/);
  assert.match(chineseEnvelope.turnInstructions, /当前房间：Story Seed/);
  assert.match(chineseEnvelope.turnInstructions, /本轮以 <current-message> 内的内容作为当前输入/);
  assert.doesNotMatch(chineseEnvelope.turnInstructions, /includeMembers: true/);
  assert.match(chineseEnvelope.turnInstructions, /Lead Editor \(employee-editor\)/);
  assert.doesNotMatch(chineseEnvelope.turnInstructions, /原名/);
  const chineseWithoutToolsEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: chinesePost.userMessage.id,
    target: writer,
    hostTools: false,
  });
  assert.match(
    chineseWithoutToolsEnvelope.sessionInstructions,
    /名称使用规则：App 和员工名称以 Host 提供的当前界面展示名为准/,
  );
  assert.match(chineseWithoutToolsEnvelope.sessionInstructions, /房间协作能力限制：/);
  assert.match(chineseWithoutToolsEnvelope.turnInstructions, /本轮以 <current-message> 内的内容作为当前输入/);
  state.settings.languagePreference = "en";

  let scheduledInput = "";
  let scheduledHostContext = "";
  let scheduledSessionInstructions = "";
  const providersBeforeScheduledRun = [...state.settings.customProviders];
  state.settings.customProviders.push({
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://api.deepseek.example/v1",
    apiKey: "test-deepseek-key",
    credentialKind: "api-key",
    modelsPinned: false,
    models: [{ id: writer.model, label: writer.model }],
  });
  const scheduledTarget = {
    ...writer,
    providerId: "deepseek",
  };
  const scheduledExecutionState = roomExecutionState(state, scheduledTarget);
  const scheduledAdapter = scheduledExecutionState.kernelAdapter;
  assert.ok(scheduledAdapter);
  scheduledAdapter.runTurn = async function* captureEnvelopeRun(request): AsyncIterable<AgentEvent> {
    scheduledInput = request.input;
    scheduledHostContext = request.assembledContext?.promptBlock ?? "";
    scheduledSessionInstructions = request.sessionInstructions ?? "";
    const runId = request.runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    yield { type: "model.response", runId, response: { text: "已处理。" } } as AgentEvent;
    yield { type: "turn.finished", runId, at: new Date().toISOString() };
  };
  const scheduledEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: scheduledTarget,
    hostTools: scheduledExecutionState.kernelCapabilities?.hostTools === true,
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: direct.id,
    targets: [scheduledTarget],
    assistantMessages: directPost.assistantMessages,
  });
  await waitFor(() => Boolean(scheduledInput), "scheduled Room Run envelope");
  assert.equal(scheduledInput, scheduledEnvelope.userInput);
  assert.equal(
    scheduledSessionInstructions,
    scheduledEnvelope.sessionInstructions,
    "stable Room instructions must stay separate for the native session-start boundary",
  );
  assert.ok(
    scheduledHostContext.includes(scheduledEnvelope.turnInstructions),
    "the fresh per-Run App view must deliver mutable Room facts to the reused Kernel worker",
  );
  assert.ok(
    !scheduledHostContext.includes(scheduledEnvelope.sessionInstructions),
    "stable Room instructions must not be duplicated into assembled per-Turn context",
  );
  state.settings.customProviders = providersBeforeScheduledRun;

  const originalAgentReply = state.app.rooms.postAgentMessage({
    roomId,
    senderId: writer.id,
    senderName: writer.name,
    text: "可以，我会先补全前三章的悬念递进。",
    targetIds: [],
    inReplyToMessageId: direct.id,
    rootMessageId: direct.id,
  });
  const userReply = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 把第二章的反转再提前一点。",
    targetIds: [writer.id],
    assistantTargets: [writer],
    inReplyToMessageId: originalAgentReply.id,
    rootMessageId: direct.id,
  }).userMessage;
  const userReplyEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: userReply.id,
    target: writer,
    hostTools: true,
  });
  assert.match(
    userReplyEnvelope.userInput,
    new RegExp(`Replying to #${originalAgentReply.channelSeq} 故事架构师: "可以，我会先补全前三章的悬念递进。"`),
  );
  assert.match(
    userReplyEnvelope.userInput,
    new RegExp(`Thread root #${direct.channelSeq} User: "@故事架构师 请继续完善章节大纲。"`),
  );
  assert.match(userReplyEnvelope.userInput, new RegExp(`\\[Current message #${userReply.channelSeq}\\]`));
  assert.match(
    userReplyEnvelope.userInput,
    /<current-message>\n@故事架构师 把第二章的反转再提前一点。\n<\/current-message>$/,
  );

  const longThreadRoot = state.app.rooms.postUserMessage({
    roomId,
    text: `root ${"根".repeat(100)}`,
    targetIds: [writer.id],
    deliveryKind: "user_direct",
  }).userMessage;
  const longReplyText = "🙂".repeat(2_001);
  const longDirectParent = state.app.rooms.postAgentMessage({
    roomId,
    senderId: writer.id,
    senderName: writer.name,
    text: longReplyText,
    targetIds: [],
    inReplyToMessageId: longThreadRoot.id,
    rootMessageId: longThreadRoot.id,
  });
  const longNestedReply = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 继续。",
    targetIds: [writer.id],
    assistantTargets: [writer],
    inReplyToMessageId: longDirectParent.id,
    rootMessageId: longThreadRoot.id,
  }).userMessage;
  const longNestedEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: longNestedReply.id,
    target: writer,
    hostTools: true,
  });
  assert.match(
    longNestedEnvelope.userInput,
    new RegExp(`Thread root #${longThreadRoot.channelSeq} User: "root ${"根".repeat(75)}…"`),
    "multi-level replies should carry one deterministic 80-character root summary",
  );
  assert.ok(
    longNestedEnvelope.userInput.includes(
      `Replying to #${longDirectParent.channelSeq} 故事架构师: "${"🙂".repeat(2_000)}… (truncated; full content is available in room ledger #${longDirectParent.channelSeq})"`,
    ),
    "the direct parent should be truncated by Unicode code point and point to the ledger",
  );
  assert.ok(
    !longNestedEnvelope.userInput.includes(longReplyText),
    "the 2,001-character parent body must not be injected in full",
  );

  const delegated = state.app.rooms.postAgentMessage({
    roomId,
    senderId: writer.id,
    senderName: writer.name,
    text: "@金牌编辑 请审核最新章节大纲，重点看付费点衔接。",
    targetIds: [editor.id],
    deliveryKind: "agent_delegation",
    inReplyToMessageId: direct.id,
    rootMessageId: direct.id,
  });
  const delegatedEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: delegated.id,
    target: editor,
    hostTools: true,
  });
  assert.equal(
    delegatedEnvelope.userInput,
    [
      "[Message context]",
      `Replying to #${direct.channelSeq} User: "@故事架构师 请继续完善章节大纲。"`,
      "Source: 故事架构师 (employee delegation)",
      "(Another employee delegated this message to you. Read the room ledger before acting so you understand the relevant context.)",
      "",
      `[Current message #${delegated.channelSeq}]`,
      "",
      "<current-message>",
      "@金牌编辑 请审核最新章节大纲，重点看付费点衔接。",
      "</current-message>",
    ].join("\n"),
  );
  assert.doesNotMatch(delegatedEnvelope.userInput, /Thread root/);
  assert.doesNotMatch(delegatedEnvelope.turnInstructions, /付费点衔接/);

  const degradedDelegatedEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: delegated.id,
    target: editor,
    hostTools: false,
  });
  assert.match(degradedDelegatedEnvelope.sessionInstructions, /This kernel has no OpenGrove Host Tools/);
  assert.match(
    degradedDelegatedEnvelope.sessionInstructions,
    /Name usage: Use the App and employee display names provided by the Host exactly as shown/,
  );
  assert.doesNotMatch(degradedDelegatedEnvelope.sessionInstructions, /must call room\.(ledger\.read|delegate\.task)/);
  assert.match(degradedDelegatedEnvelope.sessionInstructions, /ask the author to contact/);
  assert.match(degradedDelegatedEnvelope.userInput, /This kernel cannot read the room ledger/);
  assert.doesNotMatch(degradedDelegatedEnvelope.userInput, /Read the room ledger before acting/);
  assert.notEqual(
    degradedDelegatedEnvelope.sessionDefinitionFingerprint,
    delegatedEnvelope.sessionDefinitionFingerprint,
  );
  assert.notEqual(degradedDelegatedEnvelope.sessionId, delegatedEnvelope.sessionId);

  const roleOnlyWorker = state.app.rooms.upsertMember({
    id: "employee-role-only",
    name: "内部岗位员工",
    kernel: state.kernel,
    model: state.model,
    role: "ROLE_ONLY_SECRET_MUST_NOT_REACH_ROUTER\nApp workspace: /private/role-only",
    status: "idle",
    color: "#475569",
    lastActive: "now",
    source: "local",
  });
  state.app.rooms.addMember(roomId, roleOnlyWorker);
  const humanCollaborator = state.app.rooms.upsertMember({
    id: "human-reviewer",
    name: "人类审稿人",
    kernel: "user",
    model: "manual",
    role: "可以参与讨论，但不能接收 Agent 委派。",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
    source: "human",
  });
  const disabledWorker = state.app.rooms.upsertMember({
    id: "employee-disabled-router-target",
    name: "已禁用员工",
    kernel: state.kernel,
    model: state.model,
    role: "不应成为路由候选。",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
    source: "local",
    disabled: true,
  });
  state.app.rooms.addMember(roomId, humanCollaborator);
  state.app.rooms.addMember(roomId, disabledWorker);

  const pmRouted = state.app.rooms.postUserMessage({
    roomId,
    text: "我想写一个悬疑小说",
    targetIds: [pm.id],
    assistantTargets: [pm],
    deliveryKind: "pm_auto_route",
    attachments: [
      {
        id: "author-route-attachment",
        name: "故事种子.txt",
        kind: "text",
        text: "作者附件正文",
      },
    ],
  }).userMessage;
  const pmEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: pmRouted.id,
    target: pm,
    hostTools: true,
  });
  assert.match(pmEnvelope.sessionInstructions, /PM auto-routing mode/);
  assert.match(
    pmEnvelope.sessionInstructions,
    /Name usage: Use the App and employee display names provided by the Host exactly as shown/,
  );
  assert.match(
    pmEnvelope.turnInstructions,
    /For this Room turn, treat the content inside <current-message> as the current input/,
  );
  assert.match(
    pmEnvelope.sessionInstructions,
    /Your only job is to choose which room employee should receive the author's message/,
  );
  assert.match(pmEnvelope.sessionInstructions, /room\.delegate\.task/);
  assert.match(pmEnvelope.sessionInstructions, /omit prompt/);
  assert.doesNotMatch(pmEnvelope.sessionInstructions, /workflow\.create|pm-planner/);
  assert.doesNotMatch(pmEnvelope.sessionInstructions, /负责把未明确 @ 的用户消息路由给合适员工/);
  assert.doesNotMatch(pmEnvelope.sessionInstructions, /我想写一个悬疑小说/);
  assert.match(
    pmEnvelope.turnInstructions,
    /Story Architect.*employee-writer.*Develops story concepts and chapter outlines/,
  );
  assert.match(
    pmEnvelope.turnInstructions,
    /Lead Editor.*employee-editor.*Independently reviews story concepts and chapter outlines/,
  );
  assert.match(pmEnvelope.turnInstructions, /employee-role-only/);
  assert.doesNotMatch(pmEnvelope.turnInstructions, /human-reviewer|人类审稿人/);
  assert.doesNotMatch(pmEnvelope.turnInstructions, /employee-disabled-router-target|已禁用员工/);
  assert.doesNotMatch(
    pmEnvelope.turnInstructions,
    /INTERNAL_(WRITER|EDITOR)_ROLE|ROLE_ONLY_SECRET_MUST_NOT_REACH_ROUTER|\/private\/(story-|role-only)/,
  );
  assert.equal(
    pmEnvelope.userInput,
    [
      `[Current message #${pmRouted.channelSeq}]`,
      "",
      "<current-message>",
      "我想写一个悬疑小说",
      "</current-message>",
    ].join("\n"),
  );

  const degradedPmEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: pmRouted.id,
    target: pm,
    hostTools: false,
  });
  assert.match(degradedPmEnvelope.sessionInstructions, /PM auto-routing is unavailable/);
  assert.match(
    degradedPmEnvelope.sessionInstructions,
    /Name usage: Use the App and employee display names provided by the Host exactly as shown/,
  );
  assert.doesNotMatch(degradedPmEnvelope.sessionInstructions, /负责把未明确 @|workflow\.create|pm-planner/);

  state.app.rooms.patchRoom(roomId, { adminMemberIds: [writer.id] });
  const nonAdminPmEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: pmRouted.id,
    target: pm,
    hostTools: true,
  });
  assert.match(nonAdminPmEnvelope.sessionInstructions, /PM auto-routing is unavailable/);
  assert.match(
    nonAdminPmEnvelope.sessionInstructions,
    /Name usage: Use the App and employee display names provided by the Host exactly as shown/,
  );
  assert.doesNotMatch(nonAdminPmEnvelope.sessionInstructions, /负责把未明确 @|workflow\.create|pm-planner/);
  state.app.rooms.patchRoom(roomId, { adminMemberIds: [pm.id] });

  const forwardedPmRoute = state.app.rooms.postAgentMessage({
    roomId,
    senderId: pm.id,
    senderName: pm.name,
    text: pmRouted.text,
    targetIds: [writer.id],
    deliveryKind: "pm_auto_route",
    inReplyToMessageId: pmRouted.id,
    rootMessageId: pmRouted.id,
  });
  const forwardedPmRouteEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: forwardedPmRoute.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    forwardedPmRouteEnvelope.userInput,
    [
      `[Current message #${pmRouted.channelSeq}]`,
      "",
      "<current-message>",
      "我想写一个悬疑小说",
      "</current-message>",
    ].join("\n"),
  );
  assert.doesNotMatch(forwardedPmRouteEnvelope.userInput, /Replying to|Source:|PM auto-routing/);
  assert.deepEqual(forwardedPmRouteEnvelope.attachments, pmRouted.attachments);

  const routeThreadRoot = state.app.rooms.postUserMessage({
    roomId,
    text: "请继续完善已有章节大纲。",
    targetIds: [writer.id],
    deliveryKind: "user_direct",
  }).userMessage;
  const repliedPmRoute = state.app.rooms.postUserMessage({
    roomId,
    text: "按要求修改和优化",
    targetIds: [pm.id],
    assistantTargets: [pm],
    deliveryKind: "pm_auto_route",
    inReplyToMessageId: routeThreadRoot.id,
    rootMessageId: routeThreadRoot.id,
  }).userMessage;
  const forwardedReplyRoute = state.app.rooms.postAgentMessage({
    roomId,
    senderId: pm.id,
    senderName: pm.name,
    text: repliedPmRoute.text,
    targetIds: [writer.id],
    deliveryKind: "pm_auto_route",
    inReplyToMessageId: repliedPmRoute.id,
    rootMessageId: routeThreadRoot.id,
  });
  const forwardedReplyRouteEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: forwardedReplyRoute.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    forwardedReplyRouteEnvelope.userInput,
    [
      "[Message context]",
      `Replying to #${routeThreadRoot.channelSeq} User: "请继续完善已有章节大纲。"`,
      "",
      `[Current message #${repliedPmRoute.channelSeq}]`,
      "",
      "<current-message>",
      "按要求修改和优化",
      "</current-message>",
    ].join("\n"),
  );
  assert.doesNotMatch(forwardedReplyRouteEnvelope.userInput, new RegExp(`#${forwardedReplyRoute.channelSeq}`));
  assert.doesNotMatch(forwardedReplyRouteEnvelope.userInput, /Source:|PM auto-routing/);

  const directPmMessage = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事种子 PM 请规划后续工作",
    targetIds: [pm.id],
    deliveryKind: "user_direct",
  }).userMessage;
  const directPmEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: directPmMessage.id,
    target: pm,
    hostTools: true,
  });
  assert.doesNotMatch(directPmEnvelope.sessionInstructions, /PM auto-routing mode/);
  assert.match(directPmEnvelope.sessionInstructions, /负责把未明确 @ 的用户消息路由给合适员工/);
  assert.match(directPmEnvelope.sessionInstructions, /Story Seed PM/);
  assert.doesNotMatch(directPmEnvelope.sessionInstructions, /故事种子 PM|stored name:/);
  assert.notEqual(directPmEnvelope.sessionDefinitionFingerprint, pmEnvelope.sessionDefinitionFingerprint);
  assert.notEqual(directPmEnvelope.sessionId, pmEnvelope.sessionId);
  const changedPmRoleAutoRouteEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: pmRouted.id,
    target: { ...pm, role: "这条岗位说明不参与自动路由。" },
    hostTools: true,
  });
  assert.equal(changedPmRoleAutoRouteEnvelope.sessionInstructions, pmEnvelope.sessionInstructions);
  assert.equal(changedPmRoleAutoRouteEnvelope.sessionDefinitionFingerprint, pmEnvelope.sessionDefinitionFingerprint);
  assert.equal(changedPmRoleAutoRouteEnvelope.sessionId, pmEnvelope.sessionId);

  const fingerprintBeforeRosterChange = directEnvelope.sessionDefinitionFingerprint;
  const sessionIdBeforeSkillRegistryChange = directEnvelope.sessionId;
  storyWriterSkillMetadata = {
    ...storyWriterSkillMetadata,
    description: "动态更新后的技能说明。",
  };
  const afterSkillRegistryDescriptionChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    afterSkillRegistryDescriptionChange.sessionInstructions,
    directEnvelope.sessionInstructions,
    "Skill metadata belongs to the per-turn native Skill requirement and must not be duplicated in Room session instructions",
  );
  assert.equal(
    afterSkillRegistryDescriptionChange.sessionDefinitionFingerprint,
    fingerprintBeforeRosterChange,
    "the skill registry's dynamic description is not part of the stable Employee definition and must not create a new session",
  );
  assert.equal(afterSkillRegistryDescriptionChange.sessionId, sessionIdBeforeSkillRegistryChange);

  storyWriterSkillMetadata = {
    ...storyWriterSkillMetadata,
    whenToUse: "动态更新后的使用场景。",
  };
  const afterSkillRegistryWhenToUseChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    afterSkillRegistryWhenToUseChange.sessionInstructions,
    afterSkillRegistryDescriptionChange.sessionInstructions,
  );
  assert.equal(
    afterSkillRegistryWhenToUseChange.sessionDefinitionFingerprint,
    fingerprintBeforeRosterChange,
    "the skill registry's dynamic whenToUse is not part of the stable Employee definition and must not create a new session",
  );
  assert.equal(afterSkillRegistryWhenToUseChange.sessionId, sessionIdBeforeSkillRegistryChange);

  storyWriterSkillMetadata = {
    ...storyWriterSkillMetadata,
    disableModelInvocation: true,
  };
  const afterSkillRegistryDisableChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    afterSkillRegistryDisableChange.sessionInstructions,
    afterSkillRegistryWhenToUseChange.sessionInstructions,
  );
  assert.equal(
    afterSkillRegistryDisableChange.sessionDefinitionFingerprint,
    fingerprintBeforeRosterChange,
    "the skill registry's dynamic enable/disable state is not part of the stable Employee definition and must not create a new session",
  );
  assert.equal(afterSkillRegistryDisableChange.sessionId, sessionIdBeforeSkillRegistryChange);

  const changedTurnMessage = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 这是另一轮消息。",
    targetIds: [writer.id],
    deliveryKind: "user_direct",
    selectedFile: { path: "项目/另一个文件.md" },
  }).userMessage;
  const changedTurnEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: changedTurnMessage.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    changedTurnEnvelope.sessionDefinitionFingerprint,
    fingerprintBeforeRosterChange,
    "the current message and selected file are per-turn facts and must not create a new session",
  );
  assert.equal(changedTurnEnvelope.sessionId, sessionIdBeforeSkillRegistryChange);
  const extra = state.app.rooms.upsertMember({
    ...editor,
    id: "employee-reader",
    name: "读者代表",
  });
  state.app.rooms.addMember(roomId, extra);
  const afterRosterChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(afterRosterChange.sessionDefinitionFingerprint, fingerprintBeforeRosterChange);
  assert.equal(afterRosterChange.sessionId, sessionIdBeforeSkillRegistryChange);
  assert.notEqual(afterRosterChange.turnInstructions, directEnvelope.turnInstructions);

  const changedRoleEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: { ...writer, role: "修改后的稳定岗位说明。" },
    hostTools: true,
  });
  assert.notEqual(changedRoleEnvelope.sessionDefinitionFingerprint, fingerprintBeforeRosterChange);
  assert.notEqual(changedRoleEnvelope.sessionId, sessionIdBeforeSkillRegistryChange);

  const changedDefaultSkillIdsEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: { ...writer, defaultSkillIds: ["story-writer", "story-reviewer"] },
    hostTools: true,
  });
  assert.notEqual(changedDefaultSkillIdsEnvelope.sessionDefinitionFingerprint, fingerprintBeforeRosterChange);
  assert.notEqual(changedDefaultSkillIdsEnvelope.sessionId, sessionIdBeforeSkillRegistryChange);

  const runtimeAppId = "room-envelope-runtime-app";
  const runtimeAppRoot = join(dir, runtimeAppId);
  const runtimeWorkspaceRoot = join(runtimeAppRoot, "workspace");
  const runtimeSkillRoot = join(runtimeAppRoot, "skills", "story-writer");
  mkdirSync(runtimeWorkspaceRoot, { recursive: true });
  mkdirSync(runtimeSkillRoot, { recursive: true });
  writeFileSync(
    join(runtimeAppRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: runtimeAppId,
      title: "Room Envelope Runtime App",
      version: "1.0.0",
    })}\n`,
    "utf8",
  );
  const runtimeSkillPath = join(runtimeSkillRoot, "SKILL.md");
  writeFileSync(runtimeSkillPath, "# Story Writer\n\nFirst stable runtime definition.\n", "utf8");
  state.settings.mountedApps.push({
    id: runtimeAppId,
    path: runtimeAppRoot,
    enabled: true,
  });
  const runtimeTarget = {
    ...writer,
    appId: runtimeAppId,
    workspaceRoot: runtimeWorkspaceRoot,
  };
  const beforeRuntimeDefinitionChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: runtimeTarget,
    hostTools: true,
  });
  writeFileSync(runtimeSkillPath, "# Story Writer\n\nUpdated stable runtime definition.\n", "utf8");
  const afterRuntimeDefinitionChange = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: direct.id,
    target: runtimeTarget,
    hostTools: true,
  });
  assert.equal(
    afterRuntimeDefinitionChange.sessionDefinitionFingerprint,
    beforeRuntimeDefinitionChange.sessionDefinitionFingerprint,
    "Skill body updates within one App version must keep the Room native session stable",
  );
  assert.equal(afterRuntimeDefinitionChange.sessionId, beforeRuntimeDefinitionChange.sessionId);

  const deletedThreadRoot = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 这条线程根消息随后会被删除。",
    targetIds: [writer.id],
    deliveryKind: "user_direct",
  }).userMessage;
  const orphanedThreadReply = state.app.rooms.postUserMessage({
    roomId,
    text: "@故事架构师 即使根消息已删除也继续。",
    targetIds: [writer.id],
    deliveryKind: "user_direct",
    inReplyToMessageId: deletedThreadRoot.id,
    rootMessageId: deletedThreadRoot.id,
  }).userMessage;
  state.app.rooms.deleteMessage(roomId, deletedThreadRoot.id);
  const orphanedThreadEnvelope = buildRoomRunEnvelope(state, {
    roomId,
    triggerMessageId: orphanedThreadReply.id,
    target: writer,
    hostTools: true,
  });
  assert.equal(
    orphanedThreadEnvelope.userInput,
    [
      `[Current message #${orphanedThreadReply.channelSeq}]`,
      "",
      "<current-message>",
      "@故事架构师 即使根消息已删除也继续。",
      "</current-message>",
    ].join("\n"),
  );

  assert.throws(
    () =>
      buildRoomRunEnvelope(state, {
        roomId: "missing-room",
        triggerMessageId: direct.id,
        target: writer,
        hostTools: true,
      }),
    /room_not_found/,
  );
  assert.throws(
    () =>
      buildRoomRunEnvelope(state, {
        roomId,
        triggerMessageId: "missing-message",
        target: writer,
        hostTools: true,
      }),
    /trigger_message_not_found/,
  );

  console.log("room-run-envelope-harness ok");
} finally {
  for (const store of [...stores].reverse()) await store.close?.();
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 50,
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
