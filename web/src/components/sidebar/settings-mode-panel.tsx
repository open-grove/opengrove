import type { TranslationFn } from "../../i18n";

export function SettingsModePanel(props: {
  t: TranslationFn;
  developerMode: boolean;
  directKernelChatEnabled: boolean;
  loading: boolean;
  saving: boolean;
  onSaveDeveloperMode(value: boolean): void;
  onSaveDirectKernelChatEnabled(value: boolean): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list">
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.developerMode")}</strong>
            </span>
            <button
              className={
                props.developerMode
                  ? "settings-provider-enable-button settings-mode-switch-button enabled"
                  : "settings-provider-enable-button settings-mode-switch-button"
              }
              type="button"
              role="switch"
              aria-checked={props.developerMode}
              aria-label={t("settings.developerMode")}
              disabled={props.loading || props.saving}
              onClick={() => props.onSaveDeveloperMode(!props.developerMode)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.kernelConversation")}</strong>
              <small>{t("settings.kernelConversationDescription")}</small>
            </span>
            <button
              className={
                props.directKernelChatEnabled
                  ? "settings-provider-enable-button settings-mode-switch-button enabled"
                  : "settings-provider-enable-button settings-mode-switch-button"
              }
              type="button"
              role="switch"
              aria-checked={props.directKernelChatEnabled}
              aria-label={t("settings.kernelConversation")}
              disabled={props.loading || props.saving}
              onClick={() => props.onSaveDirectKernelChatEnabled(!props.directKernelChatEnabled)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
