import type { BridgeSettings, VoiceSettings, VoiceSttProviderId } from "../../bridge";
import type { TranslationFn } from "../../i18n";
import { InlineSelect, type InlineSelectOption } from "./settings-inline-select";
import { defaultVoiceProviderOptions } from "./settings-model";

type VoiceSttSettings = NonNullable<BridgeSettings["voice"]>;

export function SettingsVoicePanel(props: {
  t: TranslationFn;
  voiceSettings: VoiceSttSettings;
  loading: boolean;
  saving: boolean;
  onSetVoiceDraft(patch: Partial<VoiceSettings["stt"]>): void;
  onSaveVoice(patch?: Partial<VoiceSettings["stt"]>): void;
}) {
  const { t, voiceSettings } = props;
  const voiceProviderOptions: InlineSelectOption[] = voiceSettings.sttProviders?.length
    ? voiceSettings.sttProviders.map((provider) => ({ id: provider.id, label: provider.label }))
    : defaultVoiceProviderOptions();
  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.speechToText")}</h2>
        </div>
        <div className="settings-list">
          <div className="settings-list-row settings-preference-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.sttProvider")}</strong>
              <small>{t("settings.sttProviderCopy")}</small>
            </span>
            <span className="settings-list-row-control wide">
              <InlineSelect
                value={voiceSettings.stt.provider}
                options={voiceProviderOptions}
                menuSize="regular"
                disabled={props.loading || props.saving}
                onChange={(value) => props.onSaveVoice({ provider: value as VoiceSttProviderId })}
              />
            </span>
          </div>
          <label className="settings-list-row settings-list-row-field">
            <span className="settings-list-row-main">
              <strong>{t("settings.sttLanguage")}</strong>
              <small>{t("settings.sttLanguageCopy")}</small>
            </span>
            <input
              value={voiceSettings.stt.language}
              disabled={props.loading || props.saving}
              placeholder="auto"
              onBlur={(event) => props.onSaveVoice({ language: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              onChange={(event) => props.onSetVoiceDraft({ language: event.target.value })}
            />
          </label>

          {voiceSettings.stt.provider === "openai" ? (
            <>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.sttModel")}</strong>
                  <small>OpenAI</small>
                </span>
                <input
                  value={voiceSettings.stt.openai.model}
                  disabled={props.loading || props.saving}
                  placeholder="gpt-4o-mini-transcribe"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({ openai: { ...voiceSettings.stt.openai, model: event.target.value } })
                  }
                />
              </label>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.apiKeyEnv")}</strong>
                  <small>{t("settings.requiresEnvKey")}</small>
                </span>
                <input
                  value={voiceSettings.stt.openai.apiKeyEnv}
                  disabled={props.loading || props.saving}
                  placeholder="OPENAI_API_KEY"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({ openai: { ...voiceSettings.stt.openai, apiKeyEnv: event.target.value } })
                  }
                />
              </label>
            </>
          ) : null}

          {voiceSettings.stt.provider === "groq" ? (
            <>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.sttModel")}</strong>
                  <small>Groq</small>
                </span>
                <input
                  value={voiceSettings.stt.groq.model}
                  disabled={props.loading || props.saving}
                  placeholder="whisper-large-v3-turbo"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({ groq: { ...voiceSettings.stt.groq, model: event.target.value } })
                  }
                />
              </label>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.apiKeyEnv")}</strong>
                  <small>{t("settings.requiresEnvKey")}</small>
                </span>
                <input
                  value={voiceSettings.stt.groq.apiKeyEnv}
                  disabled={props.loading || props.saving}
                  placeholder="GROQ_API_KEY"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({ groq: { ...voiceSettings.stt.groq, apiKeyEnv: event.target.value } })
                  }
                />
              </label>
            </>
          ) : null}

          {voiceSettings.stt.provider === "local-whisper" ? (
            <>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.sttModel")}</strong>
                  <small>Whisper</small>
                </span>
                <input
                  value={voiceSettings.stt.localWhisper.model}
                  disabled={props.loading || props.saving}
                  placeholder="base"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({
                      localWhisper: { ...voiceSettings.stt.localWhisper, model: event.target.value },
                    })
                  }
                />
              </label>
              <label className="settings-list-row settings-list-row-field">
                <span className="settings-list-row-main">
                  <strong>{t("settings.localCommand")}</strong>
                  <small>{t("settings.localCommandCopy")}</small>
                </span>
                <input
                  value={voiceSettings.stt.localWhisper.command ?? ""}
                  disabled={props.loading || props.saving}
                  placeholder="whisper {input} --model {model} --output_format txt --output_dir {outputDir}"
                  onBlur={() => props.onSaveVoice()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) =>
                    props.onSetVoiceDraft({
                      localWhisper: { ...voiceSettings.stt.localWhisper, command: event.target.value },
                    })
                  }
                />
              </label>
            </>
          ) : null}

          {voiceSettings.stt.provider === "browser" ? (
            <div className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.browserOnly")}</strong>
                <small>{t("settings.browserOnlyCopy")}</small>
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
