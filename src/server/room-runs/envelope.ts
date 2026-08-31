import { createHash } from "node:crypto";
import type { AgentAttachmentContext, UserLanguagePreference } from "../../core.js";
import {
  GROVE_GUIDE_SKILL_NAME,
  isGroveGuideMember,
  isRunnableRoomAssistantTarget,
  type RoomChannelMember,
  type RoomChannelMessage,
} from "../../rooms/channel-store.js";
import { canRoomPmAutoRoute, isPmAutoRouteTurn, isRoomPmMember } from "../../rooms/room-pm.js";
import type { BridgeState } from "../bridge-types.js";
import type { BridgeResolvedProviderRoute } from "../provider-profiles.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { resolveRoomTargetProviderRoute, roomAgentAppVersionKey, roomAgentThreadId } from "./execution-state.js";

export interface RoomRunEnvelope {
  sessionInstructions: string;
  turnInstructions: string;
  userInput: string;
  sessionDefinitionFingerprint: string;
  sessionId: string;
  triggerMessage: RoomChannelMessage;
  attachments: AgentAttachmentContext[];
  isPmAutoRoute: boolean;
}

export function buildRoomRunEnvelope(
  state: BridgeState,
  input: {
    roomId: string;
    triggerMessageId: string;
    target: RoomChannelMember;
    hostTools: boolean;
    providerRoute?: BridgeResolvedProviderRoute;
  },
): RoomRunEnvelope {
  const room = state.app.rooms.getRoom(input.roomId);
  if (!room) throw new Error(`room_not_found:${input.roomId}`);
  const triggerMessage = state.app.rooms.getMessage(input.roomId, input.triggerMessageId);
  if (!triggerMessage) throw new Error(`trigger_message_not_found:${input.triggerMessageId}`);

  const language = resolveHostLanguageSettings(state.settings);
  const isRoomAdministrator = room.adminMemberIds.includes(input.target.id);
  const isPmAutoRoute = isPmAutoRouteTurn(input.target, triggerMessage);
  const routedAuthorMessage = resolvePmRoutedAuthorMessage(state, input.roomId, triggerMessage);
  const sessionInstructions = buildSessionInstructions(
    input.target,
    input.hostTools,
    language,
    isRoomAdministrator,
    isPmAutoRoute,
  );
  const appVersionKey = isPmAutoRoute ? "" : (roomAgentAppVersionKey(state, input.target) ?? "");
  const providerRoute = input.providerRoute ?? resolveRoomTargetProviderRoute(state, input.target);
  const sessionDefinitionFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        employeeId: input.target.id,
        employeeName: input.target.name,
        employeeDisplayName: input.target.displayName ?? "",
        employeeNameOverridden: input.target.userOverrides?.includes("name") ?? false,
        kernel: input.target.kernel,
        providerId: providerRoute.providerId,
        role: isPmAutoRoute ? "" : input.target.role,
        appId: input.target.appId ?? "",
        workspaceRoot: input.target.workspaceRoot ?? "",
        defaultSkillIds: isPmAutoRoute ? [] : (input.target.defaultSkillIds ?? []),
        appVersionKey,
        hostTools: input.hostTools,
        isRoomAdministrator,
        isPmAutoRoute,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const sessionId = roomAgentThreadId(
    input.roomId,
    input.target.id,
    input.target.kernel,
    `definition-${sessionDefinitionFingerprint}`,
  );

  return {
    sessionInstructions,
    turnInstructions: buildTurnInstructions(state, {
      roomId: input.roomId,
      roomTitle: room.title,
      memberIds: room.memberIds,
      target: input.target,
      sessionId,
      triggerMessage,
      language,
      isPmAutoRoute,
    }),
    userInput: buildMessageUserInput(
      state,
      input.roomId,
      triggerMessage,
      routedAuthorMessage,
      input.hostTools,
      language,
    ),
    sessionDefinitionFingerprint,
    sessionId,
    triggerMessage,
    attachments: (routedAuthorMessage ?? triggerMessage).attachments?.map((attachment) => ({ ...attachment })) ?? [],
    isPmAutoRoute,
  };
}

function buildSessionInstructions(
  target: RoomChannelMember,
  hostTools: boolean,
  language: UserLanguagePreference,
  isRoomAdministrator: boolean,
  isPmAutoRoute: boolean,
): string {
  const copy = ROOM_RUN_INSTRUCTION_COPY[language];
  const identity = [copy.employeeIdentity(memberPromptName(target), target.id), copy.displayNamePolicy].join("\n");
  if (isPmAutoRoute && canRoomPmAutoRoute(target, { isRoomAdministrator, hostTools })) {
    return [identity, copy.pmAutoRouting].join("\n\n");
  }
  if (isPmAutoRoute) {
    return [identity, copy.pmAutoRoutingUnavailable].join("\n\n");
  }
  const role = target.role.trim();
  const isPm = isRoomPmMember(target);
  return [
    identity,
    role ? copy.role(role) : "",
    hostTools
      ? [copy.collaborationWithTools, isRoomAdministrator ? copy.administratorDelegation : copy.memberDelegation]
          .filter(Boolean)
          .join("\n")
      : copy.collaborationWithoutTools,
    isPm && hostTools && isRoomAdministrator ? copy.pmRouting : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildTurnInstructions(
  state: BridgeState,
  input: {
    roomId: string;
    roomTitle: string;
    memberIds: string[];
    target: RoomChannelMember;
    sessionId: string;
    triggerMessage: RoomChannelMessage;
    language: UserLanguagePreference;
    isPmAutoRoute: boolean;
  },
): string {
  const copy = ROOM_RUN_INSTRUCTION_COPY[input.language];
  const membersById = new Map(state.app.rooms.listMembers().map((member) => [member.id, member]));
  const memberLines = input.memberIds
    .filter((memberId) => {
      if (!input.isPmAutoRoute) return true;
      const member = membersById.get(memberId);
      return memberId !== input.target.id && Boolean(member && isRunnableRoomAssistantTarget(member));
    })
    .map((memberId) => {
      const member = membersById.get(memberId);
      if (!member) return copy.unknownMember(memberId);
      if (input.isPmAutoRoute) {
        return copy.routingMember(
          memberPromptName(member),
          member.id,
          truncateByCodePoint(memberPromptPublicDescription(member), 120),
          member.disabled || member.status === "offline",
        );
      }
      return copy.member(memberPromptName(member), member.id, member.disabled || member.status === "offline");
    });
  const isBootstrapTurn = !state.app.sessions.get(input.sessionId)?.runIds.length;
  const hasPriorRoomContext =
    isBootstrapTurn &&
    state.app.rooms
      .listVisibleMessages(input.roomId, {
        beforeSeq: input.triggerMessage.channelSeq,
        limit: 500,
      })
      .some(
        (message) => (message.senderType === "user" || message.senderType === "agent") && Boolean(message.text.trim()),
      );
  return [
    copy.room(input.roomTitle, input.roomId),
    copy.responseLanguageSource,
    [
      input.isPmAutoRoute ? copy.routingMemberHeading : copy.memberHeading,
      ...(memberLines.length ? memberLines : [copy.noMembers]),
    ].join("\n"),
    isBootstrapTurn && hasPriorRoomContext ? copy.sessionContinuation : "",
    isBootstrapTurn && isGroveGuideMember(input.target) ? copy.groveBootstrap : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildMessageUserInput(
  state: BridgeState,
  roomId: string,
  triggerMessage: RoomChannelMessage,
  routedAuthorMessage: RoomChannelMessage | undefined,
  hostTools: boolean,
  language: UserLanguagePreference,
): string {
  const copy = ROOM_MESSAGE_ENVELOPE_COPY[language];
  if (routedAuthorMessage) {
    return buildRoutedAuthorUserInput(state, roomId, routedAuthorMessage, copy);
  }

  const contextLines = buildMessageRelationContext(state, roomId, triggerMessage, copy);
  const isDelegated = triggerMessage.deliveryKind === "agent_delegation";

  if (isDelegated) {
    contextLines.push(copy.source(copy.employeeDelegationSender(triggerMessage.senderName)));
  } else if (triggerMessage.senderType !== "user") {
    contextLines.push(
      copy.source(triggerMessage.senderName || (triggerMessage.senderType === "system" ? copy.system : "")),
    );
  }
  appendSelectedFileContext(contextLines, triggerMessage, copy);
  if (isDelegated) {
    contextLines.push(hostTools ? copy.delegatedWithTools : copy.delegatedWithoutTools);
  }

  return renderMessageUserInput(triggerMessage, contextLines, copy);
}

function resolvePmRoutedAuthorMessage(
  state: BridgeState,
  roomId: string,
  triggerMessage: RoomChannelMessage,
): RoomChannelMessage | undefined {
  if (triggerMessage.deliveryKind !== "pm_auto_route") return undefined;
  if (triggerMessage.senderType === "user") return triggerMessage;
  const sourceMessage = triggerMessage.inReplyToMessageId
    ? state.app.rooms.getMessage(roomId, triggerMessage.inReplyToMessageId)
    : undefined;
  return sourceMessage?.senderType === "user" && sourceMessage.deliveryKind === "pm_auto_route"
    ? sourceMessage
    : undefined;
}

function buildRoutedAuthorUserInput(
  state: BridgeState,
  roomId: string,
  authorMessage: RoomChannelMessage,
  copy: RoomMessageEnvelopeCopy,
): string {
  const contextLines = buildMessageRelationContext(state, roomId, authorMessage, copy);
  appendSelectedFileContext(contextLines, authorMessage, copy);
  return renderMessageUserInput(authorMessage, contextLines, copy);
}

function buildMessageRelationContext(
  state: BridgeState,
  roomId: string,
  message: RoomChannelMessage,
  copy: RoomMessageEnvelopeCopy,
): string[] {
  const contextLines: string[] = [];
  const rootMessage = message.rootMessageId ? state.app.rooms.getMessage(roomId, message.rootMessageId) : undefined;
  const replyMessage = message.inReplyToMessageId
    ? state.app.rooms.getMessage(roomId, message.inReplyToMessageId)
    : undefined;
  if (rootMessage && replyMessage && rootMessage.id !== replyMessage.id) {
    contextLines.push(
      copy.threadRoot(rootMessage.channelSeq, messageSender(rootMessage, copy), truncateRootSummary(rootMessage.text)),
    );
  }
  const directReply =
    replyMessage ?? (rootMessage && message.inReplyToMessageId === rootMessage.id ? rootMessage : undefined);
  if (directReply) {
    contextLines.push(
      copy.replyingTo(
        directReply.channelSeq,
        messageSender(directReply, copy),
        truncateReplyText(directReply.text, directReply.channelSeq, copy),
      ),
    );
  }
  return contextLines;
}

function appendSelectedFileContext(
  contextLines: string[],
  message: RoomChannelMessage,
  copy: RoomMessageEnvelopeCopy,
): void {
  if (!message.selectedFile?.path) return;
  contextLines.push(copy.selectedFile(message.selectedFile.path));
  contextLines.push(copy.selectedFileNote);
}

function renderMessageUserInput(
  message: RoomChannelMessage,
  contextLines: string[],
  copy: RoomMessageEnvelopeCopy,
): string {
  return [
    ...(contextLines.length ? [copy.contextHeading, ...contextLines, ""] : []),
    copy.currentMessageHeading(message.channelSeq),
    "",
    "<current-message>",
    message.text,
    "</current-message>",
  ].join("\n");
}

function messageSender(message: RoomChannelMessage, copy: RoomMessageEnvelopeCopy): string {
  if (message.senderType === "user") return copy.user;
  if (message.senderType === "system") return message.senderName || copy.system;
  return message.senderName;
}

function truncateRootSummary(text: string, maxCharacters = 80): string {
  return truncateByCodePoint(text.replace(/\s+/gu, " ").trim(), maxCharacters);
}

function truncateReplyText(
  text: string,
  sequence: number,
  copy: RoomMessageEnvelopeCopy,
  maxCharacters = 2_000,
): string {
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return `${characters.slice(0, maxCharacters).join("")}${copy.replyTruncation(sequence)}`;
}

function truncateByCodePoint(text: string, maxCharacters: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return `${characters.slice(0, maxCharacters).join("")}…`;
}

interface RoomRunInstructionCopy {
  displayNamePolicy: string;
  responseLanguageSource: string;
  collaborationWithTools: string;
  collaborationWithoutTools: string;
  administratorDelegation: string;
  memberDelegation: string;
  pmRouting: string;
  pmAutoRouting: string;
  pmAutoRoutingUnavailable: string;
  memberHeading: string;
  routingMemberHeading: string;
  noMembers: string;
  sessionContinuation: string;
  groveBootstrap: string;
  employeeIdentity(name: string, id: string): string;
  role(value: string): string;
  room(title: string, id: string): string;
  member(name: string, id: string, unavailable: boolean): string;
  routingMember(name: string, id: string, role: string, unavailable: boolean): string;
  unknownMember(id: string): string;
}

const ROOM_RUN_INSTRUCTION_COPY = {
  "zh-CN": {
    displayNamePolicy:
      "名称使用规则：App 和员工名称以 Host 提供的当前界面展示名为准；请原样使用，不要翻译，也不要替换为存储名或默认语言名称。",
    responseLanguageSource: "回复语言判断：本轮以 <current-message> 内的内容作为当前输入。",
    collaborationWithTools: [
      "房间协作规则：",
      "- 任务依赖房间历史或指代不清时，调用 room.ledger.read；需要核对成员状态时传 includeMembers: true。",
      "- 房间账本只用于确认历史；当前状态以本轮工具、文件或业务接口结果为准。",
      "- 是否委派、何时委派由你根据任务判断；不要为了交接而交接。",
      "- 最终回复会自动写入当前房间，无需另行发送。",
      "- 不要把推理过程、工具名或实现细节写进最终回复，除非作者明确要求诊断。",
    ].join("\n"),
    collaborationWithoutTools: [
      "房间协作能力限制：",
      "- 当前内核没有 OpenGrove Host Tools，不能读取房间账本，也不能真实委派或叫起其他员工。",
      "- 不要声称自己已经读取房间上下文、@ 了员工或完成了委派；文本里的 @ 不是动作。",
      "- 如果任务缺少房间前情，请明确告诉作者还需要什么上下文；如果需要其他员工接手，请作者自己 @ 对应员工。",
      "- 你的最终回复会自动写入当前房间，不要再寻找发送房间消息的工具。",
    ].join("\n"),
    administratorDelegation:
      "- 你是当前群管理员；需要联系或叫起其他员工时必须调用 room.delegate.task，且只有工具成功后才能声称已委派。文本中的 @ 不构成委派。",
    memberDelegation:
      "- 你不是当前群管理员，不能调用 room.delegate.task。需要其他员工协作时，请作者或群管理员联系对应员工；不得声称已经完成委派。",
    pmRouting: [
      "PM 未提及消息路由规则：",
      "- 用户没有明确 @ 员工时，先结合当前消息、岗位和房间账本判断应交给哪位房间员工。",
      "- 不要创建或激活工作流；这只是一次轻量路由。",
      "- 对每位选定员工调用 room.delegate.task，正文保留用户原话；除非原文完全缺少指代，最多增加一句极薄说明。",
      "- 不要把用户原话扩写成任务 brief，不添加产物、路径或你自己的执行建议。",
      "- 最终只向作者简短说明真实路由结果；判断不出时请作者直接 @ 合适员工，不要硬派。",
    ].join("\n"),
    pmAutoRouting: [
      "PM 自动路由模式：",
      "- 你唯一的任务是判断作者当前消息应该交给哪位房间员工。",
      "- 指代不清时可先调用 room.ledger.read；仍无法判断时不要委派，请作者明确 @ 员工。",
      "- 选择后调用 room.delegate.task，只填写 targetMemberId，省略 prompt；Host 会转发作者原消息。",
      "- 不改写、概括、补充或执行作者任务，不创建工作流。",
      "- 工具成功后只说明已转交给哪位员工，不得声称任务已完成。",
    ].join("\n"),
    pmAutoRoutingUnavailable: [
      "PM 自动路由不可用：",
      "- 当前环境不能执行真实的 PM 自动路由。不要执行、改写或规划作者的任务。",
      "- 请明确告诉作者当前无法自动转交，并请作者直接 @ 对应员工。",
    ].join("\n"),
    memberHeading: "当前房间成员：",
    routingMemberHeading: "可路由员工：",
    noMembers: "- 无",
    sessionContinuation: "【会话续接】当前原生会话为新建；若本轮依赖房间上下文，先读取房间账本。",
    groveBootstrap: [
      "Grove 首轮引导：",
      `- 使用 ${GROVE_GUIDE_SKILL_NAME} 技能作为本轮操作手册。`,
      "- 在回答安装、App Store、App 导入、架构或排障问题前，先读取 opengrove.guide.status。",
      "- 没有状态或工具证据时，不要声称 App 已安装或 Kernel 可用。",
    ].join("\n"),
    employeeIdentity: (name, id) => `你是 OpenGrove 房间员工“${name}”（员工 ID：${id}）。`,
    role: (value) => `岗位说明：\n${value}`,
    room: (title, id) => `当前房间：${title}（${id}）`,
    member: (name, id, unavailable) => `- ${name} (${id})${unavailable ? "（不可用）" : ""}`,
    routingMember: (name, id, role, unavailable) =>
      `- ${name} (${id})${role ? `：${role}` : ""}${unavailable ? "（不可用）" : ""}`,
    unknownMember: (id) => `- ${id}（未知成员）`,
  },
  en: {
    displayNamePolicy:
      "Name usage: Use the App and employee display names provided by the Host exactly as shown. Do not translate them or replace them with stored or default-locale names.",
    responseLanguageSource:
      "Response language: For this Room turn, treat the content inside <current-message> as the current input.",
    collaborationWithTools: [
      "Room collaboration rules:",
      "- If the task depends on room history or has an ambiguous reference, call room.ledger.read; pass includeMembers: true when checking member status.",
      "- The room ledger only confirms history; verify current state with tools, files, or business APIs in this turn.",
      "- Decide whether and when delegation benefits the task; do not hand work off merely for the sake of handoff.",
      "- Your final response is written to the current room automatically; no separate send action is needed.",
      "- Do not include private reasoning, tool names, or implementation details in the final response unless the author explicitly requests diagnostics.",
    ].join("\n"),
    collaborationWithoutTools: [
      "Room collaboration capability limits:",
      "- This kernel has no OpenGrove Host Tools, so it cannot read the room ledger or actually delegate to or wake other employees.",
      "- Do not claim to have read room context, contacted an employee, or completed a delegation. A textual @ is not an action.",
      "- If earlier room context is missing, tell the author exactly what context you need. If another employee should take over, ask the author to contact that employee.",
      "- Your final response is written to the current room automatically. Do not look for another tool to send it.",
    ].join("\n"),
    administratorDelegation:
      "- You are a current room administrator. To contact or wake another employee, call room.delegate.task; only claim delegation after it succeeds. A textual @ is not a delegation.",
    memberDelegation:
      "- You are not a current room administrator and cannot call room.delegate.task. If another employee is needed, ask the author or a room administrator to contact them; never claim that you delegated.",
    pmRouting: [
      "PM routing rules for messages without an explicit mention:",
      "- When the user does not explicitly mention an employee, use the current message, roles, and room ledger to choose the appropriate room employee.",
      "- Do not create or activate a workflow. This is lightweight routing only.",
      "- Call room.delegate.task for every selected employee and preserve the user's wording. Add at most one very short clarification only when the original text has no usable referent.",
      "- Do not expand the user's message into a task brief or add deliverables, paths, or your own execution advice.",
      "- Report only the real routing result briefly. If you cannot choose, ask the author to mention the appropriate employee instead of forcing an assignment.",
    ].join("\n"),
    pmAutoRouting: [
      "PM auto-routing mode:",
      "- Your only job is to choose which room employee should receive the author's message.",
      "- If the referent is unclear, you may call room.ledger.read; if it remains unclear, do not delegate and ask the author to mention an employee.",
      "- Then call room.delegate.task with targetMemberId only and omit prompt; the Host forwards the author's original message.",
      "- Do not rewrite, summarize, supplement, or execute the author's task, and do not create a workflow.",
      "- After success, only say which employee received the message; never claim the task is complete.",
    ].join("\n"),
    pmAutoRoutingUnavailable: [
      "PM auto-routing is unavailable:",
      "- The current environment cannot perform real PM auto-routing. Do not execute, rewrite, or plan the author's task.",
      "- Tell the author clearly that automatic handoff is unavailable and ask them to mention the appropriate employee directly.",
    ].join("\n"),
    memberHeading: "Current room members:",
    routingMemberHeading: "Available routing targets:",
    noMembers: "- None",
    sessionContinuation:
      "[Session continuation] This native session is new. If this turn depends on room context, read the room ledger first.",
    groveBootstrap: [
      "Grove first-turn guide:",
      `- Use the ${GROVE_GUIDE_SKILL_NAME} skill as the operating guide for this turn.`,
      "- Before answering questions about installation, the App Store, App imports, architecture, or troubleshooting, read opengrove.guide.status.",
      "- Do not claim that an App is installed or a Kernel is available without state or tool evidence.",
    ].join("\n"),
    employeeIdentity: (name, id) => `You are OpenGrove room employee "${name}" (employee ID: ${id}).`,
    role: (value) => `Role:\n${value}`,
    room: (title, id) => `Current room: ${title} (${id})`,
    member: (name, id, unavailable) => `- ${name} (${id})${unavailable ? " (unavailable)" : ""}`,
    routingMember: (name, id, role, unavailable) =>
      `- ${name} (${id})${role ? `: ${role}` : ""}${unavailable ? " (unavailable)" : ""}`,
    unknownMember: (id) => `- ${id} (unknown member)`,
  },
} satisfies Record<UserLanguagePreference, RoomRunInstructionCopy>;

function memberPromptName(member: Pick<RoomChannelMember, "name" | "displayName" | "userOverrides">): string {
  const storedName = member.name.trim();
  if (member.userOverrides?.includes("name")) return storedName;
  const displayName = member.displayName?.trim();
  return displayName || storedName;
}

function memberPromptPublicDescription(
  member: Pick<RoomChannelMember, "publicDescription" | "displayPublicDescription" | "userOverrides">,
): string {
  const storedDescription = member.publicDescription?.replace(/\s+/gu, " ").trim() ?? "";
  if (member.userOverrides?.includes("publicDescription")) return storedDescription;
  return member.displayPublicDescription?.replace(/\s+/gu, " ").trim() || storedDescription;
}

interface RoomMessageEnvelopeCopy {
  user: string;
  system: string;
  contextHeading: string;
  selectedFileNote: string;
  delegatedWithTools: string;
  delegatedWithoutTools: string;
  employeeDelegationSender(name: string): string;
  source(name: string): string;
  threadRoot(sequence: number, sender: string, text: string): string;
  replyingTo(sequence: number, sender: string, text: string): string;
  currentMessageHeading(sequence: number): string;
  replyTruncation(sequence: number): string;
  selectedFile(path: string): string;
}

const ROOM_MESSAGE_ENVELOPE_COPY = {
  "zh-CN": {
    user: "用户",
    system: "系统",
    contextHeading: "【消息上下文】",
    selectedFileNote:
      "说明：这只是用户当前的界面选中状态，不代表用户要求操作该文件；仅当本轮请求明确提及它，或以“这个文件”等方式指代它时，才将其作为任务对象。",
    delegatedWithTools: "（你由另一名员工委派唤起：行动前先读房间账本，了解相关上下文）",
    delegatedWithoutTools: "（你由另一名员工委派唤起；当前内核不能读取房间账本，如上下文不足请明确告诉作者）",
    employeeDelegationSender: (name) => `${name}（员工委派）`,
    source: (name) => `来源：${name}`,
    threadRoot: (sequence, sender, text) => `线程根消息 #${sequence} ${sender}：「${text}」`,
    replyingTo: (sequence, sender, text) => `回复 #${sequence} ${sender}：「${text}」`,
    currentMessageHeading: (sequence) => `【当前消息 #${sequence}】`,
    replyTruncation: (sequence) => `…（内容已截断，完整内容见房间账本 #${sequence}）`,
    selectedFile: (path) => `选中文件：${path}`,
  },
  en: {
    user: "User",
    system: "System",
    contextHeading: "[Message context]",
    selectedFileNote:
      'Note: This is only the user\'s current UI selection, not a request to operate on the file. Treat it as the task target only when this request explicitly mentions it or refers to it as "this file".',
    delegatedWithTools:
      "(Another employee delegated this message to you. Read the room ledger before acting so you understand the relevant context.)",
    delegatedWithoutTools:
      "(Another employee delegated this message to you. This kernel cannot read the room ledger; tell the author clearly if context is insufficient.)",
    employeeDelegationSender: (name) => `${name} (employee delegation)`,
    source: (name) => `Source: ${name}`,
    threadRoot: (sequence, sender, text) => `Thread root #${sequence} ${sender}: "${text}"`,
    replyingTo: (sequence, sender, text) => `Replying to #${sequence} ${sender}: "${text}"`,
    currentMessageHeading: (sequence) => `[Current message #${sequence}]`,
    replyTruncation: (sequence) => `… (truncated; full content is available in room ledger #${sequence})`,
    selectedFile: (path) => `Selected file: ${path}`,
  },
} satisfies Record<UserLanguagePreference, RoomMessageEnvelopeCopy>;
