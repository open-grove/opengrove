import type { IncomingMessage, ServerResponse } from "node:http";
import {
  A2A_PROTOCOL_VERSION,
  a2aAgentCardSchema,
  a2aMessageSchema,
  a2aTaskStateSchema,
  type A2AAgentCard,
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type A2ATaskState,
} from "#agent-protocol";
import type { RoomChannelMember, RoomChannelMessage } from "../../rooms/channel-store.js";
import type { BridgeState } from "../bridge-types.js";
import { record, stringValue } from "../http-utils.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { cancelRoomAssistantRun, isRunnableRoomAssistantTarget, scheduleRoomAssistantRuns } from "../room-runs.js";
import { roomRunCanceledMessage } from "../room-runs/constants.js";

export async function handleA2ARoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  sendJson: (response: ServerResponse, status: number, data: unknown) => void;
  readJsonBody: (request: IncomingMessage) => Promise<unknown>;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = input;

  if (request.method === "GET" && url.pathname === "/a2a/agents") {
    sendJson(response, 200, {
      ok: true,
      cards: state.app.rooms
        .listMembers()
        .filter(isRunnableRoomAssistantTarget)
        .map((member) => buildAgentCard(request, url, member)),
    });
    return true;
  }

  const cardMatch = url.pathname.match(/^\/a2a\/agents\/([^/]+)\/card$/);
  if (cardMatch && request.method === "GET") {
    const member = findA2AMember(state, decodeURIComponent(cardMatch[1]!));
    if (!member) {
      sendJson(response, 404, { error: "agent_not_found" });
      return true;
    }
    sendJson(response, 200, buildAgentCard(request, url, member));
    return true;
  }

  const sendMessageMatch = url.pathname.match(/^\/a2a\/agents\/([^/]+)\/message:send$/);
  if (sendMessageMatch && request.method === "POST") {
    const member = findA2AMember(state, decodeURIComponent(sendMessageMatch[1]!));
    if (!member) {
      sendJson(response, 404, { error: "agent_not_found" });
      return true;
    }
    if (!isRunnableRoomAssistantTarget(member)) {
      sendJson(response, 409, { error: "agent_not_runnable" });
      return true;
    }

    const body = record(await readJsonBody(request));
    const parsed = a2aMessageSchema.safeParse(record(body.message));
    if (!parsed.success || parsed.data.role !== "ROLE_USER") {
      sendJson(response, 400, { error: "a2a_message_invalid" });
      return true;
    }

    const text = messageText(parsed.data).trim();
    if (!text) {
      sendJson(response, 400, { error: "a2a_text_part_required" });
      return true;
    }

    const room = resolveA2ARoom(state, member, parsed.data.contextId);
    const result = state.app.rooms.postUserMessage({
      roomId: room.id,
      text,
      targetIds: [member.id],
      assistantTargets: [member],
      deliveryKind: "user_direct",
    });
    const scheduled = scheduleRoomAssistantRuns(state, {
      roomId: room.id,
      triggerMessageId: result.userMessage.id,
      targets: [member],
      assistantMessages: result.assistantMessages,
    });
    state.store.saveFrom(state.app);

    const assistantMessage = scheduled[0] ?? result.assistantMessages[0];
    if (!assistantMessage?.runId) {
      sendJson(response, 500, { error: "task_not_created" });
      return true;
    }

    sendJson(response, 202, taskFromMessage(state, assistantMessage));
    return true;
  }

  const taskMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "GET") {
    const task = findA2ATask(state, decodeURIComponent(taskMatch[1]!));
    if (!task) {
      sendJson(response, 404, { error: "task_not_found" });
      return true;
    }
    sendJson(response, 200, task);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/a2a/tasks") {
    const contextId = stringValue(url.searchParams.get("contextId")).trim();
    const statusValue = stringValue(url.searchParams.get("status")).trim();
    const status = statusValue ? a2aTaskStateSchema.safeParse(statusValue) : undefined;
    if (statusValue && !status?.success) {
      sendJson(response, 400, { error: "task_status_invalid" });
      return true;
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 100;
    const tasks = state.app.rooms
      .snapshot()
      .messages.filter((message) => message.senderType === "agent" && message.runId)
      .map((message) => taskFromMessage(state, message))
      .filter((task) => !contextId || task.contextId === contextId)
      .filter((task) => !status?.success || task.status.state === status.data)
      .slice(-limit)
      .reverse();
    sendJson(response, 200, { tasks });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+):cancel$/);
  if (cancelMatch && request.method === "POST") {
    const runId = decodeURIComponent(cancelMatch[1]!);
    const found = findA2ATaskRecord(state, runId);
    if (!found) {
      sendJson(response, 404, { error: "task_not_found" });
      return true;
    }
    if (!isTerminalTaskState(roomMessageStatusToTaskState(found.message.status))) {
      cancelRoomAssistantRun(state, runId);
      state.app.rooms.updateMessage(found.message.roomId, found.message.id, {
        text: found.message.text || roomRunCanceledMessage(resolveHostLanguageSettings(state.settings)),
        status: "interrupted",
        finishedAt: new Date().toISOString(),
      });
      state.store.saveFrom(state.app);
    }
    sendJson(response, 200, findA2ATask(state, runId));
    return true;
  }

  return false;
}

function buildAgentCard(request: IncomingMessage, url: URL, member: RoomChannelMember): A2AAgentCard {
  const endpoint = `${publicBaseUrl(request, url)}/api/a2a/agents/${encodeURIComponent(member.id)}/message:send`;
  const publicSkills = normalizePublicStrings(member.publicSkills);
  const description =
    member.publicDescription?.trim() || `${member.name || member.id} is an OpenGrove employee available on this node.`;
  const skills = publicSkills.length
    ? publicSkills.map((skill, index) => ({
        id: `${member.id}.skill.${slugIdentifier(skill, `skill-${index + 1}`)}`,
        name: skill,
        description: member.outputSpec || "Can collaborate through an OpenGrove room.",
        tags: normalizePublicStrings(["opengrove", member.kernel, skill]),
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      }))
    : [
        {
          id: `${member.id}.reply`,
          name: "Reply in an OpenGrove room",
          description: member.outputSpec || "Respond to a user message through the local OpenGrove room runtime.",
          tags: normalizePublicStrings(["opengrove", member.kernel || "agent"]),
          inputModes: ["text/plain"],
          outputModes: ["text/plain"],
        },
      ];
  const card: A2AAgentCard = {
    name: member.name || member.id,
    description,
    supportedInterfaces: [
      {
        url: endpoint,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: "OpenGrove",
    },
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
    metadata: {
      ogExtensions: {
        employeeId: member.id,
        kernel: member.kernel,
        model: member.model,
        reasoningEffort: member.reasoningEffort ?? "medium",
        visibility: member.visibility ?? "private",
        ...(member.publicDescription ? { publicDescription: member.publicDescription } : {}),
        ...(publicSkills.length ? { publicSkills } : {}),
        ...(member.inputSpec ? { inputSpec: member.inputSpec } : {}),
        ...(member.outputSpec ? { outputSpec: member.outputSpec } : {}),
      },
    },
  };
  return a2aAgentCardSchema.parse(card);
}

function normalizePublicStrings(values: readonly (string | undefined)[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value?.trim() ?? "").filter(Boolean))];
}

function slugIdentifier(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || fallback
  );
}

function resolveA2ARoom(state: BridgeState, member: RoomChannelMember, contextId: string | undefined) {
  const requested = contextId?.trim();
  if (requested) {
    const existing = state.app.rooms.getRoom(requested);
    if (existing) return existing;
    return state.app.rooms.openDirect({ memberId: member.id, id: requested, title: member.name });
  }
  return state.app.rooms.openDirect({ memberId: member.id, title: member.name });
}

function findA2AMember(state: BridgeState, memberId: string): RoomChannelMember | undefined {
  return state.app.rooms.listMembers().find((member) => member.id === memberId);
}

function findA2ATask(state: BridgeState, runId: string): A2ATask | undefined {
  const found = findA2ATaskRecord(state, runId);
  return found ? taskFromMessage(state, found.message) : undefined;
}

function findA2ATaskRecord(state: BridgeState, runId: string): { message: RoomChannelMessage } | undefined {
  const message = state.app.rooms
    .snapshot()
    .messages.find(
      (candidate) => candidate.senderType === "agent" && (candidate.runId === runId || candidate.id === runId),
    );
  return message ? { message } : undefined;
}

function taskFromMessage(state: BridgeState, message: RoomChannelMessage): A2ATask {
  const statusState = roomMessageStatusToTaskState(message.status);
  const responseMessage = message.text ? roomMessageToA2AMessage(message) : undefined;
  return {
    id: message.runId || message.id,
    contextId: message.roomId,
    status: {
      state: statusState,
      ...(responseMessage && isTerminalTaskState(statusState) ? { message: responseMessage } : {}),
      timestamp: message.updatedAt || message.finishedAt || message.createdAt,
    },
    history: state.app.rooms.listVisibleMessages(message.roomId, { limit: 20 }).map(roomMessageToA2AMessage),
    metadata: {
      roomId: message.roomId,
      messageId: message.id,
      employeeId: message.senderId,
    },
  };
}

function roomMessageToA2AMessage(message: RoomChannelMessage): A2AMessage {
  return {
    messageId: message.id,
    role: message.senderType === "user" ? "ROLE_USER" : "ROLE_AGENT",
    parts: [{ text: message.text || "" }],
    contextId: message.roomId,
    taskId: message.runId,
  };
}

function roomMessageStatusToTaskState(status: string): A2ATaskState {
  if (status === "running") return "TASK_STATE_WORKING";
  if (status === "done") return "TASK_STATE_COMPLETED";
  if (status === "interrupted") return "TASK_STATE_CANCELED";
  if (status === "failed") return "TASK_STATE_FAILED";
  return "TASK_STATE_SUBMITTED";
}

function isTerminalTaskState(status: A2ATaskState): boolean {
  return (
    status === "TASK_STATE_COMPLETED" ||
    status === "TASK_STATE_FAILED" ||
    status === "TASK_STATE_CANCELED" ||
    status === "TASK_STATE_REJECTED"
  );
}

function messageText(message: A2AMessage): string {
  return message.parts.map(partText).filter(Boolean).join("\n");
}

function partText(part: A2APart): string {
  if ("text" in part && typeof part.text === "string") return part.text;
  if ("data" in part) return JSON.stringify(part.data);
  if ("url" in part) return part.url;
  return "";
}

function publicBaseUrl(request: IncomingMessage, url: URL): string {
  const forwardedHost = stringHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost || request.headers.host || url.host;
  const forwardedProto = stringHeader(request.headers["x-forwarded-proto"]) || url.protocol.replace(/:$/, "") || "http";
  return `${forwardedProto}://${host}`;
}

function stringHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
