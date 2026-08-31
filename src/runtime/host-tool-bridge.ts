import { createHash } from "node:crypto";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  evaluateToolPolicy,
  type AgentEvent,
  type AgentTurnRequest,
  type JsonObject,
  type JsonValue,
  type ToolDefinition,
  type ToolResult,
} from "../core.js";
import type { AsyncEventQueue } from "./codex/async-event-queue.js";
import { asJsonValue, isJsonObject } from "./codex/json.js";

const HOST_TOOL_APPROVAL_TIMEOUT_MS = 120_000;

export interface HostToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations: ToolAnnotations;
}

export interface HostToolBridge {
  descriptors: HostToolDescriptor[];
  fingerprint: string;
  exposedToolIds: string[];
  isToolName(toolName: string): boolean;
  call(toolName: string, args: unknown, callId: string): Promise<CallToolResult>;
}

export function createHostToolBridge(
  request: AgentTurnRequest,
  runId: string,
  queue: AsyncEventQueue<AgentEvent>,
  kernelId: string,
): HostToolBridge {
  const usedNames = new Set<string>();
  const definitionByName = new Map<string, ToolDefinition>();
  const normalizedDefinitionNames = new Set<string>();
  const capabilityByToolId = capabilityMap(request);
  const descriptors = request.tools.map((definition) => {
    const name = toHostToolName(definition.spec.id, usedNames);
    definitionByName.set(name, definition);
    normalizedDefinitionNames.add(normalizeHostToolName(name));
    return {
      name,
      description: `${definition.spec.title}: ${definition.spec.description}`.trim(),
      inputSchema: definition.spec.input.schema,
      annotations: hostToolAnnotations(definition),
    };
  });

  return {
    descriptors,
    fingerprint: fingerprintHostTools(request.tools),
    exposedToolIds: request.tools.map((tool) => tool.spec.id),
    isToolName(toolName) {
      const raw = String(toolName || "");
      if (definitionByName.has(raw)) return true;
      const unwrapped = raw.replace(/^mcp__opengrove__/iu, "");
      return normalizedDefinitionNames.has(normalizeHostToolName(unwrapped));
    },
    async call(toolName, args, callId) {
      const definition = definitionByName.get(toolName);
      if (!definition) {
        return toCallToolResult({ ok: false, error: `host_tool_not_allowed:${toolName}` });
      }
      const input = normalizeToolInput(args, definition.spec.input.schema);
      queue.push({
        type: "tool.started",
        runId,
        toolId: definition.spec.id,
        callId,
        input,
      });

      const capabilityId = capabilityByToolId.get(definition.spec.id);
      const policy = evaluateToolPolicy(definition.spec, request.policy, capabilityId);
      if (policy.mode !== "allow") {
        const approved =
          policy.mode === "ask"
            ? await requestHostToolApproval({
                request,
                runId,
                queue,
                kernelId,
                title: definition.spec.title || definition.spec.id,
                reason: policy.reason,
                toolId: definition.spec.id,
                capabilityId,
                input,
              })
            : false;
        if (!approved) {
          const result: ToolResult = {
            ok: false,
            error: policy.mode === "deny" ? "permission_denied" : "approval_rejected",
            value: { status: policy.mode, reason: policy.reason },
          };
          queue.push({ type: "tool.finished", runId, toolId: definition.spec.id, callId, result });
          return toCallToolResult(result);
        }
      }

      try {
        const result = await definition.execute(input as JsonObject, {
          runId,
          capabilityId,
          skillId: request.requestedSkillInvocation?.skillId,
          memory: request.context.memory,
          artifacts: request.context.artifacts,
          workingState: request.context.workingState,
          approvals: request.context.approvals,
          skills: request.context.skills,
          packs: request.context.packs,
          policy:
            policy.mode === "allow"
              ? policy
              : { mode: "allow", reason: "Approved by user through the OpenGrove Host Tool bridge." },
        });
        queue.push({ type: "tool.finished", runId, toolId: definition.spec.id, callId, result });
        return toCallToolResult(result);
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        queue.push({ type: "tool.finished", runId, toolId: definition.spec.id, callId, result });
        return toCallToolResult(result);
      }
    },
  };
}

async function requestHostToolApproval(input: {
  request: AgentTurnRequest;
  runId: string;
  queue: AsyncEventQueue<AgentEvent>;
  kernelId: string;
  title: string;
  reason: string;
  toolId: string;
  capabilityId?: string;
  input: JsonValue;
}): Promise<boolean> {
  const approval = input.request.context.approvals.request({
    kind: "tool",
    title: input.title,
    reason: input.reason,
    toolId: input.toolId,
    capabilityId: input.capabilityId,
    input: input.input,
    resume: {
      type: "kernel.native",
      kernelId: input.kernelId,
      runId: input.runId,
      continuation: "same-loop",
    },
  });
  input.queue.push({ type: "approval.requested", runId: input.runId, request: approval });
  let decided;
  try {
    decided = await input.request.context.approvals.waitForDecision(approval.id, {
      timeoutMs: HOST_TOOL_APPROVAL_TIMEOUT_MS,
      signal: input.request.signal,
    });
  } catch (error) {
    const current = input.request.context.approvals.get(approval.id);
    decided =
      current?.status === "pending"
        ? input.request.context.approvals.decide(approval.id, "rejected", {
            error: error instanceof Error ? error.message : String(error),
          })
        : current;
  }
  if (decided) {
    input.queue.push({ type: "approval.resolved", runId: input.runId, request: decided });
  }
  return decided?.status === "approved";
}

function normalizeToolInput(args: unknown, schema: JsonObject): JsonValue {
  const value = asJsonValue(args);
  if (schema.type !== "object" && isJsonObject(value) && "value" in value) {
    return value.value;
  }
  return value;
}

function toCallToolResult(result: ToolResult): CallToolResult {
  const response: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: !result.ok,
  };
  if (isJsonObject(result.value)) {
    response.structuredContent = result.value;
  }
  return response;
}

function hostToolAnnotations(definition: ToolDefinition): ToolAnnotations {
  return {
    title: definition.spec.title,
    readOnlyHint: definition.spec.risk === "read",
    destructiveHint: definition.spec.risk === "delete",
    openWorldHint: definition.spec.activity === "browser" || definition.spec.activity === "computer",
  };
}

function capabilityMap(request: AgentTurnRequest): Map<string, string> {
  const output = new Map<string, string>();
  for (const capability of request.capabilities ?? []) {
    for (const tool of capability.tools) {
      output.set(tool.id, capability.id);
    }
  }
  return output;
}

function toHostToolName(toolId: string, usedNames: Set<string>): string {
  const raw = `opengrove_${toolId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const base = /^[A-Za-z]/.test(raw) ? raw : `opengrove_${raw}`;
  let candidate = base.slice(0, 120);
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base.slice(0, 112)}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizeHostToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function fingerprintHostTools(tools: ToolDefinition[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((item) => ({
          id: item.spec.id,
          schema: item.spec.input.schema,
          risk: item.spec.risk,
          permission: item.spec.permission,
        })),
      ),
    )
    .digest("hex");
}
