import type { ReplyLanguagePreference } from "../localization/language-contracts.js";
import type { AgentTurnRequest } from "./types.js";
import { DEFAULT_REPLY_LANGUAGE_POLICY, resolveReplyLocale } from "../localization/language-contracts.js";
import { localeDefinition } from "../localization/locale-registry.js";

export function replyLanguagePreferenceInstruction(preference: ReplyLanguagePreference | undefined): string {
  if (!preference) return "";
  const responseLanguage = localeDefinition(
    resolveReplyLocale(DEFAULT_REPLY_LANGUAGE_POLICY, preference),
  ).responseLanguageName;
  return `Default response language: ${responseLanguage}. Follow the primary natural language of the current input unless it explicitly requests another language.`;
}

export function turnReplyLanguagePreference(
  request: Pick<AgentTurnRequest, "replyLanguagePreference">,
): ReplyLanguagePreference | undefined {
  return request.replyLanguagePreference;
}

export function agentTurnReplyLanguageInstruction(request: Pick<AgentTurnRequest, "replyLanguagePreference">): string {
  return replyLanguagePreferenceInstruction(turnReplyLanguagePreference(request));
}
