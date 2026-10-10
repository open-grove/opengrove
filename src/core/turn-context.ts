import type { AgentTurnRequest, HostContextBlock } from "./types.js";
import { agentTurnReplyLanguageInstruction } from "./language-preference.js";

/** Render at the adapter boundary: materials never become session instructions. */
export function agentTurnContextPromptBlock(
  request: Pick<AgentTurnRequest, "assembledContext">,
  state?: HostContextBlock[],
): string {
  const context = request.assembledContext;
  return [
    renderHostContextState(state ?? context?.hostState ?? []),
    ...(context?.turnInstructions ?? []).map((block) => block.text),
    context?.promptBlock?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderHostContextState(blocks: readonly HostContextBlock[]): string {
  if (!blocks.length) return "";
  return [
    "OpenGrove current state. Each named section replaces earlier values of that section:",
    ...blocks.map((block) => `[${block.id}]\n${block.text || "This section no longer applies."}`),
  ].join("\n\n");
}

/** Full snapshots also clear sections omitted since the preceding Host Turn. */
export function agentTurnFullContextPromptBlock(request: Pick<AgentTurnRequest, "assembledContext">): string {
  const state = request.assembledContext?.hostState;
  if (state === undefined) return agentTurnContextPromptBlock(request);
  return [
    "OpenGrove current state. This complete snapshot replaces all previously supplied Host state sections:",
    state.length
      ? state.map((block) => `[${block.id}]\n${block.text}`).join("\n\n")
      : "No Host state sections are active.",
    agentTurnContextPromptBlock(request, []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Separate current Host state and Turn instructions without imposing a Kernel-independent size limit. */
export function prepareAgentTurnContext(request: AgentTurnRequest): AgentTurnRequest {
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
  // Absence is not a withdrawal. Delivery receipts synthesize removals only
  // for sections that were actually present in the previous native context.
  const hostState = [...state].filter(([, text]) => text.trim()).map(([id, text]) => ({ id, text }));
  const turnInstructions = [...instructions].filter(([, text]) => text.trim()).map(([id, text]) => ({ id, text }));
  const materials = context?.promptBlock?.trim() ?? "";
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
      // This ledger describes material excerpts, never a cap on Host instructions.
      budget: context?.budget ?? {
        maxItems: 0,
        usedItems: 0,
        maxCharacters: 0,
        usedCharacters: 0,
        truncated: false,
      },
    },
  };
}

/**
 * Preserve the full Host contract for runtimes that do not expose a distinct
 * native session-instructions channel.
 */
export function agentTurnHostContextPromptBlock(request: AgentTurnRequest): string {
  const prepared = prepareAgentTurnContext(request);
  // Preserve summary-only envelopes that do not declare any structured state.
  const hasState =
    request.assembledContext?.hostState !== undefined || prepared.assembledContext!.hostState!.length > 0;
  return [
    request.sessionInstructions?.trim(),
    hasState ? agentTurnFullContextPromptBlock(prepared) : agentTurnContextPromptBlock(prepared),
  ]
    .filter(Boolean)
    .join("\n\n");
}
