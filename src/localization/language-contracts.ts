import type { SupportedLocale } from "./locale-registry.js";

export type ReplyLanguagePreference = SupportedLocale;

/**
 * Reply language is a runtime policy, not another UI setting. The current
 * product policy follows the resolved UI locale while still allowing the
 * model to adapt to the user's message and conversation context.
 */
export type ReplyLanguagePolicy = Readonly<{ mode: "follow-ui" }>;

export const DEFAULT_REPLY_LANGUAGE_POLICY: ReplyLanguagePolicy = {
  mode: "follow-ui",
};

export function resolveReplyLocale(_policy: ReplyLanguagePolicy, uiLocale: SupportedLocale): ReplyLanguagePreference {
  return uiLocale;
}

/**
 * OPENGROVE_LOCALE is only the creation-time locale offered to an App.
 * Apps own existing project metadata and must keep their stored artifact
 * paths stable when the UI locale changes.
 */
export interface NewProjectArtifactLocaleContract {
  source: "ui-at-creation";
  locale: SupportedLocale;
}

export function newProjectArtifactLocale(uiLocale: SupportedLocale): NewProjectArtifactLocaleContract {
  return {
    source: "ui-at-creation",
    locale: uiLocale,
  };
}
