import type { JsonObject, JsonValue, ToolDefinition, ToolResult } from "../core.js";

export interface WorkflowActivateContext {
  activate(input: { knowledgeId: string }): Promise<ToolResult<JsonValue>>;
}

export function createWorkflowActivateTool(
  spec: import("../core.js").ToolSpec,
  context: WorkflowActivateContext,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input): Promise<ToolResult<JsonValue>> {
      const knowledgeId = typeof input.knowledgeId === "string" ? input.knowledgeId.trim() : "";
      if (!knowledgeId) return { ok: false, error: "knowledge_id_required" };
      return context.activate({ knowledgeId });
    },
  };
}
