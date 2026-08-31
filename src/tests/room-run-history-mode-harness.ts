import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAssistantFinalEvent, resolveChatFinalAnswer, type ToolCallContext, type ToolSpec } from "../core.js";
import { hostMessage } from "../localization/host-messages.js";
import type { BridgeState } from "../server/bridge-types.js";
import {
  GROVE_GUIDE_MEMBER_ID,
  RoomChannelStore,
  type RoomChannelMember,
  type RoomChannelMessage,
} from "../rooms/channel-store.js";
import { normalizeRoomLedgerReadValue, serializeRoomLedgerMessage } from "../rooms/ledger-view.js";
import { resolveSessionHistoryMode, sessionHistoryModeForCapabilities } from "../kernel/session-history-mode.js";
import { createRoomLedgerReadTool, withRoomLedgerAccessForRun } from "../tools/rooms.js";
import { createRoomLedgerCapability, revokeRoomLedgerCapability } from "../server/room-ledger-capabilities.js";
import { handleRoomLedgerCapabilityRoute } from "../server/routes/room-ledger.js";
import {
  buildRoomRunPageSnapshot,
  persistedRoomRunParts,
  requiredRoomSkillNames,
  roomRunPolicy,
  roomRunRequestedEffort,
  roomRunResponseSpeed,
} from "../server/room-runs.js";
import { recentSessionPromptBlock } from "../runtime/session-history.js";

const member: RoomChannelMember = {
  id: "employee-codex",
  name: "Codex",
  kernel: "codex",
  model: "gpt-5.4",
  role: "",
  status: "idle",
  color: "#2563eb",
  lastActive: "now",
  source: "local",
};

const imageAttachment = {
  id: "attachment-image-png",
  name: "image.png",
  kind: "image" as const,
  mimeType: "image/png",
  size: 68,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
};
const oversizedAttachmentText = `PRIVATE_ATTACHMENT_TEXT_MUST_NOT_LEAK_${"x".repeat(100_000)}`;
const oversizedAttachmentDataUrl = `data:text/plain;base64,${"Y".repeat(100_000)}`;
const roomRunSnapshot = buildRoomRunPageSnapshot({
  roomId: "room-grove",
  visibleText: "帮我检查这个任务。",
  attachments: [imageAttachment],
});
assert.equal(roomRunSnapshot.attachments?.length, 1);
assert.deepEqual(roomRunSnapshot.attachments?.[0], imageAttachment);
// The image dataUrl must survive into the snapshot — this is the hop that
// feeds context.page.attachments. The runtime converting it into an actual
// model image block is asserted in claude-agent-sdk-runtime-harness.
assert.equal(
  roomRunSnapshot.attachments?.[0]?.dataUrl,
  "data:image/png;base64,iVBORw0KGgo=",
  "room run snapshot must carry the image dataUrl, not just metadata",
);
roomRunSnapshot.attachments![0]!.name = "mutated.png";
assert.equal(imageAttachment.name, "image.png");

const groveMember: RoomChannelMember = {
  id: GROVE_GUIDE_MEMBER_ID,
  name: "Grove",
  kernel: "codex",
  model: "opengrove-guide",
  role: "Guide OpenGrove setup.",
  status: "idle",
  color: "#168A53",
  lastActive: "now",
  source: "local",
  defaultSkillIds: ["grove-guide"],
};
assert.deepEqual(requiredRoomSkillNames(groveMember), ["grove-guide"]);

// Employee defaults are mandatory Skill requirements, not a Room prompt index.
// Normalize them here; createOpenGrove tells native Kernels to load them before acting.
const indexedSkillsMember: RoomChannelMember = {
  ...groveMember,
  id: "employee-indexed",
  name: "Indexed",
  defaultSkillIds: [" indexed-skill ", "locked-skill", "indexed-skill"],
};
assert.deepEqual(requiredRoomSkillNames(indexedSkillsMember), ["indexed-skill", "locked-skill"]);
const kernelOwnedHistory = { sessionHistory: "kernel" } as const;
const hostOwnedHistory = { sessionHistory: "host" } as const;
assert.equal(sessionHistoryModeForCapabilities(kernelOwnedHistory), "native");
assert.equal(resolveSessionHistoryMode(kernelOwnedHistory), "native");
assert.equal(
  resolveSessionHistoryMode(kernelOwnedHistory, "app"),
  "native",
  "callers must not replay Host history into a native Kernel session",
);
assert.equal(resolveSessionHistoryMode(hostOwnedHistory), "app");
assert.equal(resolveSessionHistoryMode(hostOwnedHistory, "native"), "native");
assert.equal(roomRunResponseSpeed(), "fast");
assert.equal(roomRunRequestedEffort(member, "ping"), "medium");
assert.equal(roomRunRequestedEffort({ ...member, reasoningEffort: "high" }, "ping"), "high");
const highDefaultReasoningControls = {
  reasoningEfforts: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  defaultReasoningEffort: "high",
};
assert.equal(
  roomRunRequestedEffort(
    {
      ...member,
      appId: "story-seed",
      manifestDefaults: { reasoningEffort: "low" },
    },
    "ping",
    highDefaultReasoningControls,
  ),
  "low",
  "an unset user choice must inherit a compatible App default",
);
assert.equal(
  roomRunRequestedEffort(
    {
      ...member,
      appId: "story-seed",
      manifestDefaults: { reasoningEffort: "max" },
    },
    "ping",
    highDefaultReasoningControls,
  ),
  "high",
  "an incompatible App default must fall back to the Kernel default",
);
assert.equal(
  roomRunRequestedEffort(member, "ping", highDefaultReasoningControls),
  "high",
  "an Employee without user or App defaults must inherit the Kernel default",
);
assert.equal(
  roomRunRequestedEffort(
    {
      ...member,
      reasoningEffort: "high",
      appId: "story-seed",
      manifestDefaults: { reasoningEffort: "low" },
      userOverrides: ["reasoningEffort"],
    },
    "ping",
    highDefaultReasoningControls,
  ),
  "high",
  "an explicit user choice must win over App and Kernel defaults",
);
assert.equal(
  resolveChatFinalAnswer([
    { type: "assistant.delta", runId: "run-final-only", text: "我先读记录。" },
    {
      type: "assistant.final",
      runId: "run-final-only",
      text: "QA_LEDGER_ZHAO_ALPHA",
      at: new Date(0).toISOString(),
      source: "runtime",
    },
  ] as any),
  "QA_LEDGER_ZHAO_ALPHA",
);
assert.equal(
  resolveChatFinalAnswer([
    { type: "assistant.delta", runId: "run-delta-only", text: "QA_LEDGER_ZHAO_ALPHA" },
    {
      type: "tool.finished",
      runId: "run-delta-only",
      toolId: "room.ledger.read",
      result: { ok: true, value: { messages: [] } },
    },
  ] as any),
  hostMessage("en", "agent.final_missing"),
);
assert.equal(
  resolveChatFinalAnswer([
    { type: "error", runId: "run-error-only", message: "room_ledger_read_failed:http_403" },
  ] as any),
  hostMessage("en", "agent.run_failed"),
);
const synthesizedFinal = createAssistantFinalEvent(
  [
    {
      type: "assistant.delta",
      runId: "run-synth-final",
      text: "读取当前房间历史，定位最近一条以指定口令开头的非 @ 消息。",
    },
    { type: "model.response", runId: "run-synth-final", response: { text: "QAONLINESTATUSFIX202606070844" } },
  ] as any,
  { runId: "run-synth-final", at: new Date(1).toISOString(), source: "adapter" },
);
assert.equal(synthesizedFinal?.type, "assistant.final");
assert.equal(synthesizedFinal?.text, "QAONLINESTATUSFIX202606070844");
assert.equal(
  resolveChatFinalAnswer([
    { type: "assistant.delta", runId: "run-synth-final", text: "读取当前房间历史。" },
    synthesizedFinal!,
  ] as any),
  "QAONLINESTATUSFIX202606070844",
);
// Keyword-based import-intent routing is removed: no prompt text may force-load
// the app-import skill, pre-authorize opengrove.app.import, or alter effort.
const importCapableMember: RoomChannelMember = {
  id: "member-employee-imports",
  name: "小周",
  kernel: "codex",
  model: "gpt-5.5",
  role: "Import and package OpenGrove Apps.",
  status: "idle",
  color: "#7c3aed",
  lastActive: "now",
  source: "local",
  defaultSkillIds: ["app-import"],
};
assert.deepEqual(requiredRoomSkillNames(importCapableMember), ["app-import"]);
assert.equal(roomRunRequestedEffort(importCapableMember, "ping"), "medium");
assert.equal(roomRunRequestedEffort(importCapableMember, "帮我把这个目录做成 App"), "medium");
const ordinaryRoomPrompt = "@故事架构师 不要改内容了，只改格式。";
assert.equal(roomRunPolicy(importCapableMember, ordinaryRoomPrompt), undefined);
// Regression: mounted-app context headers must never trigger implicit skill routing.
const mountedContextPrompt =
  "OpenGrove Mounted App Context\nApp: 故事种子 (story-seed)\n@故事架构师 不要改内容了，只改格式。";
assert.equal(roomRunPolicy(importCapableMember, mountedContextPrompt), undefined);
assert.deepEqual(requiredRoomSkillNames(importCapableMember), ["app-import"]);

const nativeHistory = recentSessionPromptBlock(fakeTurnRequest("native"));
assert.equal(nativeHistory, "");

const appHistory = recentSessionPromptBlock(fakeTurnRequest("app"));
assert.match(appHistory, /Recent OpenGrove thread history/);
assert.match(appHistory, /User: first user turn/);
assert.match(appHistory, /Assistant: first assistant reply/);

const persistedParts = persistedRoomRunParts(
  [
    {
      type: "skill.invoked",
      runId: "run-persist",
      skill: {
        id: "skill-app-creator",
        name: "app-creator",
        title: "app-creator",
        description: "Import apps",
        format: "markdown-v1",
        entry: "SKILL.md",
        skillRoot: "/tmp/app-creator",
        activities: ["chat"],
        toolIds: ["opengrove.app.import"],
        memoryHooks: [],
        allowedTools: ["opengrove.app.import"],
        userInvocable: false,
        disableModelInvocation: false,
        context: "inline",
        source: "bundled",
        trust: "trusted",
      },
      invocation: {
        skillId: "skill-app-creator",
        skillName: "app-creator",
        title: "app-creator",
        content: "Import apps",
        contentPreview: "Import apps",
        sourcePath: "/tmp/app-creator/SKILL.md",
        source: "bundled",
        trust: "trusted",
        context: "inline",
        allowedTools: ["opengrove.app.import"],
        invokedAt: new Date(0).toISOString(),
        origin: "model",
      },
    },
    {
      type: "tool.started",
      runId: "run-persist",
      toolId: "opengrove.app.import",
      callId: "call-app-import",
      input: { source: "/tmp/app" },
    },
    {
      type: "tool.finished",
      runId: "run-persist",
      toolId: "opengrove.app.import",
      callId: "call-app-import",
      result: { ok: true, value: { mounted: { id: "demo" } } },
    },
    {
      type: "reasoning.started",
      runId: "run-persist",
      reasoning: { id: "reasoning-1", kind: "summary", kernelId: "codex" },
    },
    {
      type: "reasoning.completed",
      runId: "run-persist",
      reasoning: {
        id: "reasoning-1",
        kind: "summary",
        kernelId: "codex",
        text: "已形成计划",
        elapsedMs: 8000,
      },
    },
    {
      type: "assistant.status",
      runId: "run-persist",
      at: new Date(0).toISOString(),
      text: "Codex native commentary",
      data: {
        source: { type: "kernel.native", kernelId: "codex" },
        kind: "agent_message",
        phase: "commentary",
        itemId: "assistant-commentary",
      },
    },
    {
      type: "assistant.status",
      runId: "run-persist",
      at: new Date(0).toISOString(),
      text: "Claude SDK native commentary",
      data: {
        source: "claude-sdk",
        kind: "agent_message",
        phase: "commentary",
        claudeKind: "tool_use_preamble",
        stopReason: "tool_use",
      },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-persist",
      at: new Date(0).toISOString(),
      name: "claude.sdk.hook_started",
      data: { subtype: "hook_started", hook: "preToolUse" },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-persist",
      at: new Date(0).toISOString(),
      name: "claude.sdk.hook_response",
      data: { subtype: "hook_response", hook: "preToolUse", response: { ok: true } },
    },
    { type: "tool.started", runId: "run-persist", toolId: "room.ledger.read", input: { roomId: "room-grove" } },
    {
      type: "tool.finished",
      runId: "run-persist",
      toolId: "room.ledger.read",
      result: { ok: true, value: { messages: [] } },
    },
    { type: "turn.finished", runId: "run-persist", at: new Date(1).toISOString() },
  ],
  "run-persist",
);
assert.ok(persistedParts.some((part) => part.type === "skill" && part.skillName === "app-creator"));
assert.ok(
  persistedParts.some(
    (part) => part.type === "tool" && part.toolId === "opengrove.app.import" && part.status === "complete",
  ),
);
assert.equal(persistedParts.filter((part) => part.type === "tool" && part.callId === "call-app-import").length, 2);
assert.ok(
  persistedParts.some(
    (part) =>
      part.type === "reasoning" &&
      part.reasoningId === "reasoning-1" &&
      part.kind === "summary" &&
      part.text === "已形成计划" &&
      part.elapsedMs === 8000 &&
      part.status === "complete",
  ),
);
assert.equal(
  persistedParts.some((part) => part.type === "tool" && part.toolId === "codex.reasoning"),
  false,
);
const persistedCodexCommentaryPart = persistedParts.find(
  (part) => part.type === "note" && part.text === "Codex native commentary",
);
assert.equal((persistedCodexCommentaryPart?.data as any)?.phase, "commentary");
const persistedClaudeCommentaryPart = persistedParts.find(
  (part) => part.type === "note" && part.text === "Claude SDK native commentary",
);
assert.equal((persistedClaudeCommentaryPart?.data as any)?.source, "claude-sdk");
assert.equal((persistedClaudeCommentaryPart?.data as any)?.phase, "commentary");
assert.equal((persistedClaudeCommentaryPart?.data as any)?.claudeKind, "tool_use_preamble");
assert.equal(
  persistedParts.some((part) => part.type === "note" && String(part.text).includes("claude.sdk.hook_")),
  false,
);
assert.equal(
  persistedParts.some((part) => part.type === "tool" && part.toolId === "room.ledger.read"),
  false,
);

const persistedConnectorParts = persistedRoomRunParts(
  [
    {
      type: "runtime.diagnostic",
      runId: "run-connector-persist",
      at: new Date(0).toISOString(),
      name: "cloud_connector.dispatch",
      data: { runtime: "codex" },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-connector-persist",
      at: new Date(0).toISOString(),
      name: "cloud_connector.run_status",
      data: { status: "running" },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-connector-persist",
      at: new Date(0).toISOString(),
      name: "cloud_connector.activity",
      data: { text: "Run started" },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-connector-persist",
      at: new Date(0).toISOString(),
      name: "cloud_connector.activity",
      data: { text: "Tool started: codex.reasoning" },
    },
    {
      type: "runtime.diagnostic",
      runId: "run-connector-persist",
      at: new Date(0).toISOString(),
      name: "cloud_connector.activity",
      data: { text: "Tool started: host.ui.requestChoices" },
    },
  ],
  "run-connector-persist",
);
assert.deepEqual(
  persistedConnectorParts.map((part) => part.text),
  [],
);
assert.doesNotMatch(JSON.stringify(persistedConnectorParts), /cloud_connector|codex\.reasoning/);

const ledgerRooms = new RoomChannelStore();
const ledgerMember: RoomChannelMember = {
  ...member,
  id: "member-zhao-qa",
  name: "小赵QA",
  kernel: "private-kernel-must-not-leak",
  model: "private-model-must-not-leak",
  role: "PRIVATE_LEDGER_ROLE_MUST_NOT_LEAK",
  appId: "private-app-id-must-not-leak",
};
ledgerRooms.upsertMember(ledgerMember, { emitEvent: false });
const ledgerRoom = ledgerRooms.createRoom({
  id: "room-ledger-qa",
  title: "Ledger QA",
  memberIds: [ledgerMember.id],
});
const localLedgerFullText = `LOCAL_LEDGER_FULL_BODY_${"正文".repeat(6_000)}_END`;
ledgerRooms.postAgentMessage({
  roomId: ledgerRoom.id,
  senderId: ledgerMember.id,
  senderName: ledgerMember.name,
  text: localLedgerFullText,
  targetIds: [ledgerMember.id],
  deliveryKind: "agent_delegation",
  inReplyToMessageId: "message-local-parent",
  rootMessageId: "message-local-root",
  selectedFile: { path: "项目/长安客/章节大纲.md" },
});
const ledgerTool = createRoomLedgerReadTool(roomLedgerToolSpec(), ledgerRooms);
const ledgerToolContext = {} as ToolCallContext;
const attachmentLedgerPost = ledgerRooms.postUserMessage({
  roomId: ledgerRoom.id,
  text: "IMAGE_LEDGER_ATTACHMENT_MARKER",
  targetIds: [ledgerMember.id],
  attachments: [imageAttachment],
  deliveryKind: "pm_auto_route",
  inReplyToMessageId: "message-attachment-parent",
  rootMessageId: "message-attachment-root",
  selectedFile: { path: "项目/长安客/附件.md" },
});
ledgerRooms.postUserMessage({
  roomId: ledgerRoom.id,
  text: "OVERSIZED_LEDGER_ATTACHMENT_MARKER",
  targetIds: [ledgerMember.id],
  attachments: [
    {
      id: "attachment-oversized",
      name: "private.txt",
      kind: "text",
      mimeType: "text/plain",
      size: 100_000,
      text: oversizedAttachmentText,
      dataUrl: oversizedAttachmentDataUrl,
      localPath: "/opt/opengrove/private.txt",
    },
  ],
});
for (const marker of ["LEDGER_PAGE_3", "LEDGER_PAGE_4", "LEDGER_PAGE_5"]) {
  ledgerRooms.postUserMessage({
    roomId: ledgerRoom.id,
    text: marker,
    targetIds: [ledgerMember.id],
  });
}
ledgerRooms.patchMember(ledgerMember.id, {
  disabled: true,
  status: "offline",
  lastActive: "已移除",
});
const exactLedger = await ledgerTool.execute(
  { roomId: ledgerRoom.id, query: "LOCAL_LEDGER_FULL_BODY", limit: 10 },
  ledgerToolContext,
);
const missingLedger = await ledgerTool.execute(
  { roomId: "room-other", query: "LOCAL_LEDGER_FULL_BODY", limit: 10 },
  ledgerToolContext,
);
const attachmentLedger = await ledgerTool.execute(
  { roomId: ledgerRoom.id, query: "IMAGE_LEDGER_ATTACHMENT", limit: 10 },
  ledgerToolContext,
);
const oversizedAttachmentLedger = await ledgerTool.execute(
  { roomId: ledgerRoom.id, query: "OVERSIZED_LEDGER_ATTACHMENT", limit: 10 },
  ledgerToolContext,
);
const attachmentSearchLedger = await ledgerTool.execute(
  { roomId: ledgerRoom.id, query: "图片", limit: 10 },
  ledgerToolContext,
);
const memberStatusLedger = await ledgerTool.execute(
  {
    roomId: ledgerRoom.id,
    query: "LOCAL_LEDGER_FULL_BODY",
    limit: 10,
    includeMembers: true,
  },
  ledgerToolContext,
);
assert.equal(exactLedger.ok, true);
assert.equal(missingLedger.ok, false);
assert.equal(attachmentLedger.ok, true);
assert.equal(oversizedAttachmentLedger.ok, true);
assert.equal(attachmentSearchLedger.ok, true);
assert.equal(memberStatusLedger.ok, true);
type LedgerMemberStatus = Pick<RoomChannelMember, "id" | "name" | "status" | "lastActive" | "disabled">;
type LedgerValue = {
  sourceRoomId: string;
  messages: RoomChannelMessage[];
  members?: LedgerMemberStatus[];
};
const exactLedgerValue = exactLedger.value as unknown as LedgerValue;
const attachmentLedgerValue = attachmentLedger.value as unknown as LedgerValue;
const oversizedAttachmentLedgerValue = oversizedAttachmentLedger.value as unknown as LedgerValue;
const memberStatusLedgerValue = memberStatusLedger.value as unknown as LedgerValue;
assert.deepEqual(Object.keys(exactLedgerValue), ["sourceRoomId", "messages"]);
assert.equal(exactLedgerValue.sourceRoomId, ledgerRoom.id);
assert.equal(exactLedgerValue.messages[0]?.text, localLedgerFullText);
assert.equal(exactLedgerValue.messages[0]?.updatedAt, undefined);
assert.equal(exactLedgerValue.messages[0]?.runId, undefined);
assert.equal(exactLedgerValue.messages[0]?.parts, undefined);
assert.equal(exactLedgerValue.messages[0]?.deliveryKind, "agent_delegation");
assert.equal(exactLedgerValue.messages[0]?.inReplyToMessageId, "message-local-parent");
assert.equal(exactLedgerValue.messages[0]?.rootMessageId, "message-local-root");
assert.deepEqual(exactLedgerValue.messages[0]?.selectedFile, { path: "项目/长安客/章节大纲.md" });
assert.equal(exactLedgerValue.members, undefined);
assert.deepEqual(memberStatusLedgerValue.members, [
  {
    id: ledgerMember.id,
    name: ledgerMember.name,
    status: "offline",
    lastActive: "已移除",
    disabled: true,
  },
]);
assert.equal(memberStatusLedgerValue.sourceRoomId, ledgerRoom.id);
assert.doesNotMatch(
  JSON.stringify(memberStatusLedger.value),
  /PRIVATE_LEDGER_ROLE_MUST_NOT_LEAK|private-kernel-must-not-leak|private-model-must-not-leak|private-app-id-must-not-leak/,
);
assert.deepEqual(attachmentLedgerValue.messages[0]?.attachments?.[0], imageAttachment);
assert.deepEqual(oversizedAttachmentLedgerValue.messages[0]?.attachments?.[0], {
  id: "attachment-oversized",
  name: "private.txt",
  kind: "text",
  mimeType: "text/plain",
  size: 100_000,
});
assert.doesNotMatch(
  JSON.stringify(oversizedAttachmentLedger.value),
  /PRIVATE_ATTACHMENT_TEXT_MUST_NOT_LEAK|opt\/opengrove/,
);
assert.match(JSON.stringify(attachmentSearchLedger.value), /IMAGE_LEDGER_ATTACHMENT_MARKER/);

const serializedAttachmentMessage = serializeRoomLedgerMessage(attachmentLedgerPost.userMessage);
const normalizedAttachmentRoundTrip = normalizeRoomLedgerReadValue(
  {
    sourceRoomId: ledgerRoom.id,
    messages: [serializedAttachmentMessage],
  },
  false,
) as unknown as LedgerValue;
assert.deepEqual(normalizedAttachmentRoundTrip, {
  sourceRoomId: ledgerRoom.id,
  messages: [serializedAttachmentMessage],
});
assert.deepEqual(
  Object.keys(normalizedAttachmentRoundTrip.messages[0] ?? {}).sort(),
  Object.keys(serializedAttachmentMessage).sort(),
);

const latestLedgerPage = await ledgerTool.execute({ roomId: ledgerRoom.id, limit: 2 }, ledgerToolContext);
const middleLedgerPage = await ledgerTool.execute({ roomId: ledgerRoom.id, beforeSeq: 4, limit: 2 }, ledgerToolContext);
const oldestLedgerPage = await ledgerTool.execute({ roomId: ledgerRoom.id, beforeSeq: 2, limit: 2 }, ledgerToolContext);
const afterLedgerBoundary = await ledgerTool.execute(
  { roomId: ledgerRoom.id, afterSeq: 4, limit: 2 },
  ledgerToolContext,
);
const latestLedgerMessages = (latestLedgerPage.value as unknown as LedgerValue).messages;
const middleLedgerMessages = (middleLedgerPage.value as unknown as LedgerValue).messages;
const oldestLedgerMessages = (oldestLedgerPage.value as unknown as LedgerValue).messages;
const afterLedgerMessages = (afterLedgerBoundary.value as unknown as LedgerValue).messages;
assert.deepEqual(
  latestLedgerMessages.map((message) => message.channelSeq),
  [5, 6],
);
assert.deepEqual(
  middleLedgerMessages.map((message) => message.channelSeq),
  [2, 3],
);
assert.deepEqual(
  oldestLedgerMessages.map((message) => message.channelSeq),
  [1],
);
assert.equal(oldestLedgerMessages[0]?.text, localLedgerFullText);
assert.deepEqual(
  afterLedgerMessages.map((message) => message.channelSeq),
  [5, 6],
);

ledgerRooms.postSystemTargetedMessage({
  roomId: ledgerRoom.id,
  senderName: "平台",
  text: "LOCAL_INTERNAL_HANDOFF_MUST_NOT_LEAK",
  targetIds: [ledgerMember.id],
  audience: "internal",
  deliveryKind: "system_routine",
});
const internalLedger = await ledgerTool.execute(
  {
    roomId: ledgerRoom.id,
    query: "LOCAL_INTERNAL_HANDOFF_MUST_NOT_LEAK",
    limit: 10,
  },
  ledgerToolContext,
);
assert.equal(internalLedger.ok, true);
assert.deepEqual((internalLedger.value as unknown as LedgerValue).messages, []);

const routeLedgerRooms = new RoomChannelStore();
const routeMember = routeLedgerRooms.upsertMember({ ...member, id: "employee-route-ledger" });
const routeRoom = routeLedgerRooms.createRoom({
  id: "room-route-ledger-qa",
  title: "Route Ledger QA",
  memberIds: [routeMember.id],
});
const routeLedgerFullText = `ROUTE_LEDGER_FULL_BODY_${"完整正文".repeat(4_000)}_END`;
routeLedgerRooms.postUserMessage({
  roomId: routeRoom.id,
  text: routeLedgerFullText,
  targetIds: [routeMember.id],
  deliveryKind: "pm_auto_route",
  inReplyToMessageId: "message-route-parent",
  rootMessageId: "message-route-root",
  selectedFile: { path: "项目/长安客/故事设计.md" },
  attachments: [imageAttachment],
});
routeLedgerRooms.postSystemTargetedMessage({
  roomId: routeRoom.id,
  senderName: "平台",
  text: "ROUTE_INTERNAL_HANDOFF_MUST_NOT_LEAK",
  targetIds: [routeMember.id],
  audience: "internal",
  deliveryKind: "system_routine",
});
const routeCapability = createRoomLedgerCapability({
  runId: "run-route-ledger",
  sourceRoomId: "room-route-ledger-qa",
  readUrl: "http://127.0.0.1/room-ledger/read",
});
const routeLedgerServer = createServer(async (request, response) => {
  const handled = await handleRoomLedgerCapabilityRoute({
    request,
    response,
    url: new URL(request.url ?? "/", "http://127.0.0.1"),
    state: { app: { rooms: routeLedgerRooms } } as BridgeState,
    sendJson(target, status, data) {
      target.writeHead(status, { "content-type": "application/json" });
      target.end(JSON.stringify(data));
    },
    readJsonBody(target) {
      return new Promise((resolve) => {
        let body = "";
        target.setEncoding("utf8");
        target.on("data", (chunk) => {
          body += chunk;
        });
        target.on("end", () => resolve(body ? JSON.parse(body) : {}));
      });
    },
  });
  if (!handled) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  }
});
await new Promise<void>((resolve) => routeLedgerServer.listen(0, "127.0.0.1", resolve));
try {
  const routeAddress = routeLedgerServer.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${routeAddress.port}/room-ledger/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routeCapability.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "ROUTE_LEDGER_FULL_BODY", limit: 20 }),
  });
  const payload = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.value.sourceRoomId, routeRoom.id);
  assert.equal(payload.value.members, undefined);
  assert.deepEqual(Object.keys(payload.value), ["sourceRoomId", "messages"]);
  assert.equal(payload.value.messages?.[0]?.text, routeLedgerFullText);
  assert.equal(payload.value.messages?.[0]?.updatedAt, undefined);
  assert.deepEqual(payload.value.messages?.[0]?.attachments?.[0], imageAttachment);
  assert.equal(payload.value.messages?.[0]?.deliveryKind, "pm_auto_route");
  assert.equal(payload.value.messages?.[0]?.inReplyToMessageId, "message-route-parent");
  assert.equal(payload.value.messages?.[0]?.rootMessageId, "message-route-root");
  assert.deepEqual(payload.value.messages?.[0]?.selectedFile, { path: "项目/长安客/故事设计.md" });
  const memberResponse = await fetch(`http://127.0.0.1:${routeAddress.port}/room-ledger/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routeCapability.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "ROUTE_LEDGER_FULL_BODY", limit: 20, includeMembers: true }),
  });
  const memberPayload = (await memberResponse.json()) as any;
  assert.equal(memberResponse.status, 200);
  assert.equal(memberPayload.ok, true);
  assert.equal(memberPayload.value.sourceRoomId, routeRoom.id);
  assert.deepEqual(memberPayload.value.members, [
    {
      id: routeMember.id,
      name: routeMember.name,
      status: routeMember.status,
      lastActive: routeMember.lastActive,
      disabled: false,
    },
  ]);

  const attachmentResponse = await fetch(`http://127.0.0.1:${routeAddress.port}/room-ledger/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routeCapability.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "图片", limit: 20 }),
  });
  const attachmentPayload = (await attachmentResponse.json()) as any;
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentPayload.ok, true);
  assert.equal(attachmentPayload.value.messages?.[0]?.text, routeLedgerFullText);

  const internalResponse = await fetch(`http://127.0.0.1:${routeAddress.port}/room-ledger/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routeCapability.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "ROUTE_INTERNAL_HANDOFF_MUST_NOT_LEAK", limit: 20 }),
  });
  const internalPayload = (await internalResponse.json()) as any;
  assert.equal(internalResponse.status, 200);
  assert.equal(internalPayload.ok, true);
  assert.equal(internalPayload.value.sourceRoomId, routeRoom.id);
  assert.deepEqual(internalPayload.value.messages, []);
} finally {
  revokeRoomLedgerCapability(routeCapability.token);
  await new Promise<void>((resolve) => routeLedgerServer.close(() => resolve()));
}

const failedLedgerVisibleAnswer = resolveChatFinalAnswer([
  { type: "error", runId: "run-ledger-error", message: "room_ledger_read_failed:http_403" },
] as any);
assert.equal(failedLedgerVisibleAnswer, hostMessage("en", "agent.run_failed"));

const failedFetchParts = persistedRoomRunParts(
  [{ type: "error", runId: "run-fetch-error", message: "fetch failed" }],
  "run-fetch-error",
  "fetch failed",
);
assert.equal(failedFetchParts.length, 1);
assert.equal(failedFetchParts[0]?.text, "fetch failed");
const failedFetchPartsEnglish = persistedRoomRunParts(
  [{ type: "error", runId: "run-fetch-error-en", message: "fetch failed" }],
  "run-fetch-error-en",
  "fetch failed",
  { language: "en" },
);
assert.equal(failedFetchPartsEnglish[0]?.text, "fetch failed");
const structuredDiagnosticErrorParts = persistedRoomRunParts(
  [
    {
      type: "error",
      runId: "run-structured-error",
      message: "request failed",
      diagnostics: { upstreamRequestId: "req-internal-only" },
    },
  ],
  "run-structured-error",
  "request failed",
);
assert.equal(structuredDiagnosticErrorParts.length, 1);
assert.equal(structuredDiagnosticErrorParts[0]?.text, "request failed");
assert.doesNotMatch(JSON.stringify(structuredDiagnosticErrorParts), /req-internal-only/);
const unnamedDiagnosticPartsEnglish = persistedRoomRunParts(
  [{ type: "runtime.diagnostic", runId: "run-diagnostic-en", name: "" }] as any,
  "run-diagnostic-en",
  "",
  { language: "en" },
);
assert.deepEqual(unnamedDiagnosticPartsEnglish, []);

const portalBlockedLedgerServer = createServer((_request, response) => {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "authentication_required" }));
});
await new Promise<void>((resolve) => portalBlockedLedgerServer.listen(0, "127.0.0.1", resolve));
const portalFallbackWarnings: unknown[][] = [];
const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  portalFallbackWarnings.push(args);
};
try {
  const portalAddress = portalBlockedLedgerServer.address() as AddressInfo;
  const portalReadUrl = `http://127.0.0.1:${portalAddress.port}/api/room-ledger/read`;
  const portalFallbackLedger = await withRoomLedgerAccessForRun(
    "run-ledger-portal-fallback",
    {
      sourceRoomId: ledgerRoom.id,
      ledgerCapability: {
        sourceRoomId: ledgerRoom.id,
        readUrl: portalReadUrl,
        token: "portal-blocked-ledger-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    () =>
      ledgerTool.execute({ query: "LOCAL_LEDGER_FULL_BODY", limit: 10 }, {
        runId: "run-ledger-portal-fallback",
      } as any),
  );
  assert.equal(portalFallbackLedger.ok, true);
  if (!portalFallbackLedger.ok) throw new Error(portalFallbackLedger.error);
  const portalFallbackValue = portalFallbackLedger.value as unknown as LedgerValue;
  assert.equal(portalFallbackValue.sourceRoomId, ledgerRoom.id);
  assert.equal(portalFallbackValue.messages[0]?.text, localLedgerFullText);
  assert.deepEqual(portalFallbackWarnings, [
    [
      "room_ledger_local_fallback",
      {
        sourceRoomId: ledgerRoom.id,
        readUrl: portalReadUrl,
        error: "authentication_required",
      },
    ],
  ]);
  assert.doesNotMatch(JSON.stringify(portalFallbackWarnings), /portal-blocked-ledger-token/);
} finally {
  console.warn = originalConsoleWarn;
  await new Promise<void>((resolve) => portalBlockedLedgerServer.close(() => resolve()));
}

const interruptedCodexStartAbortParts = persistedRoomRunParts(
  [{ type: "error", runId: "run-cancelled-before-start", message: "turn/start aborted" }] as any,
  "run-cancelled-before-start",
  "",
  { mode: "interrupted" },
);
assert.equal(interruptedCodexStartAbortParts.length, 0);
assert.doesNotMatch(JSON.stringify(interruptedCodexStartAbortParts), /turn\/start aborted/);

const failedCodexStartAbortParts = persistedRoomRunParts(
  [{ type: "error", runId: "run-start-failed", message: "turn/start aborted" }] as any,
  "run-start-failed",
  "turn/start aborted",
);
assert.equal(failedCodexStartAbortParts.length, 1);
assert.equal(failedCodexStartAbortParts[0]?.text, "turn/start aborted");

const emptyLocalRooms = new RoomChannelStore();
const emptyLedgerTool = createRoomLedgerReadTool({} as any, emptyLocalRooms);
const missingLocalLedger = await emptyLedgerTool.execute({ roomId: "room-source" }, {
  runId: "run-without-context",
} as any);
assert.equal(missingLocalLedger.ok, false);
assert.equal(missingLocalLedger.error, "room_not_found");

const ledgerServer = createServer((request, response) => {
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer ledger-secret");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      value: {
        sourceRoomId: "room-source",
        requestedRoomIdIgnored: "transport-room",
        messages: [
          {
            id: "msg-remote",
            roomId: "room-source",
            channelSeq: 3,
            senderId: "employee-a",
            senderName: "小赵QA",
            senderType: "agent",
            text: "LEDGER_CAPABILITY_FROM_SOURCE_ROOM",
            createdAt: new Date(2).toISOString(),
            attachments: [
              {
                id: "remote-oversized-attachment",
                name: "remote-private.txt",
                kind: "text",
                mimeType: "text/plain",
                size: 100_000,
                text: oversizedAttachmentText,
                dataUrl: oversizedAttachmentDataUrl,
                localPath: "/opt/opengrove/remote-private.txt",
              },
            ],
          },
        ],
        members: [
          {
            id: "employee-a",
            name: "小赵QA",
            kernel: "REMOTE_PRIVATE_KERNEL_MUST_NOT_LEAK",
            model: "REMOTE_PRIVATE_MODEL_MUST_NOT_LEAK",
            role: "REMOTE_PRIVATE_ROLE_MUST_NOT_LEAK",
            status: "idle",
            lastActive: "now",
            disabled: false,
          },
        ],
        currentEventSeq: 11,
      },
    }),
  );
});
await new Promise<void>((resolve) => ledgerServer.listen(0, "127.0.0.1", resolve));
const ledgerAddress = ledgerServer.address() as AddressInfo;
try {
  const capabilityLedger = await withRoomLedgerAccessForRun(
    "run-ledger-capability",
    {
      sourceRoomId: "room-source",
      ledgerCapability: {
        sourceRoomId: "room-source",
        readUrl: `http://127.0.0.1:${ledgerAddress.port}/read`,
        token: "ledger-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    () =>
      emptyLedgerTool.execute({ roomId: "transport-room", query: "LEDGER_CAPABILITY", limit: 20 }, {
        runId: "run-ledger-capability",
      } as any),
  );
  assert.equal(capabilityLedger.ok, true);
  if (!capabilityLedger.ok) {
    throw new Error(capabilityLedger.error);
  }
  const capabilityValue = capabilityLedger.value as any;
  assert.equal(capabilityValue.sourceRoomId, "room-source");
  assert.equal(capabilityValue.requestedRoomIdIgnored, undefined);
  assert.equal(capabilityValue.currentEventSeq, undefined);
  assert.equal(capabilityValue.members, undefined);
  assert.equal(capabilityValue.messages[0].text, "LEDGER_CAPABILITY_FROM_SOURCE_ROOM");
  assert.deepEqual(capabilityValue.messages[0].attachments[0], {
    id: "remote-oversized-attachment",
    name: "remote-private.txt",
    kind: "text",
    mimeType: "text/plain",
    size: 100_000,
  });
  assert.doesNotMatch(JSON.stringify(capabilityValue), /REMOTE_PRIVATE_(KERNEL|MODEL|ROLE)_MUST_NOT_LEAK/);
  assert.doesNotMatch(JSON.stringify(capabilityValue), /PRIVATE_ATTACHMENT_TEXT_MUST_NOT_LEAK|opt\/opengrove/);

  const capabilityMemberLedger = await withRoomLedgerAccessForRun(
    "run-ledger-capability-members",
    {
      sourceRoomId: "room-source",
      ledgerCapability: {
        sourceRoomId: "room-source",
        readUrl: `http://127.0.0.1:${ledgerAddress.port}/read`,
        token: "ledger-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    () =>
      emptyLedgerTool.execute(
        { roomId: "transport-room", query: "LEDGER_CAPABILITY", limit: 20, includeMembers: true },
        { runId: "run-ledger-capability-members" } as any,
      ),
  );
  assert.equal(capabilityMemberLedger.ok, true);
  if (!capabilityMemberLedger.ok) {
    throw new Error(capabilityMemberLedger.error);
  }
  const capabilityMemberValue = capabilityMemberLedger.value as any;
  assert.equal(capabilityMemberValue.sourceRoomId, "room-source");
  assert.deepEqual(capabilityMemberValue.members, [
    {
      id: "employee-a",
      name: "小赵QA",
      status: "idle",
      lastActive: "now",
      disabled: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(capabilityMemberValue), /REMOTE_PRIVATE_(KERNEL|MODEL|ROLE)_MUST_NOT_LEAK/);

  const nativeRunCapabilityLedger = await withRoomLedgerAccessForRun(
    "room-run-ledger-capability",
    {
      sourceRoomId: "room-source",
      ledgerCapability: {
        sourceRoomId: "room-source",
        readUrl: `http://127.0.0.1:${ledgerAddress.port}/read`,
        token: "ledger-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    () =>
      emptyLedgerTool.execute({ roomId: "transport-room", query: "LEDGER_CAPABILITY", limit: 20 }, {
        runId: "native-run-ledger-capability",
      } as any),
  );
  assert.equal(nativeRunCapabilityLedger.ok, true);
  if (!nativeRunCapabilityLedger.ok) {
    throw new Error(nativeRunCapabilityLedger.error);
  }
  const nativeRunCapabilityValue = nativeRunCapabilityLedger.value as any;
  assert.equal(nativeRunCapabilityValue.sourceRoomId, "room-source");
  assert.equal(nativeRunCapabilityValue.messages[0].text, "LEDGER_CAPABILITY_FROM_SOURCE_ROOM");
} finally {
  await new Promise<void>((resolve) => ledgerServer.close(() => resolve()));
}

const clearedLedgerContext = await emptyLedgerTool.execute({ roomId: "room-source" }, {
  runId: "run-ledger-capability",
} as any);
assert.equal(clearedLedgerContext.ok, false);
assert.equal(clearedLedgerContext.error, "room_not_found");

console.log("room-run-history-mode-harness ok");

function fakeTurnRequest(sessionHistoryMode: "app" | "native") {
  return {
    runId: "run-current",
    sessionHistoryMode,
    context: {
      sessionId: "session-room-agent",
      sessions: {
        listRuns() {
          return [
            {
              id: "run-current",
              sessionId: "session-room-agent",
              activity: "chat",
              status: "running",
              input: "current turn",
              createdAt: new Date(1).toISOString(),
              updatedAt: new Date(1).toISOString(),
              startedAt: new Date(1).toISOString(),
              resumeCount: 0,
              approvalIds: [],
              toolIds: [],
              eventCount: 0,
            },
            {
              id: "run-previous",
              sessionId: "session-room-agent",
              activity: "chat",
              status: "succeeded",
              input: "first user turn",
              summary: "first assistant reply",
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              startedAt: new Date(0).toISOString(),
              resumeCount: 0,
              approvalIds: [],
              toolIds: [],
              eventCount: 0,
            },
          ];
        },
      },
    },
  } as any;
}

function roomLedgerToolSpec(): ToolSpec {
  return {
    id: "room.ledger.read",
    title: "Read room ledger",
    description: "Read OpenGrove room messages",
    activity: "chat",
    risk: "read",
    input: { type: "json-schema", schema: { type: "object", properties: {} } },
    permission: {
      mode: "allow",
      reason: "Room members may read their current room ledger.",
    },
  };
}
