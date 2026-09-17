import type { KernelProxySettings } from "../../bridge";
import type { TranslationFn } from "../../i18n";
import { effectiveProxyDescription, effectiveProxyValue } from "./settings-model";

export function SettingsNetworkPanel(props: {
  t: TranslationFn;
  kernelProxy: KernelProxySettings;
  showKernelProxy: boolean;
  agentRouterUrl: string;
  savedAgentRouterUrl: string;
  agentRouterManaged: boolean;
  onSetAgentRouterUrl(url: string): void;
  onSaveAgentRouterUrl(): void;
  loading: boolean;
  saving: boolean;
  onSetKernelProxyDraft(patch: Partial<KernelProxySettings>): void;
  onSaveKernelProxy(patch?: Partial<KernelProxySettings>): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.remoteAgents")}</h2>
        </div>
        <form
          className="settings-list"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.loading && !props.saving && !props.agentRouterManaged) props.onSaveAgentRouterUrl();
          }}
        >
          <label className="settings-list-row settings-list-row-field settings-router-url">
            <span className="settings-list-row-main">
              <strong>{t("settings.agentRouterUrl")}</strong>
              <small>{t("settings.agentRouterHint")}</small>
            </span>
            <input
              type="url"
              value={props.agentRouterUrl}
              placeholder={t("settings.agentRouterPlaceholder")}
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              readOnly={props.agentRouterManaged}
              disabled={props.loading || props.saving}
              onChange={(event) => props.onSetAgentRouterUrl(event.target.value)}
            />
          </label>
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <small>
                {props.agentRouterManaged ? t("settings.agentRouterManaged") : t("settings.agentRouterSaveHint")}
              </small>
            </span>
            {!props.agentRouterManaged ? (
              <button
                type="submit"
                className="ghost-button"
                disabled={props.loading || props.saving || props.agentRouterUrl.trim() === props.savedAgentRouterUrl}
              >
                {props.saving ? t("common.saving") : t("settings.saveRouterAddress")}
              </button>
            ) : null}
          </div>
        </form>
      </section>
      {props.showKernelProxy ? (
        <section className="settings-list-section">
          <div className="settings-list-section-heading">
            <h2>{t("settings.proxy")}</h2>
          </div>
          <div className="settings-list">
            <label className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.kernelProxy")}</strong>
                <small>{t("settings.kernelProxyCopy")}</small>
              </span>
              <input
                type="checkbox"
                checked={props.kernelProxy.enabled}
                disabled={props.loading || props.saving}
                onChange={(event) => props.onSaveKernelProxy({ enabled: event.target.checked })}
              />
            </label>
            <label className="settings-list-row settings-list-row-field">
              <span className="settings-list-row-main">
                <strong>{t("settings.proxyUrl")}</strong>
              </span>
              <input
                value={props.kernelProxy.proxyUrl}
                disabled={props.loading || props.saving || !props.kernelProxy.enabled}
                placeholder="http://127.0.0.1:7890"
                onBlur={() => props.onSaveKernelProxy()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                onChange={(event) => props.onSetKernelProxyDraft({ proxyUrl: event.target.value })}
              />
            </label>
            <label className="settings-list-row settings-list-row-field">
              <span className="settings-list-row-main">
                <strong>{t("settings.noProxy")}</strong>
              </span>
              <input
                value={props.kernelProxy.noProxy}
                disabled={props.loading || props.saving || !props.kernelProxy.enabled}
                placeholder="127.0.0.1,localhost,::1"
                onBlur={() => props.onSaveKernelProxy()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                onChange={(event) => props.onSetKernelProxyDraft({ noProxy: event.target.value })}
              />
            </label>
            <label className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.nodeUseEnvProxy")}</strong>
                <small>{t("settings.nodeUseEnvProxyCopy")}</small>
              </span>
              <input
                type="checkbox"
                checked={props.kernelProxy.nodeUseEnvProxy}
                disabled={props.loading || props.saving || !props.kernelProxy.enabled}
                onChange={(event) => props.onSaveKernelProxy({ nodeUseEnvProxy: event.target.checked })}
              />
            </label>
            <div className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.effectiveProxy")}</strong>
                <small>{effectiveProxyDescription(props.kernelProxy, t)}</small>
              </span>
              <code>{effectiveProxyValue(props.kernelProxy, t)}</code>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
