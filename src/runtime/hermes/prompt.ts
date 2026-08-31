import {
  agentTurnHostContextPromptBlock,
  agentTurnReplyLanguageInstruction,
  type AgentTurnRequest,
} from "../../core.js";
import { recentSessionPromptBlock } from "../session-history.js";

export function buildHermesPrompt(request: AgentTurnRequest): string {
  const hostContext = agentTurnHostContextPromptBlock(request);
  const threadHistory = recentSessionPromptBlock(request);
  const skillHint = request.requestedSkillInvocation
    ? [
        `The user invoked OpenGrove skill /${request.requestedSkillInvocation.skillName}.`,
        "Hermes should use its native skills_list / skill_view mechanism when the skill is available there.",
      ].join(" ")
    : "";
  const sections = [
    "You are running inside the OpenGrove host.",
    hostContext ? `Host context:\n${hostContext}` : "",
    threadHistory,
    skillHint,
    `User request:\n${request.input}`,
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);
  return sections.join("\n\n");
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function cleanHermesAssistantText(value: string): string {
  return stripHermesTemplateTokens(value);
}

export function stripHermesTemplateTokens(value: string): string {
  return value.replace(/<\|(?:assistant|user|system|observation|tool|end|endoftext)\|>/g, "");
}
