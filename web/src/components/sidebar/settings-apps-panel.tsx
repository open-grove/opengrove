import { Trash2 } from "lucide-react";
import type { MountedAppSettings } from "../../bridge";
import type { TranslationFn } from "../../i18n";

export function SettingsAppsPanel(props: {
  t: TranslationFn;
  mountedApps: MountedAppSettings[];
  automaticUpdates: boolean;
  loading: boolean;
  saving: boolean;
  onPatchMountedAppDraft(appId: string, patch: Partial<MountedAppSettings>): void;
  onUpdateMountedApp(appId: string, patch: Partial<MountedAppSettings>): void;
  onRemoveMountedApp(appId: string): void;
  onSetAutomaticUpdates(enabled: boolean): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list">
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.appAutoUpdate")}</strong>
              <small>{t("settings.appAutoUpdateCopy")}</small>
            </span>
            <span className="settings-list-row-control">
              <button
                className={
                  props.automaticUpdates ? "settings-provider-enable-button enabled" : "settings-provider-enable-button"
                }
                type="button"
                role="switch"
                aria-checked={props.automaticUpdates}
                aria-label={t("settings.appAutoUpdate")}
                disabled={props.loading || props.saving}
                onClick={() => props.onSetAutomaticUpdates(!props.automaticUpdates)}
              >
                <span aria-hidden="true" />
              </button>
            </span>
          </div>
        </div>
      </section>
      <section className="settings-list-section settings-mounted-apps-section">
        <div className="settings-list settings-mounted-apps-list">
          {props.mountedApps.map((item) => (
            <div className="settings-list-row settings-list-row-field settings-mounted-app-row" key={item.id}>
              <span className="settings-list-row-main">
                <strong>{item.title || item.id}</strong>
                <small>{item.path}</small>
                {item.policyIssue ? <small role="alert">{t("settings.mountedAppPolicyBlocked")}</small> : null}
              </span>
              <span className="settings-list-row-control settings-mounted-app-controls">
                <input
                  className="settings-mounted-app-title-input"
                  value={item.title ?? ""}
                  disabled={props.loading || props.saving}
                  placeholder={t("settings.appName")}
                  onBlur={(event) =>
                    props.onUpdateMountedApp(item.id, { title: event.currentTarget.value.trim() || undefined })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onChange={(event) => props.onPatchMountedAppDraft(item.id, { title: event.target.value })}
                />
                <input
                  className="settings-mounted-app-path-input"
                  value={item.path}
                  disabled={props.loading || props.saving}
                  placeholder={t("settings.appPathPlaceholder")}
                  onBlur={(event) => props.onUpdateMountedApp(item.id, { path: event.currentTarget.value.trim() })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onChange={(event) => props.onPatchMountedAppDraft(item.id, { path: event.target.value })}
                />
                <button
                  className={
                    item.enabled ? "settings-provider-enable-button enabled" : "settings-provider-enable-button"
                  }
                  type="button"
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={t("settings.appEnabled")}
                  disabled={props.loading || props.saving || Boolean(item.policyIssue)}
                  onClick={() => props.onUpdateMountedApp(item.id, { enabled: !item.enabled })}
                >
                  <span aria-hidden="true" />
                </button>
                <button
                  className="settings-provider-icon-button"
                  type="button"
                  aria-label={t("common.remove")}
                  disabled={props.loading || props.saving}
                  onClick={() => props.onRemoveMountedApp(item.id)}
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
          {!props.mountedApps.length ? (
            <div className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.noMountedApps")}</strong>
                <small>{t("settings.noMountedAppsCopy")}</small>
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
