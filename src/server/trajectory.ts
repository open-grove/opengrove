import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentEvent,
  CapabilityManifest,
  ContextEnvelope,
  ModelMessage,
  PackManifest,
  SkillManifest,
  ToolSpec,
} from "../core.js";
import type { BridgeAskPayload, BridgeContextRecord, BridgeModelId, BridgeState } from "./bridge-types.js";
import {
  MAX_CONTEXT_RECORD_ARRAY_ITEMS,
  MAX_CONTEXT_RECORD_OBJECT_KEYS,
  MAX_CONTEXT_RECORD_STRING,
  MAX_CONTEXT_RECORDS,
} from "./bridge-types.js";
import { bridgeDataPath } from "./storage-paths.js";

export function writeTrajectoryRecord(
  state: BridgeState,
  payload: BridgeAskPayload,
  events: AgentEvent[],
  answer: string,
  contextRecords: BridgeContextRecord[],
): void {
  const runId = events.find((event) => event.runId)?.runId ?? `run_${Date.now()}`;
  const diagnosticEvents = compactToolProgressEvents(events);
  const root = bridgeDataPath(state, "trajectories");
  const file = resolve(root, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sanitizePathSegment(runId)}.json`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          threadId: payload.threadId,
          model: payload.model,
          question: payload.question,
          answer,
          events: diagnosticEvents,
          contextRecords,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Trajectory files are diagnostic only; a write failure should not break a user turn.
  }
}

export function attachModelId(events: AgentEvent[], modelId: BridgeModelId) {
  for (const event of events) {
    if (event.type === "model.requested") {
      event.request.modelId ??= modelId;
    }
  }
}

export function buildContextRecords(events: AgentEvent[]): BridgeContextRecord[] {
  const records = new Map<string, BridgeContextRecord>();
  for (const event of compactToolProgressEvents(events)) {
    const record = ensureContextRecord(records, event.runId);
    if (event.type !== "assistant.delta") {
      record.events.push(event);
    }

    switch (event.type) {
      case "turn.started":
        record.startedAt = event.at;
        break;
      case "turn.finished":
        record.finishedAt = event.at;
        break;
      case "context.assembled":
        record.context = event.context;
        break;
      case "model.requested":
        record.modelId = event.request.modelId;
        if (event.request.session) {
          record.session = event.request.session;
        }
        if (event.request.messages) {
          record.messages = event.request.messages;
        }
        record.userInput = event.request.userInput;
        record.systemPrompt = event.request.systemPrompt;
        record.context = event.request.context ?? record.context;
        record.tools = event.request.tools;
        record.skills = event.request.skills;
        record.packs = event.request.packs;
        record.capabilities = event.request.capabilities;
        break;
      case "assistant.delta":
        record.responseText += event.text;
        break;
      case "model.response":
        record.responseText = event.response.text || record.responseText;
        break;
      case "assistant.final":
        record.responseText = event.text || record.responseText;
        break;
      case "skill.invoked":
      case "skill.loaded":
      case "skill.forked":
      case "skill.cleared":
      case "tool.started":
      case "tool.progress":
      case "tool.finished":
      case "approval.requested":
      case "approval.resolved":
      case "question.requested":
      case "question.answered":
      case "planning.updated":
        record.toolEvents.push(event);
        break;
    }
  }

  return Array.from(records.values())
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
    .slice(0, MAX_CONTEXT_RECORDS)
    .map(slimContextRecord);
}

function compactToolProgressEvents(events: AgentEvent[]): AgentEvent[] {
  const latestProgressIndex = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "tool.progress") continue;
    latestProgressIndex.set(`${event.runId}:${event.callId ?? event.toolId}`, index);
  }
  if (!latestProgressIndex.size) return events;
  return events.filter(
    (event, index) =>
      event.type !== "tool.progress" ||
      latestProgressIndex.get(`${event.runId}:${event.callId ?? event.toolId}`) === index,
  );
}

function slimContextRecord(record: BridgeContextRecord): BridgeContextRecord {
  return {
    ...record,
    userInput: truncateContextString(record.userInput),
    systemPrompt: truncateContextString(record.systemPrompt),
    responseText: truncateContextString(record.responseText),
    messages: compactContextPayload(record.messages) as ModelMessage[],
    context: compactContextPayload(record.context) as ContextEnvelope | undefined,
    tools: compactContextPayload(record.tools) as ToolSpec[],
    skills: compactContextPayload(record.skills) as SkillManifest[],
    packs: compactContextPayload(record.packs) as PackManifest[],
    capabilities: compactContextPayload(record.capabilities) as CapabilityManifest[],
    toolEvents: record.toolEvents.map((event) => compactContextPayload(event) as AgentEvent),
    events: record.events.map((event) => compactContextPayload(event) as AgentEvent),
  };
}

function compactContextPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateContextString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (depth >= 6) {
    return "[omitted nested payload]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONTEXT_RECORD_ARRAY_ITEMS).map((item) => compactContextPayload(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_CONTEXT_RECORD_OBJECT_KEYS)) {
    output[key] = compactContextPayload(child, depth + 1);
  }
  return output;
}

function truncateContextString(value: string): string {
  return value.length > MAX_CONTEXT_RECORD_STRING
    ? `${value.slice(0, MAX_CONTEXT_RECORD_STRING)}\n[omitted ${value.length - MAX_CONTEXT_RECORD_STRING} chars]`
    : value;
}

function ensureContextRecord(records: Map<string, BridgeContextRecord>, runId: string): BridgeContextRecord {
  let record = records.get(runId);
  if (!record) {
    record = {
      runId,
      session: undefined,
      messages: [],
      userInput: "",
      systemPrompt: "",
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
      responseText: "",
      toolEvents: [],
      events: [],
    };
    records.set(runId, record);
  }
  return record;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[<>:"\\|?*\x00-\x1f]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 120);
  return sanitized || "untitled";
}
