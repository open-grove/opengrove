import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec, UserLanguagePreference } from "../core.js";
import { DEFAULT_LOCALE } from "../localization/locale-registry.js";

export interface DelegationToolContext {
  delegate(input: { targetMemberId: string; prompt?: string; sourceRunId?: string }): Promise<ToolResult>;
  listTargets(sourceRunId?: string): Array<{ id: string; name: string; description: string }>;
  language?(): UserLanguagePreference;
}

export function createDelegateTaskTool(
  spec: ToolSpec,
  delegation: DelegationToolContext,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input, context): Promise<ToolResult<JsonValue>> {
      const targetMemberId = readString(input.targetMemberId) || readString(input.memberId);
      const prompt = readString(input.prompt) || readString(input.task);
      if (!targetMemberId) {
        return {
          ok: false,
          error: `target_member_id_required; available targets: ${formatTargets(delegation.listTargets(context?.runId))}`,
        };
      }
      const result = await delegation.delegate({
        targetMemberId,
        ...(prompt ? { prompt } : {}),
        sourceRunId: context?.runId,
      });
      if (!result.ok && result.error) {
        return {
          ...result,
          error: actionableDelegationError(result.error, delegation.language?.() ?? DEFAULT_LOCALE),
        };
      }
      return result;
    },
  };
}

function actionableDelegationError(error: string, language: UserLanguagePreference): string {
  const copy = DELEGATION_ERROR_COPY[language];
  if (error === "delegation_requires_room_admin") {
    return `${error}; ${copy.requiresRoomAdmin}`;
  }
  if (error === "delegation_chain_limit_reached") {
    return `${error}; ${copy.chainLimitReached}`;
  }
  if (error === "delegation_run_limit_reached") {
    return `${error}; ${copy.runLimitReached}`;
  }
  if (error.startsWith("delegation_target_already_queued:")) {
    return `${error}; ${copy.targetAlreadyQueued}`;
  }
  return error;
}

const DELEGATION_ERROR_COPY = {
  "zh-CN": {
    requiresRoomAdmin: "当前员工不是群管理员，不能委派其他员工。请直接回复作者，说明需要由作者或群管理员联系目标员工。",
    chainLimitReached: "委派链已达上限。不要继续转交，请直接向作者汇报当前进展，由作者决定下一步。",
    runLimitReached: "本轮委派数量已达上限。请直接向作者汇报已完成的委派和仍需处理的工作。",
    targetAlreadyQueued: "该员工已经在本轮任务中被委派，不要重复提交。",
  },
  en: {
    requiresRoomAdmin:
      "The current employee is not a room administrator and cannot delegate to other employees. Reply to the author and identify the employee whom the author or a room administrator should contact.",
    chainLimitReached:
      "The delegation chain has reached its limit. Do not delegate again; report the current progress to the author and let the author decide the next step.",
    runLimitReached:
      "This run has reached its delegation limit. Report completed delegations and remaining work directly to the author.",
    targetAlreadyQueued:
      "This employee is already queued for delegation in the current task. Do not submit the same delegation again.",
  },
} satisfies Record<
  UserLanguagePreference,
  {
    requiresRoomAdmin: string;
    chainLimitReached: string;
    runLimitReached: string;
    targetAlreadyQueued: string;
  }
>;

function formatTargets(targets: Array<{ id: string; name: string; description: string }>): string {
  if (targets.length === 0) return "(none)";
  return targets
    .map((target) => `${target.id} (${target.name}${target.description ? `: ${target.description}` : ""})`)
    .join("; ");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
