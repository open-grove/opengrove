import type { AgentEvent, JsonObject, JsonValue, SkillManifest, SourceRef } from "../core.js";
import { isSensitiveWireKey, REDACTED_WIRE_VALUE } from "./wire-redaction.js";

const MAX_EVENT_VALUE_CHARACTERS = 32_000;
const MAX_EVENT_STRING_CHARACTERS = 8_000;
const MAX_EVENT_COLLECTION_ITEMS = 100;
const MAX_EVENT_DEPTH = 8;

/**
 * Events in the core log are diagnostic records and may contain complete prompts,
 * conversation history or large tool payloads. Browser clients only need the
 * presentation fields, so keep the durable record intact and compact the wire copy.
 */
export function presentAgentEvent(event: AgentEvent, options: { preserveAssistantText?: boolean } = {}): AgentEvent {
  switch (event.type) {
    case "context.assembled":
      return {
        ...event,
        context: {
          id: event.context.id,
          createdAt: event.context.createdAt,
          summary: truncateString(event.context.summary, 4_000),
          items: [],
          budget: event.context.budget,
          promptBlock: "",
        },
      };
    case "model.requested":
      return {
        ...event,
        request: {
          systemPrompt: "",
          userInput: truncateString(event.request.userInput, MAX_EVENT_STRING_CHARACTERS),
          modelId: event.request.modelId,
          session: event.request.session
            ? {
                ...event.request.session,
                priorMessages: [],
              }
            : undefined,
          tools: [],
          skills: [],
          packs: [],
          capabilities: [],
        },
      };
    case "model.response":
      return {
        ...event,
        response: {
          ...event.response,
          text: truncateString(event.response.text, MAX_EVENT_STRING_CHARACTERS),
        },
      };
    case "assistant.delta":
    case "assistant.final":
      return options.preserveAssistantText
        ? event
        : { ...event, text: truncateString(event.text, MAX_EVENT_STRING_CHARACTERS) };
    case "skill.loaded":
      return {
        ...event,
        contentPreview: truncateString(event.contentPreview, 4_000),
        allowedTools: event.allowedTools.slice(0, MAX_EVENT_COLLECTION_ITEMS),
      };
    case "skill.discovered":
      return { ...event, skills: event.skills.slice(0, MAX_EVENT_COLLECTION_ITEMS).map(presentSkillManifest) };
    case "skill.invoked":
      return {
        ...event,
        skill: presentSkillManifest(event.skill),
        invocation: {
          ...event.invocation,
          title: truncateString(event.invocation.title, 512),
          content: "",
          contentPreview: truncateString(event.invocation.contentPreview || event.invocation.content, 4_000),
          sourcePath: truncateString(event.invocation.sourcePath, 2_048),
          args: event.invocation.args ? truncateString(event.invocation.args, 2_000) : undefined,
          allowedTools: event.invocation.allowedTools.slice(0, MAX_EVENT_COLLECTION_ITEMS),
        },
      };
    case "skill.forked":
      return {
        ...event,
        result: event.result ? truncateString(event.result, MAX_EVENT_STRING_CHARACTERS) : undefined,
      };
    case "tool.started":
      return { ...event, input: compactBrowserJsonValue(event.input) };
    case "tool.finished":
      return {
        ...event,
        result: {
          ...event.result,
          value: event.result.value === undefined ? undefined : compactBrowserJsonValue(event.result.value),
          error: event.result.error ? truncateString(event.result.error, MAX_EVENT_STRING_CHARACTERS) : undefined,
        },
      };
    case "approval.requested":
    case "approval.resolved":
      return {
        ...event,
        request: {
          ...event.request,
          input: compactOptionalJsonValue(event.request.input),
          response: compactOptionalJsonValue(event.request.response),
          resume: undefined,
        },
      };
    case "question.requested":
    case "question.answered":
      return {
        ...event,
        question: {
          ...event.question,
          input: compactOptionalJsonValue(event.question.input),
          response: compactOptionalJsonValue(event.question.response),
          resume: undefined,
        },
      };
    case "planning.updated":
      return {
        ...event,
        plan: {
          ...event.plan,
          title: event.plan.title ? truncateString(event.plan.title, 512) : undefined,
          text: truncateString(event.plan.text, MAX_EVENT_STRING_CHARACTERS),
          raw: event.plan.raw ? (compactBrowserJsonValue(event.plan.raw) as JsonObject) : undefined,
        },
      };
    case "memory.written":
      return {
        ...event,
        record: {
          ...event.record,
          text: truncateString(event.record.text, MAX_EVENT_STRING_CHARACTERS),
          tags: event.record.tags.slice(0, MAX_EVENT_COLLECTION_ITEMS),
          data: event.record.data ? (compactBrowserJsonValue(event.record.data) as JsonObject) : undefined,
          source: {
            ...event.record.source,
            ref: event.record.source.ref ? presentSourceRef(event.record.source.ref) : undefined,
          },
        },
      };
    case "runtime.diagnostic":
      return { ...event, data: compactBrowserJsonValue(event.data) as JsonObject };
    case "assistant.status":
      return {
        ...event,
        text: truncateString(event.text, MAX_EVENT_STRING_CHARACTERS),
        data: event.data ? (compactBrowserJsonValue(event.data) as JsonObject) : undefined,
      };
    case "compaction.started":
    case "compaction.finished":
      return {
        ...event,
        ...(event.type === "compaction.started" && event.reason ? { reason: truncateString(event.reason, 2_000) } : {}),
        ...(event.type === "compaction.finished" && event.summary
          ? { summary: truncateString(event.summary, MAX_EVENT_STRING_CHARACTERS) }
          : {}),
        item: compactOptionalJsonValue(event.item),
      };
    case "run.paused":
      return {
        ...event,
        reason: truncateString(event.reason, 2_000),
      };
    case "run.resumed":
      return {
        ...event,
        reason: event.reason ? truncateString(event.reason, 2_000) : undefined,
      };
    case "run.cancel_requested":
      return {
        ...event,
        reason: event.reason ? truncateString(event.reason, 2_000) : undefined,
      };
    case "error":
      return { ...event, message: truncateString(event.message, MAX_EVENT_STRING_CHARACTERS) };
    default:
      return event;
  }
}

function presentSkillManifest(skill: SkillManifest): SkillManifest {
  return {
    ...skill,
    aliases: skill.aliases?.slice(0, MAX_EVENT_COLLECTION_ITEMS),
    title: truncateString(skill.title, 512),
    description: truncateString(skill.description, 2_000),
    whenToUse: skill.whenToUse ? truncateString(skill.whenToUse, 2_000) : undefined,
    entry: truncateString(skill.entry, 2_048),
    skillRoot: truncateString(skill.skillRoot, 2_048),
    toolIds: skill.toolIds.slice(0, MAX_EVENT_COLLECTION_ITEMS),
    memoryHooks: skill.memoryHooks.slice(0, MAX_EVENT_COLLECTION_ITEMS).map((hook) => ({
      ...hook,
      reason: truncateString(hook.reason, 1_000),
    })),
    allowedTools: skill.allowedTools.slice(0, MAX_EVENT_COLLECTION_ITEMS),
    argumentHint: skill.argumentHint ? truncateString(skill.argumentHint, 1_000) : undefined,
    arguments: skill.arguments?.slice(0, MAX_EVENT_COLLECTION_ITEMS),
    shell: skill.shell?.slice(0, MAX_EVENT_COLLECTION_ITEMS).map((value) => truncateString(value, 2_000)),
    paths: skill.paths?.slice(0, MAX_EVENT_COLLECTION_ITEMS).map((value) => truncateString(value, 2_048)),
    hooks: skill.hooks ? (compactBrowserJsonValue(skill.hooks) as JsonObject) : undefined,
    tags: skill.tags?.slice(0, MAX_EVENT_COLLECTION_ITEMS),
  };
}

function presentSourceRef(source: SourceRef): SourceRef {
  return {
    title: source.title ? truncateString(source.title, 512) : undefined,
    url: source.url ? truncateString(source.url, 2_048) : undefined,
    locator: source.locator ? truncateString(source.locator, 2_048) : undefined,
    quote: source.quote ? truncateString(source.quote, 2_000) : undefined,
  };
}

function compactOptionalJsonValue(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : compactBrowserJsonValue(value);
}

export function compactBrowserJsonValue(value: JsonValue, maxCharacters = MAX_EVENT_VALUE_CHARACTERS): JsonValue {
  return compactValue(value, { remaining: Math.max(1, maxCharacters) }, 0);
}

function compactValue(value: JsonValue, budget: { remaining: number }, depth: number): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    budget.remaining = Math.max(0, budget.remaining - 8);
    return value;
  }
  if (typeof value === "string") {
    const limit = Math.max(0, Math.min(MAX_EVENT_STRING_CHARACTERS, budget.remaining));
    const compacted = truncateString(value, limit);
    budget.remaining = Math.max(0, budget.remaining - compacted.length);
    return compacted;
  }
  if (budget.remaining <= 0 || depth >= MAX_EVENT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    const items = value.slice(0, MAX_EVENT_COLLECTION_ITEMS);
    for (const item of items) {
      if (budget.remaining <= 0) break;
      output.push(compactValue(item, budget, depth + 1));
    }
    if (items.length < value.length || budget.remaining <= 0) output.push("[truncated]");
    return output;
  }

  const output: JsonObject = {};
  const entries = Object.entries(value).slice(0, MAX_EVENT_COLLECTION_ITEMS);
  for (const [key, item] of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining = Math.max(0, budget.remaining - key.length);
    if (isSensitiveWireKey(key)) {
      output[key] = REDACTED_WIRE_VALUE;
      budget.remaining = Math.max(0, budget.remaining - 10);
    } else {
      output[key] = compactValue(item, budget, depth + 1);
    }
  }
  if (entries.length < Object.keys(value).length || budget.remaining <= 0) {
    output._truncated = true;
  }
  return output;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}
