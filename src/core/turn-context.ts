import type { AgentTurnRequest, HostContextBlock } from "./types.js";
import { agentTurnReplyLanguageInstruction } from "./language-preference.js";

export const HOST_CONTEXT_MAX_CHARACTERS = 32_000;

/** Render at the adapter boundary: materials never become session instructions. */
export function agentTurnContextPromptBlock(
  request: Pick<AgentTurnRequest, "assembledContext" | "sessionInstructions">,
  state?: HostContextBlock[],
  stablePromptCharacters = 0,
): string {
  const context = request.assembledContext;
  const rendered = [
    renderHostContextState(state ?? context?.hostState ?? []),
    ...(context?.turnInstructions ?? []).map((block) => block.text),
    context?.promptBlock?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const total = rendered.length + Math.max(stablePromptCharacters, request.sessionInstructions?.length ?? 0);
  if (total > HOST_CONTEXT_MAX_CHARACTERS) {
    throw new Error(
      `host_context_budget_exceeded: rendered Host context uses ${total} characters; limit ${HOST_CONTEXT_MAX_CHARACTERS}. Reduce Host instructions or attached context.`,
    );
  }
  return rendered;
}

export function renderHostContextState(blocks: readonly HostContextBlock[]): string {
  if (!blocks.length) return "";
  return [
    "OpenGrove current state. Each named section replaces earlier values of that section:",
    ...blocks.map((block) => `[${block.id}]\n${block.text || "This section no longer applies."}`),
  ].join("\n\n");
}

/** Bound all Host additions together; native history, native prompts and user input are not truncated. */
export function prepareAgentTurnContext(request: AgentTurnRequest, stablePromptCharacters = 0): AgentTurnRequest {
  const context = request.assembledContext;
  const state = new Map((context?.hostState ?? []).map((block) => [block.id, block.text]));
  const instructions = new Map((context?.turnInstructions ?? []).map((block) => [block.id, block.text]));
  const requiredIds = new Set([
    ...(request.requiredSkills ?? []).map((skill) => skill.manifest.id),
    ...(request.requiredSkillRequirements ?? []).flatMap((skill) => (skill.manifest ? [skill.manifest.id] : [])),
  ]);
  const optionalSkills = (request.skills ?? []).filter((skill) => !requiredIds.has(skill.id));
  state.set(
    "opengrove.optional-skills",
    optionalSkills.length
      ? [
          "Employee optional skill scope (load only when relevant by reading the exact SKILL.md path, then follow its references progressively):",
          ...optionalSkills.map((skill) => `- ${skill.name}: ${skill.description}\n  SKILL.md: ${skill.entry}`),
        ].join("\n")
      : "",
  );
  state.set("opengrove.reply-language", agentTurnReplyLanguageInstruction(request));
  const invocation = request.requestedSkillInvocation;
  instructions.set(
    "opengrove.selected-skill",
    invocation
      ? [
          `The user explicitly selected skill /${invocation.skillName} for this turn.`,
          invocation.sourcePath ? `SKILL.md: ${invocation.sourcePath}` : "",
          invocation.args ? `User skill arguments:\n${invocation.args}` : "",
          invocation.content,
          invocation.allowedTools.length ? `Host-declared tool scope: ${invocation.allowedTools.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
  );
  const hostState = [...state].map(([id, text]) => ({ id, text }));
  const turnInstructions = [...instructions].filter(([, text]) => text.trim()).map(([id, text]) => ({ id, text }));
  const requiredCharacters =
    Math.max(stablePromptCharacters, request.sessionInstructions?.length ?? 0) +
    renderHostContextState(hostState).length +
    turnInstructions.reduce((total, block) => total + block.text.length + 2, 0) +
    4;
  if (requiredCharacters > HOST_CONTEXT_MAX_CHARACTERS) {
    throw new Error(
      `host_context_budget_exceeded: required Host instructions use ${requiredCharacters} characters; limit ${HOST_CONTEXT_MAX_CHARACTERS}. Reduce Employee instructions or Skill scope.`,
    );
  }
  const materials = context?.promptBlock?.trim() ?? "";
  // Preserve attachment paths and provenance instead of chopping the rendered
  // material block at an arbitrary position. The assembler already bounds excerpts.
  if (requiredCharacters + materials.length > HOST_CONTEXT_MAX_CHARACTERS) {
    throw new Error(
      `host_context_budget_exceeded: Host context uses ${requiredCharacters + materials.length} characters; limit ${HOST_CONTEXT_MAX_CHARACTERS}. Reduce attached context or Skill scope.`,
    );
  }
  return {
    ...request,
    assembledContext: {
      id: context?.id ?? `ctx_${request.runId ?? Date.now()}`,
      createdAt: context?.createdAt ?? new Date().toISOString(),
      summary: context?.summary ?? "host context",
      items: context?.items ?? [],
      promptBlock: materials,
      hostState,
      turnInstructions,
      budget: {
        maxItems: context?.budget.maxItems ?? 8,
        usedItems: context?.items.length ?? 0,
        maxCharacters: HOST_CONTEXT_MAX_CHARACTERS,
        usedCharacters: requiredCharacters + materials.length,
        truncated: context?.budget.truncated ?? false,
      },
    },
  };
}

/**
 * Preserve the full Host contract for runtimes that do not expose a distinct
 * native session-instructions channel.
 */
export function agentTurnHostContextPromptBlock(request: AgentTurnRequest): string {
  return [request.sessionInstructions?.trim(), agentTurnContextPromptBlock(prepareAgentTurnContext(request))]
    .filter(Boolean)
    .join("\n\n");
}
