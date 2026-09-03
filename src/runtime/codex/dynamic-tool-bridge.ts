import { createHash } from "node:crypto";
import {
  evaluateToolPolicy,
  type AgentEvent,
  type AgentTurnRequest,
  type ApprovalRequest,
  type JsonObject,
  type JsonValue,
  type ToolDefinition,
  type ToolResult,
} from "../../core.js";
import type { AsyncEventQueue } from "./async-event-queue.js";
import { asJsonValue, isJsonObject } from "./json.js";
import { executeHostToolWithLiveness } from "../host-tool-bridge.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse, CodexDynamicToolSpec } from "./types.js";

export function createCodexDynamicToolBridge(request: AgentTurnRequest, runId: string) {
  const usedNames = new Set<string>();
  const toolByCodexName = new Map<string, ToolDefinition>();
  const capabilityByToolId = new Map<string, string>();
  for (const capability of request.capabilities ?? []) {
    for (const tool of capability.tools) {
      capabilityByToolId.set(tool.id, capability.id);
    }
  }
  const specs = request.tools.map((tool) => {
    const name = toCodexToolName(tool.spec.id, usedNames);
    toolByCodexName.set(name, tool);
    return {
      name,
      description: `${tool.spec.title}: ${tool.spec.description}`,
      inputSchema: asJsonValue(tool.spec.input.schema),
    };
  });

  return {
    specs,
    fingerprint: fingerprintDynamicTools(specs),
    async handleToolCall(
      call: CodexDynamicToolCallParams,
      callbacks: {
        queue: AsyncEventQueue<AgentEvent>;
        onPause(request: ApprovalRequest): void;
      },
    ): Promise<CodexDynamicToolCallResponse> {
      const tool = toolByCodexName.get(call.tool);
      if (!tool) {
        return dynamicToolTextResult(`Unknown OpenGrove tool: ${call.tool}`, false);
      }
      const input = asJsonValue(call.arguments ?? {});
      callbacks.queue.push({
        type: "tool.started",
        runId,
        toolId: tool.spec.id,
        callId: call.callId,
        input,
      });
      const capabilityId = capabilityByToolId.get(tool.spec.id);
      const decision = evaluateToolPolicy(tool.spec, request.policy, capabilityId);
      if (decision.mode !== "allow") {
        if (decision.mode === "ask") {
          const approval = request.context.approvals.request({
            kind: "tool",
            title: tool.spec.title || tool.spec.id,
            reason: decision.reason,
            toolId: tool.spec.id,
            capabilityId,
            input,
            resume: { type: "tool", runId },
          });
          callbacks.queue.push({ type: "approval.requested", runId, request: approval });
          callbacks.onPause(approval);
        }
        const result: ToolResult = {
          ok: false,
          error: decision.mode === "deny" ? "permission_denied" : "approval_required",
          value: {
            status: decision.mode,
            reason: decision.reason,
          },
        };
        callbacks.queue.push({ type: "tool.finished", runId, toolId: tool.spec.id, callId: call.callId, result });
        return dynamicToolTextResult(formatToolResult(result), false);
      }

      try {
        const result = await executeHostToolWithLiveness(tool, input as JsonObject, {
          runId,
          capabilityId,
          skillId: request.requestedSkillInvocation?.skillId,
          memory: request.context.memory,
          artifacts: request.context.artifacts,
          workingState: request.context.workingState,
          approvals: request.context.approvals,
          skills: request.context.skills,
          packs: request.context.packs,
          signal: request.signal,
          policy: decision,
        });
        callbacks.queue.push({ type: "tool.finished", runId, toolId: tool.spec.id, callId: call.callId, result });
        return dynamicToolTextResult(formatToolResult(result), result.ok);
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        callbacks.queue.push({ type: "tool.finished", runId, toolId: tool.spec.id, callId: call.callId, result });
        return dynamicToolTextResult(formatToolResult(result), false);
      }
    },
  };
}

export function readDynamicToolCallParams(value: JsonValue | undefined): CodexDynamicToolCallParams | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = typeof value.threadId === "string" ? value.threadId : undefined;
  const turnId = typeof value.turnId === "string" ? value.turnId : undefined;
  const callId = typeof value.callId === "string" ? value.callId : undefined;
  const tool = typeof value.tool === "string" ? value.tool : undefined;
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    tool,
    arguments: value.arguments,
  };
}

function dynamicToolTextResult(text: string, success: boolean): CodexDynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text }],
    success,
  };
}

function formatToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}

function fingerprintDynamicTools(tools: CodexDynamicToolSpec[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map(stabilizeJsonValue)))
    .digest("hex");
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function toCodexToolName(toolId: string, usedNames: Set<string>): string {
  const raw = `opengrove_${toolId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = /^[A-Za-z_]/.test(raw) ? raw : `opengrove_${raw}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}
