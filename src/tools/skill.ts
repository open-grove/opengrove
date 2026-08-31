import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec } from "../core.js";
import { createInvokedSkillRecord, recordInvokedSkill } from "../skills/runtime.js";

export function createSkillInvokeTool(spec: ToolSpec): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input, context): Promise<ToolResult<JsonValue>> {
      const requestedSkill = typeof input.skill === "string" ? input.skill.trim() : "";
      const args = typeof input.args === "string" ? input.args.trim() : undefined;

      if (!requestedSkill) {
        return {
          ok: false,
          error: "skill_name_required",
        };
      }

      const manifest = context.skills.resolve(requestedSkill, { includeDisabled: true });
      if (!manifest) {
        return {
          ok: false,
          error: `unknown_skill:${requestedSkill}`,
        };
      }

      if (manifest.disableModelInvocation) {
        return {
          ok: false,
          error: `skill_model_invocation_disabled:${manifest.name}`,
        };
      }

      const sessionId = context.workingState.get().sessionId ?? context.runId;
      const loaded = context.skills.load(manifest.name, args, sessionId);
      const invocation = createInvokedSkillRecord(loaded, "model");
      const currentWorkingState = context.workingState.get();
      context.workingState.update({
        ...recordInvokedSkill(currentWorkingState, invocation),
      });

      return {
        ok: true,
        value: {
          status: "loaded",
          skillId: manifest.id,
          skillName: manifest.name,
          title: manifest.title,
          content: loaded.content,
          contentPreview: invocation.contentPreview,
          allowedTools: manifest.allowedTools,
          model: manifest.model ?? "",
          effort: manifest.effort ?? "",
          context: manifest.context,
          sourcePath: loaded.sourcePath,
          packId: manifest.packId ?? "",
          capabilityId: manifest.capabilityId ?? "",
          args: args ?? "",
        },
      };
    },
  };
}
