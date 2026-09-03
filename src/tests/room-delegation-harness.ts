import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent, AgentTurnRequest, ToolResult } from "../core.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { createBridgeState } from "../server/bridge-state.js";
import { defaultBridgeSettings, normalizeBridgeSettingsPatch } from "../server/bridge-settings-store.js";
import { PM_AGENT_SKILL_NAME } from "../server/bridge-mounted-app-employees.js";
import { delegateRoomTask, delegationTargetSummaries, findRoomPmMember } from "../server/room-delegation.js";
import { scheduleRoomAssistantRuns } from "../server/room-runs.js";
import { roomExecutionState } from "../server/room-runs/execution-state.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-room-delegation-"));
let store: ReturnType<typeof createBridgeState>["store"] | undefined;

try {
  // ===== 真实 Employee→Employee 委派、先落账后启动、A→B→A 回环 =====
  const defaultSettings = defaultBridgeSettings();
  assert.deepEqual(defaultSettings.roomCollaboration, {
    maxDelegationsPerRun: 20,
    maxDelegationChainDepth: 5,
  });
  assert.deepEqual(
    normalizeBridgeSettingsPatch(
      {
        roomCollaboration: {
          maxDelegationsPerRun: 7,
          maxDelegationChainDepth: 3,
        },
      },
      defaultSettings,
    ).roomCollaboration,
    {
      maxDelegationsPerRun: 7,
      maxDelegationChainDepth: 3,
    },
  );
  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  store = state.store;
  assert.ok(state.kernelCapabilities);
  state.kernelCapabilities = { ...state.kernelCapabilities, hostTools: true };
  state.settings.kernelPathOverrides[state.kernel] = { binaryPath: process.execPath };
  state.settings.customProviders.push({
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://api.deepseek.example/v1",
    apiKey: "test-deepseek-key",
    credentialKind: "api-key",
    models: [{ id: state.model, label: state.model }],
  });
  const material = addEmployee("employee-material", "素材");
  const buyer = addEmployee("employee-ad-buyer", "投放");
  const pm = addEmployee("employee-room-pm", "路由 PM", [PM_AGENT_SKILL_NAME], "pm");
  const reviewer = addEmployee("employee-reviewer", "审核");
  const outsider = addEmployee("employee-outsider", "房外员工");
  const roomId = "room-agent-to-agent-delegation";
  state.app.rooms.ensureGroupRoom({
    id: roomId,
    title: "真实员工委派",
    badge: "Test",
    memberIds: [material.id, buyer.id, pm.id, reviewer.id],
    adminMemberIds: [material.id, buyer.id, pm.id, reviewer.id],
  });
  state.app.rooms.ensureGroupRoom({
    id: "room-outsider-only",
    title: "其他房间",
    badge: "Test",
    memberIds: [outsider.id],
  });

  const ordinaryMember = addEmployee("employee-ordinary-member", "普通成员");
  const permissionRoomId = "room-delegation-admin-permission";
  state.app.rooms.ensureGroupRoom({
    id: permissionRoomId,
    title: "管理员委派权限",
    badge: "Test",
    memberIds: [ordinaryMember.id, reviewer.id],
    adminMemberIds: [reviewer.id],
  });
  assert.equal(
    findRoomPmMember(state, permissionRoomId)?.employeeDefinitionId,
    "pm",
    "an ordinary group that receives the global PM can use it for PM routing",
  );
  const permissionTrigger = state.app.rooms.postUserMessage({
    roomId: permissionRoomId,
    text: "@普通成员 请委派审核",
    targetIds: [ordinaryMember.id],
    assistantTargets: [ordinaryMember],
    deliveryKind: "user_direct",
  });
  const permissionSource = permissionTrigger.assistantMessages[0]!;
  const permissionSourceRunId = "run-non-admin-delegation";
  state.app.rooms.updateMessage(permissionRoomId, permissionSource.id, {
    runId: permissionSourceRunId,
    status: "running",
  });
  const nonAdminDelegation = await delegateRoomTask(state, {
    sourceRunId: permissionSourceRunId,
    targetMemberId: reviewer.id,
    prompt: "@审核 普通成员不应能委派",
  });
  assert.equal(nonAdminDelegation.ok, false);
  assert.equal(nonAdminDelegation.error, "delegation_requires_room_admin");
  assert.deepEqual(delegationTargetSummaries(state, permissionSourceRunId), []);
  const previousLanguagePreference = state.settings.languagePreference;
  state.settings.languagePreference = "en";
  const nonAdminToolDelegation = await state.app.tools.require("room.delegate.task").execute(
    {
      targetMemberId: reviewer.id,
      prompt: "@审核 普通成员仍不应能委派",
    },
    { runId: permissionSourceRunId } as never,
  );
  assert.equal(nonAdminToolDelegation.ok, false);
  assert.match(
    nonAdminToolDelegation.error ?? "",
    /^delegation_requires_room_admin;.*Reply to the author/,
    "the Agent-facing Tool error must preserve the machine code and provide an actionable fallback",
  );
  state.settings.languagePreference = previousLanguagePreference;
  state.settings.languagePreference = "en";

  let firstDelegation: ToolResult | undefined;
  let duplicateDelegation: ToolResult | undefined;
  let sourceRunId = "";
  let delegatedTargetRunId = "";
  let delegatedTargetInput = "";
  let targetSawPersistedDelegationAtStart = false;
  let returnDelegation: ToolResult | undefined;
  let returnedRunFinished = false;
  let releaseTarget!: () => void;
  const targetGate = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  const currentMessageIs = (input: string, text: string) =>
    input.endsWith(`<current-message>\n${text}\n</current-message>`);

  let roomRunHarness = async function* runAgentTurn(input: string, options: unknown = {}): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "@投放 请为素材包 pack-real 建投放计划")) {
      delegatedTargetRunId = runId;
      delegatedTargetInput = input;
      targetSawPersistedDelegationAtStart = state.app.rooms
        .listMessages(roomId, { limit: 20 })
        .some(
          (message) =>
            message.text === "@投放 请为素材包 pack-real 建投放计划" && message.deliveryKind === "agent_delegation",
        );
      await targetGate;
      returnDelegation = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: material.id,
          prompt: "@素材 RETURN_TO_MATERIAL",
        },
        { runId } as never,
      );
      yield { type: "model.response", runId, response: { text: "已接到真实委派。" } } as AgentEvent;
    } else if (currentMessageIs(input, "@素材 RETURN_TO_MATERIAL")) {
      returnedRunFinished = true;
      yield { type: "model.response", runId, response: { text: "已收到回环委派。" } } as AgentEvent;
    } else if (
      (input.includes("[Current message #") || input.includes("【当前消息 #")) &&
      currentMessageIs(input, "@素材 请叫投放员工接手")
    ) {
      sourceRunId = runId;
      const tool = state.app.tools.require("room.delegate.task");
      firstDelegation = await tool.execute(
        {
          targetMemberId: buyer.id,
          prompt: "@投放 请为素材包 pack-real 建投放计划",
        },
        { runId } as never,
      );
      duplicateDelegation = await tool.execute(
        {
          targetMemberId: buyer.id,
          prompt: "@投放 再补充一个重复要求",
        },
        { runId } as never,
      );
      yield { type: "model.response", runId, response: { text: "我已发起真实委派。" } } as AgentEvent;
    } else {
      yield { type: "error", runId, message: `unexpected_input:${input}` } as AgentEvent;
    }
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const harnessExecutionState = roomExecutionState(state, material);
  const harnessAdapter = harnessExecutionState.kernelAdapter;
  assert.ok(harnessAdapter, "the delegation harness needs one reusable Kernel worker seam");
  harnessAdapter.runTurn = async function* runHarnessTurn(request): AsyncIterable<AgentEvent> {
    yield* roomRunHarness(request.input, request);
  };

  const sourcePost = state.app.rooms.postUserMessage({
    roomId,
    text: "@素材 请叫投放员工接手",
    targetIds: [material.id],
    assistantTargets: [material],
    deliveryKind: "user_direct",
  });
  const [sourceRunMessage] = scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: sourcePost.userMessage.id,
    targets: [material],
    assistantMessages: sourcePost.assistantMessages,
  });
  assert.ok(sourceRunMessage?.runId, "source employee must have a real scheduled Run");

  await waitFor(() => Boolean(firstDelegation), "real Agent-to-Agent delegation result");
  assert.equal(sourceRunId, sourceRunMessage.runId);
  assert.equal(firstDelegation?.ok, true, firstDelegation?.error);
  const submittedValue = firstDelegation?.value as
    | {
        taskId?: string;
        roomId?: string;
        messageId?: string;
        state?: string;
      }
    | undefined;
  assert.equal(submittedValue?.roomId, roomId);
  assert.equal(submittedValue?.state, "TASK_STATE_SUBMITTED");
  assert.ok(submittedValue?.taskId);
  assert.ok(submittedValue?.messageId);
  assert.equal(
    Object.prototype.hasOwnProperty.call(firstDelegation?.value ?? {}, "text"),
    false,
    "submitted delegation must not contain the target's final reply",
  );
  await waitFor(() => Boolean(delegatedTargetRunId), "delegated target Run start");
  assert.equal(
    targetSawPersistedDelegationAtStart,
    true,
    "delegation message must be persisted to the ledger before the target Run starts",
  );

  assert.equal(duplicateDelegation?.ok, false);
  assert.match(duplicateDelegation?.error ?? "", new RegExp(`^delegation_target_already_queued:${buyer.id};`));
  const messagesBeforeTargetFinishes = state.app.rooms.listMessages(roomId, { limit: 20 });
  const delegatedMessages = messagesBeforeTargetFinishes.filter(
    (message) =>
      message.senderId === material.id &&
      message.targetIds.includes(buyer.id) &&
      message.deliveryKind === "agent_delegation",
  );
  assert.equal(delegatedMessages.length, 1, "duplicate guard must reject before writing another ledger message");
  const delegatedMessage = delegatedMessages[0]!;
  assert.equal(delegatedMessage.text, "@投放 请为素材包 pack-real 建投放计划");
  assert.equal(delegatedMessage.inReplyToMessageId, sourcePost.userMessage.id);
  assert.equal(delegatedMessage.rootMessageId, sourcePost.userMessage.id);
  const targetPlaceholder = messagesBeforeTargetFinishes.find((message) => message.runId === delegatedTargetRunId);
  assert.ok(targetPlaceholder);
  assert.equal(targetPlaceholder.status, "running");
  assert.equal(targetPlaceholder.inReplyToMessageId, delegatedMessage.id);
  assert.equal(targetPlaceholder.rootMessageId, sourcePost.userMessage.id);
  assert.match(delegatedTargetInput, /Source: 素材 \(employee delegation\)/);
  assert.match(delegatedTargetInput, /Replying to #\d+ User:/);
  assert.match(delegatedTargetInput, /Read the room ledger before acting/);

  // ===== Tool 契约、真实 source Run 与房间边界 =====
  const tool = state.app.tools.require("room.delegate.task");
  const schema = tool.spec.input.schema as { properties?: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["prompt", "targetMemberId"]);
  assert.deepEqual(schema.required, ["targetMemberId"]);

  const missingSource = await tool.execute(
    {
      targetMemberId: buyer.id,
      prompt: "没有来源 Run",
    },
    undefined as never,
  );
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.error, "source_run_id_required");

  const fakeSource = await tool.execute(
    {
      targetMemberId: buyer.id,
      prompt: "伪造来源 Run",
    },
    { runId: "run-does-not-exist" } as never,
  );
  assert.equal(fakeSource.ok, false);
  assert.equal(fakeSource.error, "source_run_not_found:run-does-not-exist");

  const ordinaryMissingPrompt = await tool.execute(
    {
      targetMemberId: reviewer.id,
    },
    { runId: sourceRunId } as never,
  );
  assert.equal(ordinaryMissingPrompt.ok, false);
  assert.equal(ordinaryMissingPrompt.error, "prompt_required");

  const crossRoom = await tool.execute(
    {
      targetMemberId: outsider.id,
      prompt: "越过当前房间",
    },
    { runId: sourceRunId } as never,
  );
  assert.equal(crossRoom.ok, false);
  assert.equal(crossRoom.error, `target_not_in_source_room:${outsider.id}`);
  assert.equal(
    state.app.rooms
      .listMessages("room-outsider-only", { limit: 20 })
      .some((message) => message.text === "越过当前房间"),
    false,
  );

  const self = await tool.execute(
    {
      targetMemberId: material.id,
      prompt: "给自己派活",
    },
    { runId: sourceRunId } as never,
  );
  assert.equal(self.ok, false);
  assert.equal(self.error, "self_delegation_not_allowed");

  releaseTarget();
  await waitFor(
    () => state.app.rooms.getMessage(roomId, targetPlaceholder.id)?.status === "done",
    "delegated target final reply",
  );
  assert.equal(state.app.rooms.getMessage(roomId, targetPlaceholder.id)?.text, "已接到真实委派。");
  await waitFor(() => Boolean(returnDelegation && returnedRunFinished), "A to B to A async delegation loop");
  assert.equal(returnDelegation?.ok, true, returnDelegation?.error);
  assert.equal((returnDelegation?.value as { state?: string }).state, "TASK_STATE_SUBMITTED");

  // ===== PM 自动路由第一跳、员工后续委派与直接 @PM 反例 =====
  let pmDelegation: ToolResult | undefined;
  let promptlessPmDelegation: ToolResult | undefined;
  let workerDelegation: ToolResult | undefined;
  let routedBuyerInput = "";
  let routedReviewerFinished = false;
  let promptlessBuyerFinished = false;
  roomRunHarness = async function* runPmChainTurn(input: string, options: unknown = {}): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    const executingMemberId = state.app.rooms
      .listMessages(roomId, { limit: 0 })
      .find((message) => message.runId === runId)?.senderId;
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (executingMemberId === pm.id && currentMessageIs(input, "PM_ROUTE_CHAIN")) {
      pmDelegation = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: buyer.id,
          prompt: "@投放 HALLUCINATED_ROUTE_BODY_MUST_BE_IGNORED",
        },
        { runId } as never,
      );
    } else if (executingMemberId === pm.id && currentMessageIs(input, "PM_ROUTE_WITHOUT_PROMPT")) {
      promptlessPmDelegation = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: buyer.id,
        },
        { runId } as never,
      );
    } else if (executingMemberId === buyer.id && currentMessageIs(input, "PM_ROUTE_CHAIN")) {
      routedBuyerInput = input;
      workerDelegation = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 BUYER_TO_REVIEWER",
        },
        { runId } as never,
      );
    } else if (executingMemberId === buyer.id && currentMessageIs(input, "PM_ROUTE_WITHOUT_PROMPT")) {
      promptlessBuyerFinished = true;
    } else if (currentMessageIs(input, "@审核 BUYER_TO_REVIEWER")) {
      assert.match(input, /Source: 投放 \(employee delegation\)/);
      routedReviewerFinished = true;
    } else {
      yield { type: "error", runId, message: `unexpected_input:${input}` } as AgentEvent;
    }
    yield { type: "model.response", runId, response: { text: "路由链处理完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const pmRoutePost = state.app.rooms.postUserMessage({
    roomId,
    text: "PM_ROUTE_CHAIN",
    targetIds: [pm.id],
    assistantTargets: [pm],
    deliveryKind: "pm_auto_route",
    attachments: [
      {
        id: "pm-route-attachment",
        name: "作者附件.txt",
        kind: "text",
        mimeType: "text/plain",
        text: "AUTHOR_ATTACHMENT_BODY",
      },
    ],
    selectedFile: { path: "项目/亿万继承人的囚徒/章节大纲.md" },
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: pmRoutePost.userMessage.id,
    targets: [pm],
    assistantMessages: pmRoutePost.assistantMessages,
  });
  await waitFor(
    () => Boolean(pmDelegation && workerDelegation && routedReviewerFinished),
    "PM to worker to worker chain",
  );
  assert.equal(pmDelegation?.ok, true, pmDelegation?.error);
  assert.equal((pmDelegation?.value as { bodySource?: string } | undefined)?.bodySource, "author_original");
  assert.equal((pmDelegation?.value as { promptIgnored?: boolean } | undefined)?.promptIgnored, true);
  assert.equal(workerDelegation?.ok, true, workerDelegation?.error);
  const pmChainMessages = state.app.rooms.listMessages(roomId, { limit: 50 });
  const pmRoutedMessage = pmChainMessages.find(
    (message) =>
      message.senderId === pm.id && message.targetIds.includes(buyer.id) && message.deliveryKind === "pm_auto_route",
  );
  assert.equal(
    pmRoutedMessage?.text,
    "PM_ROUTE_CHAIN",
    "PM auto-routing must forward the author's original text verbatim",
  );
  assert.equal(
    pmRoutedMessage?.selectedFile,
    undefined,
    "the routed transport message must not copy the author's selected file",
  );
  assert.equal(
    pmRoutedMessage?.attachments,
    undefined,
    "the routed transport message must not copy the author's attachments",
  );
  assert.equal(
    pmChainMessages.filter((message) =>
      message.attachments?.some((attachment) => attachment.id === "pm-route-attachment"),
    ).length,
    1,
    "the author's attachment must be stored only once in the ledger",
  );
  assert.equal(
    pmChainMessages.some((message) => message.text.includes("HALLUCINATED_ROUTE_BODY_MUST_BE_IGNORED")),
    false,
    "a prompt the PM fabricates for auto-routing must not enter the room ledger or the target Run",
  );
  assert.doesNotMatch(routedBuyerInput, /Source:|PM auto-routing|Replying to/);
  assert.match(routedBuyerInput, /Selected file: 项目\/亿万继承人的囚徒\/章节大纲\.md/);
  assert.match(routedBuyerInput, new RegExp(`\\[Current message #${pmRoutePost.userMessage.channelSeq}\\]`));
  assert.equal(routedBuyerInput.split("PM_ROUTE_CHAIN").length - 1, 1);
  assert.equal(
    pmChainMessages.find((message) => message.text === "@审核 BUYER_TO_REVIEWER")?.deliveryKind,
    "agent_delegation",
    "only the first hop initiated by the PM itself is PM auto-routing; subsequent employee delegations must revert to agent_delegation",
  );

  const promptlessPmRoutePost = state.app.rooms.postUserMessage({
    roomId,
    text: "PM_ROUTE_WITHOUT_PROMPT",
    targetIds: [pm.id],
    assistantTargets: [pm],
    deliveryKind: "pm_auto_route",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: promptlessPmRoutePost.userMessage.id,
    targets: [pm],
    assistantMessages: promptlessPmRoutePost.assistantMessages,
  });
  await waitFor(() => Boolean(promptlessPmDelegation && promptlessBuyerFinished), "promptless PM auto-route");
  assert.equal(promptlessPmDelegation?.ok, true, promptlessPmDelegation?.error);
  assert.equal((promptlessPmDelegation?.value as { bodySource?: string } | undefined)?.bodySource, "author_original");
  assert.equal(Object.prototype.hasOwnProperty.call(promptlessPmDelegation?.value ?? {}, "promptIgnored"), false);
  assert.ok(
    state.app.rooms
      .listMessages(roomId, { limit: 100 })
      .some(
        (message) =>
          message.senderId === pm.id &&
          message.targetIds.includes(buyer.id) &&
          message.deliveryKind === "pm_auto_route" &&
          message.text === "PM_ROUTE_WITHOUT_PROMPT",
      ),
  );

  let directPmDelegation: ToolResult | undefined;
  roomRunHarness = async function* runDirectPmTurn(input: string, options: unknown = {}): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "DIRECT_PM_REQUEST")) {
      directPmDelegation = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 DIRECT_PM_TO_REVIEWER",
        },
        { runId } as never,
      );
    }
    yield { type: "model.response", runId, response: { text: "直接 PM 请求处理完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const directPmPost = state.app.rooms.postUserMessage({
    roomId,
    text: "DIRECT_PM_REQUEST",
    targetIds: [pm.id],
    assistantTargets: [pm],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: directPmPost.userMessage.id,
    targets: [pm],
    assistantMessages: directPmPost.assistantMessages,
  });
  await waitFor(() => Boolean(directPmDelegation), "direct PM delegation");
  assert.equal(directPmDelegation?.ok, true, directPmDelegation?.error);
  assert.equal(
    state.app.rooms
      .listMessages(roomId, { limit: 100 })
      .find((message) => message.text === "@审核 DIRECT_PM_TO_REVIEWER")?.deliveryKind,
    "agent_delegation",
    "when the author directly @-mentions the PM, the PM's delegation is an ordinary employee delegation and must not masquerade as Host auto-routing",
  );

  // ===== source Employee 已移出 Room 时拒绝，加回后同 Run 可重试 =====
  let removedSourceFailure: ToolResult | undefined;
  let restoredSourceRetry: ToolResult | undefined;
  let removedSourceMessageCountBefore = -1;
  let removedSourceMessageCountAfter = -1;
  let removedSourceTargetStarted = false;
  let restoredSourceTargetStarted = false;
  roomRunHarness = async function* runRemovedSourceDelegation(
    input: string,
    options: unknown = {},
  ): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "REMOVED_SOURCE_RUN")) {
      const rooms = state.app.rooms;
      const delegationTool = state.app.tools.require("room.delegate.task");
      removedSourceMessageCountBefore = rooms.listMessages(roomId, { limit: 0 }).length;
      rooms.removeMember(roomId, material.id);
      removedSourceFailure = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 REMOVED_SOURCE_SHOULD_NOT_POST",
        },
        { runId } as never,
      );
      removedSourceMessageCountAfter = rooms.listMessages(roomId, { limit: 0 }).length;
      rooms.addMember(roomId, material);
      rooms.patchRoom(roomId, {
        adminMemberIds: [...(rooms.getRoom(roomId)?.adminMemberIds ?? []), material.id],
      });
      restoredSourceRetry = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 RESTORED_SOURCE_RETRY",
        },
        { runId } as never,
      );
    } else if (currentMessageIs(input, "@审核 REMOVED_SOURCE_SHOULD_NOT_POST")) {
      removedSourceTargetStarted = true;
    } else if (currentMessageIs(input, "@审核 RESTORED_SOURCE_RETRY")) {
      restoredSourceTargetStarted = true;
    }
    yield { type: "model.response", runId, response: { text: "source 房间边界测试完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const removedSourcePost = state.app.rooms.postUserMessage({
    roomId,
    text: "REMOVED_SOURCE_RUN",
    targetIds: [material.id],
    assistantTargets: [material],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: removedSourcePost.userMessage.id,
    targets: [material],
    assistantMessages: removedSourcePost.assistantMessages,
  });
  await waitFor(() => Boolean(restoredSourceRetry), "same-Run retry after restoring source Employee to Room");
  assert.equal(removedSourceFailure?.ok, false);
  assert.equal(removedSourceFailure?.error, `source_not_in_source_room:${material.id}`);
  assert.equal(
    removedSourceMessageCountAfter,
    removedSourceMessageCountBefore,
    "when the source is not in the room, the delegation must be rejected before the delegation message and placeholder hit the ledger",
  );
  assert.equal(removedSourceTargetStarted, false, "the target Run must not start when the source is not in the room");
  assert.equal(
    state.app.rooms
      .listMessages(roomId, { limit: 100 })
      .some((message) => message.text === "@审核 REMOVED_SOURCE_SHOULD_NOT_POST"),
    false,
  );
  assert.equal(restoredSourceRetry?.ok, true, restoredSourceRetry?.error);
  await waitFor(() => restoredSourceTargetStarted, "restored source Employee delegation target Run");

  // ===== 无 source Run 的 System/Routine 显式 roomId 路径 =====
  const systemTarget = addEmployee("employee-system-target", "系统任务员工");
  const systemRoomId = "room-system-routine-delegation";
  state.app.rooms.ensureGroupRoom({
    id: systemRoomId,
    title: "系统例程",
    badge: "System",
    memberIds: [systemTarget.id],
  });
  let systemTargetFinished = false;
  roomRunHarness = async function* runSystemDelegationTurn(
    input: string,
    options: unknown = {},
  ): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    assert.match(input, /Source: OpenGrove System/);
    assert.ok(currentMessageIs(input, "执行系统例程任务"));
    systemTargetFinished = true;
    yield { type: "model.response", runId, response: { text: "系统任务完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const systemDelegation = await delegateRoomTask(state, {
    roomId: systemRoomId,
    targetMemberId: systemTarget.id,
    prompt: "执行系统例程任务",
  });
  assert.equal(systemDelegation.ok, true, systemDelegation.error);
  assert.equal((systemDelegation.value as { state?: string }).state, "TASK_STATE_SUBMITTED");
  await waitFor(() => systemTargetFinished, "system routine target Run");
  const systemTrigger = state.app.rooms
    .listMessages(systemRoomId, { limit: 20 })
    .find((message) => message.text === "执行系统例程任务");
  assert.equal(systemTrigger?.senderType, "system");
  assert.equal(systemTrigger?.deliveryKind, "system_routine");

  // ===== 同步排队失败与 target 异步失败 =====
  state.settings.languagePreference = "en";
  let syncScheduleFailure: ToolResult | undefined;
  let syncRetrySubmission: ToolResult | undefined;
  let syncRetryDuplicate: ToolResult | undefined;
  roomRunHarness = async function* runSyncScheduleFailure(
    input: string,
    options: unknown = {},
  ): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "SYNC_SCHEDULE_SOURCE")) {
      const rooms = state.app.rooms;
      const delegationTool = state.app.tools.require("room.delegate.task");
      const originalUpdateMessage = rooms.updateMessage.bind(rooms);
      rooms.updateMessage = ((nextRoomId, messageId, patch) => {
        if (typeof patch.runId === "string") throw new Error("forced_sync_schedule_failure");
        return originalUpdateMessage(nextRoomId, messageId, patch);
      }) as typeof rooms.updateMessage;
      try {
        syncScheduleFailure = await delegationTool.execute(
          {
            targetMemberId: reviewer.id,
            prompt: "@审核 SYNC_SCHEDULE_FAILURE",
          },
          { runId } as never,
        );
      } finally {
        rooms.updateMessage = originalUpdateMessage;
      }
      syncRetrySubmission = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 SYNC_SCHEDULE_RETRY",
        },
        { runId } as never,
      );
      syncRetryDuplicate = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 SYNC_SCHEDULE_DUPLICATE",
        },
        { runId } as never,
      );
    }
    yield { type: "model.response", runId, response: { text: "同步失败测试完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const syncFailurePost = state.app.rooms.postUserMessage({
    roomId,
    text: "SYNC_SCHEDULE_SOURCE",
    targetIds: [material.id],
    assistantTargets: [material],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: syncFailurePost.userMessage.id,
    targets: [material],
    assistantMessages: syncFailurePost.assistantMessages,
  });
  await waitFor(() => Boolean(syncRetryDuplicate), "same-Run retry after synchronous delegation schedule failure");
  assert.equal(syncScheduleFailure?.ok, false);
  assert.match(syncScheduleFailure?.error ?? "", /forced_sync_schedule_failure/);
  assert.equal(syncRetrySubmission?.ok, true, syncRetrySubmission?.error);
  assert.equal(syncRetryDuplicate?.ok, false);
  assert.match(syncRetryDuplicate?.error ?? "", new RegExp(`^delegation_target_already_queued:${reviewer.id};`));
  const syncFailureMessages = state.app.rooms.listMessages(roomId, { limit: 100 });
  const persistedFailedDelegation = syncFailureMessages.find(
    (message) => message.text === "@审核 SYNC_SCHEDULE_FAILURE",
  );
  assert.ok(persistedFailedDelegation, "the delegation message must be kept when synchronous scheduling fails");
  const failedToSchedulePlaceholder = syncFailureMessages.find(
    (message) => message.inReplyToMessageId === persistedFailedDelegation.id && message.senderId === reviewer.id,
  );
  assert.equal(failedToSchedulePlaceholder?.status, "failed");
  assert.equal(failedToSchedulePlaceholder?.text, "The delegated task could not be started.");
  assert.equal(
    syncFailureMessages.filter(
      (message) =>
        message.senderId === material.id &&
        message.targetIds.includes(reviewer.id) &&
        message.deliveryKind === "agent_delegation" &&
        message.text.startsWith("@审核 SYNC_SCHEDULE_"),
    ).length,
    2,
    "the failed delegation and the same-Run retry each write one ledger entry; a duplicate delegation after success must be rejected before it hits the ledger",
  );

  let missingRunIdFailure: ToolResult | undefined;
  let missingRunIdRetry: ToolResult | undefined;
  let missingRunIdDuplicate: ToolResult | undefined;
  roomRunHarness = async function* runMissingRunIdFailure(
    input: string,
    options: unknown = {},
  ): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "MISSING_RUN_ID_SOURCE")) {
      const rooms = state.app.rooms;
      const delegationTool = state.app.tools.require("room.delegate.task");
      const originalCreatePlaceholder = rooms.createAssistantPlaceholder.bind(rooms);
      rooms.createAssistantPlaceholder = ((placeholderInput) => {
        const placeholder = originalCreatePlaceholder(placeholderInput);
        placeholderInput.target.disabled = true;
        return placeholder;
      }) as typeof rooms.createAssistantPlaceholder;
      try {
        missingRunIdFailure = await delegationTool.execute(
          {
            targetMemberId: reviewer.id,
            prompt: "@审核 MISSING_RUN_ID_FAILURE",
          },
          { runId } as never,
        );
      } finally {
        rooms.createAssistantPlaceholder = originalCreatePlaceholder;
      }
      missingRunIdRetry = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 MISSING_RUN_ID_RETRY",
        },
        { runId } as never,
      );
      missingRunIdDuplicate = await delegationTool.execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 MISSING_RUN_ID_DUPLICATE",
        },
        { runId } as never,
      );
    }
    yield { type: "model.response", runId, response: { text: "缺少 Run ID 测试完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const missingRunIdPost = state.app.rooms.postUserMessage({
    roomId,
    text: "MISSING_RUN_ID_SOURCE",
    targetIds: [material.id],
    assistantTargets: [material],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: missingRunIdPost.userMessage.id,
    targets: [material],
    assistantMessages: missingRunIdPost.assistantMessages,
  });
  await waitFor(() => Boolean(missingRunIdDuplicate), "same-Run retry after missing delegated Run ID");
  assert.equal(missingRunIdFailure?.ok, false);
  assert.equal(missingRunIdFailure?.error, `delegated_run_not_scheduled:${reviewer.id}`);
  assert.equal(missingRunIdRetry?.ok, true, missingRunIdRetry?.error);
  assert.equal(missingRunIdDuplicate?.ok, false);
  assert.match(missingRunIdDuplicate?.error ?? "", new RegExp(`^delegation_target_already_queued:${reviewer.id};`));
  assert.equal(
    state.app.rooms
      .listMessages(roomId, { limit: 100 })
      .filter(
        (message) =>
          message.senderId === material.id &&
          message.targetIds.includes(reviewer.id) &&
          message.deliveryKind === "agent_delegation" &&
          message.text.startsWith("@审核 MISSING_RUN_ID_"),
      ).length,
    2,
    "the failed delegation with a missing Run ID and the same-Run retry each write one ledger entry",
  );

  let asyncFailureSubmission: ToolResult | undefined;
  roomRunHarness = async function* runAsyncTargetFailure(
    input: string,
    options: unknown = {},
  ): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "ASYNC_FAILURE_SOURCE")) {
      asyncFailureSubmission = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: reviewer.id,
          prompt: "@审核 ASYNC_TARGET_FAILURE",
        },
        { runId } as never,
      );
      yield { type: "model.response", runId, response: { text: "异步任务已提交。" } } as AgentEvent;
    } else if (currentMessageIs(input, "@审核 ASYNC_TARGET_FAILURE")) {
      yield { type: "error", runId, message: "forced_async_target_failure" } as AgentEvent;
    }
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const asyncFailurePost = state.app.rooms.postUserMessage({
    roomId,
    text: "ASYNC_FAILURE_SOURCE",
    targetIds: [material.id],
    assistantTargets: [material],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: asyncFailurePost.userMessage.id,
    targets: [material],
    assistantMessages: asyncFailurePost.assistantMessages,
  });
  await waitFor(() => Boolean(asyncFailureSubmission), "asynchronous target failure submission");
  assert.equal(asyncFailureSubmission?.ok, true, asyncFailureSubmission?.error);
  const asyncSubmittedMessageId = (asyncFailureSubmission?.value as { messageId?: string }).messageId;
  assert.ok(asyncSubmittedMessageId);
  await waitFor(
    () => state.app.rooms.getMessage(roomId, asyncSubmittedMessageId)?.status === "failed",
    "asynchronous target failure bubble",
  );
  assert.equal(
    state.app.rooms.getMessage(roomId, asyncSubmittedMessageId)?.text,
    "This run failed. Check the run details.",
  );
  assert.equal(
    state.app.rooms
      .listMessages(roomId, { limit: 100 })
      .some(
        (message) =>
          message.senderId === reviewer.id &&
          message.targetIds.includes(material.id) &&
          message.deliveryKind === "agent_delegation" &&
          message.createdAt >= asyncFailurePost.userMessage.createdAt,
      ),
    false,
    "an asynchronous target failure must not automatically call back the source",
  );

  // ===== 单 Run 重复/累计委派刹车 =====
  const fanoutSource = addEmployee("employee-fanout-source", "分发员");
  const fanoutOne = addEmployee("employee-fanout-one", "员工一");
  const fanoutTwo = addEmployee("employee-fanout-two", "员工二");
  const fanoutThree = addEmployee("employee-fanout-three", "员工三");
  const fanoutRoomId = "room-delegation-run-limit";
  state.app.rooms.ensureGroupRoom({
    id: fanoutRoomId,
    title: "委派总量上限",
    badge: "Test",
    memberIds: [fanoutSource.id, fanoutOne.id, fanoutTwo.id, fanoutThree.id],
    adminMemberIds: [fanoutSource.id],
  });
  const priorMaxPerRun = state.settings.roomCollaboration.maxDelegationsPerRun;
  state.settings.roomCollaboration.maxDelegationsPerRun = 2;
  let fanoutResults: ToolResult[] = [];
  roomRunHarness = async function* runFanoutTurn(input: string, options: unknown = {}): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (input.includes("[Current message #") && currentMessageIs(input, "@分发员 FANOUT_THREE")) {
      const fanoutTool = state.app.tools.require("room.delegate.task");
      fanoutResults = [];
      for (const target of [fanoutOne, fanoutTwo, fanoutThree]) {
        fanoutResults.push(
          await fanoutTool.execute(
            {
              targetMemberId: target.id,
              prompt: `@${target.name} FANOUT_TASK_${target.id}`,
            },
            { runId } as never,
          ),
        );
      }
      yield { type: "model.response", runId, response: { text: "已完成允许范围内的分发。" } } as AgentEvent;
    } else {
      yield { type: "model.response", runId, response: { text: "已接收。" } } as AgentEvent;
    }
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const fanoutPost = state.app.rooms.postUserMessage({
    roomId: fanoutRoomId,
    text: "@分发员 FANOUT_THREE",
    targetIds: [fanoutSource.id],
    assistantTargets: [fanoutSource],
    deliveryKind: "user_direct",
  });
  scheduleRoomAssistantRuns(state, {
    roomId: fanoutRoomId,
    triggerMessageId: fanoutPost.userMessage.id,
    targets: [fanoutSource],
    assistantMessages: fanoutPost.assistantMessages,
  });
  await waitFor(() => fanoutResults.length === 3, "per-Run delegation limit results");
  assert.equal(fanoutResults[0]?.ok, true);
  assert.equal(fanoutResults[1]?.ok, true);
  assert.equal(fanoutResults[2]?.ok, false);
  assert.match(fanoutResults[2]?.error ?? "", /^delegation_run_limit_reached;/);
  assert.equal(
    state.app.rooms
      .listMessages(fanoutRoomId, { limit: 50 })
      .filter((message) => message.senderId === fanoutSource.id && message.deliveryKind === "agent_delegation").length,
    2,
    "the per-Run hard limit must reject before writing a third delegation message",
  );
  state.settings.roomCollaboration.maxDelegationsPerRun = priorMaxPerRun;

  // ===== 委派链深刹车 =====
  const chainRoomId = "room-delegation-chain-limit";
  state.app.rooms.ensureGroupRoom({
    id: chainRoomId,
    title: "委派链深上限",
    badge: "Test",
    memberIds: [material.id, buyer.id],
    adminMemberIds: [material.id, buyer.id],
  });
  const chainRoot = state.app.rooms.postUserMessage({
    roomId: chainRoomId,
    text: "开始五手委派链",
    targetIds: [material.id],
    deliveryKind: "user_direct",
  }).userMessage;
  let chainParent = chainRoot;
  for (let index = 1; index <= 5; index += 1) {
    const sender = index % 2 === 1 ? buyer : material;
    const target = index % 2 === 1 ? material : buyer;
    chainParent = state.app.rooms.postAgentMessage({
      roomId: chainRoomId,
      senderId: sender.id,
      senderName: sender.name,
      text: index === 5 ? "@素材 DEEP_SOURCE" : `第 ${index} 手委派`,
      targetIds: [target.id],
      deliveryKind: "agent_delegation",
      inReplyToMessageId: chainParent.id,
      rootMessageId: chainRoot.id,
    });
  }
  const deepSourcePlaceholder = state.app.rooms.createAssistantPlaceholder({
    roomId: chainRoomId,
    target: material,
    inReplyToMessageId: chainParent.id,
    rootMessageId: chainRoot.id,
  });
  let chainLimitResult: ToolResult | undefined;
  roomRunHarness = async function* runChainLimitTurn(input: string, options: unknown = {}): AsyncIterable<AgentEvent> {
    const runId = (options as AgentTurnRequest).runId ?? "missing-run";
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (currentMessageIs(input, "@素材 DEEP_SOURCE")) {
      chainLimitResult = await state.app.tools.require("room.delegate.task").execute(
        {
          targetMemberId: buyer.id,
          prompt: "@投放 第六手不应落账",
        },
        { runId } as never,
      );
    }
    yield { type: "model.response", runId, response: { text: "链深检查完成。" } } as AgentEvent;
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  const beforeChainLimit = state.app.rooms.listMessages(chainRoomId, { limit: 0 }).length;
  scheduleRoomAssistantRuns(state, {
    roomId: chainRoomId,
    triggerMessageId: chainParent.id,
    targets: [material],
    assistantMessages: [deepSourcePlaceholder],
  });
  await waitFor(() => Boolean(chainLimitResult), "delegation chain limit result");
  assert.equal(chainLimitResult?.ok, false);
  assert.match(chainLimitResult?.error ?? "", /^delegation_chain_limit_reached;/);
  assert.equal(
    state.app.rooms.listMessages(chainRoomId, { limit: 0 }).length,
    beforeChainLimit,
    "the sixth handoff must be rejected before writing a message or placeholder",
  );

  console.log("room-delegation-harness passed");

  function addEmployee(
    id: string,
    name: string,
    defaultSkillIds?: string[],
    employeeDefinitionId?: string,
  ): RoomChannelMember {
    return state.app.rooms.upsertMember({
      id,
      employeeDefinitionId,
      name,
      kernel: state.kernel,
      model: state.model,
      providerId: "deepseek",
      role: `${name} test employee`,
      status: "idle",
      color: "#2563eb",
      lastActive: "now",
      source: "local",
      defaultSkillIds,
    });
  }
} finally {
  await store?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
