import type { OpenGroveApp } from "../app/create-opengrove.js";
import type { Routine, RoutineStep } from "../core.js";
import { APP_VAULT_ROOT_NAME } from "../identity.js";
import { parseRoutineFile } from "../routines/routine-file.js";
import { validateRoutineToolInput } from "../routines/routine-step-validation.js";
import { knowledgeVaultPath } from "./knowledge-files.js";
import { validateImportWorkflowMemberRef } from "./workflow-member-ref.js";

export type RoutineImportResult =
  | { ok: true; routine: Routine }
  | { ok: false; status: number; error: string; vaultPath?: string };

export function importRoutineFromKnowledgeOrContent(
  app: OpenGroveApp,
  input: { knowledgeId?: string; content?: string },
): RoutineImportResult {
  let content = input.content?.trim() ? input.content : undefined;
  if (input.knowledgeId) {
    const document = app.knowledge.get(input.knowledgeId);
    if (!document) {
      return { ok: false, status: 400, error: "knowledge_not_found" };
    }
    if (document.type !== "routine") {
      return { ok: false, status: 400, error: "knowledge_not_routine_type" };
    }
    const vaultPath = knowledgeVaultPath(document);
    const expectedDir = `${APP_VAULT_ROOT_NAME}/routines/`;
    if (!vaultPath.startsWith(expectedDir)) {
      return { ok: false, status: 400, error: "routine_not_in_routines_dir", vaultPath };
    }
    content = document.body;
  }

  if (!content) {
    return { ok: false, status: 400, error: "content_required" };
  }

  const parsed = parseRoutineFile(content);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }
  const file = parsed.routine;
  const validation = validateImportSteps(app, file.steps);
  if (validation) {
    return { ok: false, status: 400, error: validation };
  }

  const routine = app.routines.create({
    title: file.title,
    ...(file.description ? { description: file.description } : {}),
    ...(input.knowledgeId ? { sourceKnowledgeId: input.knowledgeId } : {}),
    status: "active",
    trigger: file.trigger,
    ...(file.schedule ? { schedule: file.schedule } : {}),
    capabilityIds: [],
    approvalRules: [],
    steps: file.steps,
  });
  return { ok: true, routine };
}

// 导入期 step 校验:memberId 必须是当前 app/room 范围内可运行的成员;toolId 必须已注册。
// 返回 undefined 表示通过,返回字符串表示拒绝原因。
function validateImportSteps(app: OpenGroveApp, steps: RoutineStep[]): string | undefined {
  const toolIds = new Set(app.tools.list().map((tool) => tool.spec.id));
  for (const step of steps) {
    if (step.toolId && !toolIds.has(step.toolId)) {
      return `tool_not_registered:${step.toolId}`;
    }
    if (step.toolId) {
      const toolInputError = validateRoutineToolInput(step);
      if (toolInputError) return toolInputError;
    }
    if (step.memberId) {
      const memberError = validateImportWorkflowMemberRef(app.rooms, step.memberId);
      if (memberError) return memberError;
    }
  }
  return undefined;
}
