import { Check, ChevronDown, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import type {
  KernelLoginSession,
  KernelLoginView,
  KernelOption,
  ModelProviderBinding,
  ProviderProfile,
} from "../../bridge";
import type { TranslationFn } from "../../i18n";
import { modelOfferingKey } from "../../runtime/kernel-models";
import { ProviderIcon } from "../ui/entity-icons";
import { InlineSelect } from "./settings-inline-select";
import { SettingsProviderPickerDialog } from "./settings-provider-picker-dialog";
import {
  PROVIDER_PROTOCOL_OPTIONS,
  formatModelCount,
  isGoogleVertexProviderId,
  isLoginProtocol,
  isLoginStateProvider,
  isProviderAvailable,
  isProviderEnabled,
  isProviderUsable,
  modelIdsEquivalent,
  providerDisplayName,
  providerRouteIdForKernel,
  providerRouteIdForStoredBinding,
  providerSettingsAreSourceManaged,
  providerSupportsKernel,
  providerUsesAmbientCredentials,
  primaryBaseUrl,
  providerMetaLabel,
  providerSettingsSections,
  sortEnabledProvidersFirst,
  type ProviderFormState,
} from "./settings-model";

export function SettingsProviderSection(props: {
  t: TranslationFn;
  providers: ProviderProfile[];
  kernels: KernelOption[];
  kernelLogins: KernelLoginView[];
  kernelLoginsLoading: boolean;
  kernelLoginSession?: KernelLoginSession;
  kernelLoginActionPending: boolean;
  modelProviderBindings: ModelProviderBinding[];
  selectedProviderId: string;
  providerDetailOpen: boolean;
  providerAddOpen: boolean;
  providerDraftName: string;
  detailForm: ProviderFormState;
  editableProviderModels: string[];
  providerFormError: string;
  providerSaveState: "idle" | "saved";
  providerApiKeyVisible: boolean;
  loading: boolean;
  saving: boolean;
  onSelectProvider(provider: ProviderProfile): void;
  onOpenProviderAdd(): void;
  onCloseProviderAdd(): void;
  onStartAddProvider(): void;
  onStartAddProviderFrom(provider: ProviderProfile): void;
  onCloseProviderDetail(): void;
  onSetProviderDeleteTargetId(providerId: string): void;
  onSetProviderEnabled(providerId: string, enabled: boolean): void;
  onKernelLoginAction?(kernelId: string, action: "login" | "logout"): void;
  onResetKernelBinaryPath?(kernelId: string): void;
  onBindModelProvider(modelId: string, providerId: string): void;
  onSaveProviderProfile(): void;
  onUpdateProviderField: <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => void;
  onUpdatePrimaryBaseUrl(value: string): void;
  onSetProviderModels(models: string[]): void;
  onUpdateProviderModel(modelIndex: number, value: string): void;
  onRemoveProviderModelAt(modelIndex: number): void;
  onAddProviderModel(): void;
  onToggleProviderApiKeyVisible(): void;
}) {
  const { t } = props;
  const sorted = sortEnabledProvidersFirst(props.providers);
  const providerSections = providerSettingsSections(sorted);
  const providerProfiles = providerSections.main;
  const addableProviders = providerSections.addable;
  const selectedProvider = props.providers.find((provider) => provider.id === props.selectedProviderId);
  const providerDetailTitle = selectedProvider?.name || props.providerDraftName || t("settings.newProvider");
  const detailUsesGoogleVertex = isGoogleVertexProviderId(props.detailForm.id);

  const renderProviderSaveButton = () => {
    const saved = props.providerSaveState === "saved" && !props.saving;
    return (
      <button
        className={saved ? "primary saved" : "primary"}
        type="button"
        disabled={props.saving}
        onClick={props.onSaveProviderProfile}
      >
        {saved ? <Check size={15} /> : <Plus size={15} />}
        {props.saving ? t("settings.providerSaving") : saved ? t("settings.providerSaved") : t("settings.saveProvider")}
      </button>
    );
  };

  const renderProviderApiKeyField = (readOnly?: boolean) => {
    const visibilityLabel = props.providerApiKeyVisible ? t("settings.hideApiKey") : t("settings.showApiKey");
    return (
      <>
        <span className="settings-field-label-row">
          <span>{t("settings.apiKey")}</span>
          <button
            aria-label={visibilityLabel}
            className="settings-secret-visibility-button"
            title={visibilityLabel}
            type="button"
            onClick={props.onToggleProviderApiKeyVisible}
          >
            {props.providerApiKeyVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </span>
        <input
          autoComplete="off"
          type={props.providerApiKeyVisible ? "text" : "password"}
          value={props.detailForm.apiKey}
          readOnly={readOnly}
          onChange={(event) => props.onUpdateProviderField("apiKey", event.target.value)}
          onBlur={readOnly ? undefined : props.onSaveProviderProfile}
          placeholder={t("settings.apiKeyPlaceholder")}
        />
      </>
    );
  };

  const renderProviderDetail = (modelKeyPrefix: string, readOnly = false) => (
    <section className="settings-provider-detail inline">
      <div className="settings-detail-section">
        <div className="settings-detail-section-heading">
          <h3>{t("settings.baseConfig")}</h3>
          {selectedProvider ? (
            <button
              className="settings-provider-heading-delete"
              type="button"
              onClick={() => props.onSetProviderDeleteTargetId(selectedProvider.id)}
              aria-label={t("settings.removeProvider")}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
        <div className="settings-form-grid compact">
          <label>
            <span>{t("settings.providerName")}</span>
            <input
              value={props.detailForm.name}
              readOnly={readOnly}
              onChange={(event) => props.onUpdateProviderField("name", event.target.value)}
              placeholder="Volc Coding Plan"
            />
          </label>
          <label>
            <span>{t("settings.providerId")}</span>
            <input
              value={props.detailForm.id}
              readOnly={readOnly}
              onChange={(event) => props.onUpdateProviderField("id", event.target.value)}
              placeholder="volc-coding-plan"
            />
          </label>
          {!isLoginProtocol(props.detailForm.protocol) && props.detailForm.protocol !== "custom-gateway" ? (
            <>
              <div className="settings-form-wide">
                <span>{t("settings.protocol")}</span>
                <div className="settings-segmented">
                  {PROVIDER_PROTOCOL_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      className={props.detailForm.protocol === option.id ? "active" : ""}
                      type="button"
                      disabled={readOnly}
                      onClick={() => props.onUpdateProviderField("protocol", option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <label>
                <span>{t("settings.apiBaseUrl")}</span>
                <input
                  value={primaryBaseUrl(props.detailForm)}
                  readOnly={readOnly}
                  onChange={(event) => props.onUpdatePrimaryBaseUrl(event.target.value)}
                  placeholder="https://example.com/v1"
                />
              </label>
              {providerUsesAmbientCredentials(props.detailForm.id) ? (
                <>
                  <div className="settings-form-wide">
                    <span>{t("settings.credentials")}</span>
                    <p className="settings-help">
                      {detailUsesGoogleVertex ? t("settings.ambientVertexHint") : t("settings.ambientAwsHint")}
                    </p>
                  </div>
                  {detailUsesGoogleVertex ? null : <label>{renderProviderApiKeyField(readOnly)}</label>}
                </>
              ) : (
                <>
                  <label>{renderProviderApiKeyField(readOnly)}</label>
                  <label>
                    <span>{t("settings.apiKeyEnv")}</span>
                    <input
                      value={props.detailForm.apiKeyEnv}
                      readOnly={readOnly}
                      onChange={(event) => props.onUpdateProviderField("apiKeyEnv", event.target.value)}
                      onBlur={readOnly ? undefined : props.onSaveProviderProfile}
                      placeholder="OPENGROVE_VOLC_CODING_API_KEY"
                    />
                  </label>
                </>
              )}
            </>
          ) : null}
          <label className="settings-form-wide">
            <span>{t("settings.description")}</span>
            <input
              value={props.detailForm.description}
              readOnly={readOnly}
              onChange={(event) => props.onUpdateProviderField("description", event.target.value)}
              placeholder={t("settings.providerDescriptionPlaceholder")}
            />
          </label>
        </div>
      </div>

      <div className="settings-detail-section">
        <div className="settings-detail-section-heading">
          <h3>{t("settings.availableModels")}</h3>
        </div>
        <div className="settings-model-row">
          {props.editableProviderModels.length ? (
            <span className="settings-provider-models editable">
              {props.editableProviderModels.map((model, index) => (
                <span className="settings-model-chip" key={`${modelKeyPrefix}-model-${index}`}>
                  <input
                    className="settings-model-chip-input"
                    value={model}
                    readOnly={readOnly}
                    size={Math.max(model.length, 6)}
                    onBlur={readOnly ? undefined : () => props.onSetProviderModels(props.editableProviderModels)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onChange={(event) => props.onUpdateProviderModel(index, event.target.value)}
                    aria-label={t("settings.models")}
                  />
                  {readOnly ? null : (
                    <button
                      type="button"
                      onClick={() => props.onRemoveProviderModelAt(index)}
                      aria-label={t("settings.removeModel")}
                    >
                      &times;
                    </button>
                  )}
                </span>
              ))}
            </span>
          ) : (
            <p className="settings-help">{t("settings.noProviderModels")}</p>
          )}
          {readOnly ? null : (
            <button
              className="settings-model-add-button"
              type="button"
              onClick={props.onAddProviderModel}
              aria-label={t("settings.addModel")}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      {props.providerFormError ? <p className="settings-warning">{props.providerFormError}</p> : null}
      <div className="settings-form-actions settings-provider-detail-actions">
        <span />
        <span>
          <button type="button" onClick={props.onCloseProviderDetail}>
            {t("common.cancel")}
          </button>
          {readOnly ? null : renderProviderSaveButton()}
        </span>
      </div>
    </section>
  );

  const renderLoginItem = (login: KernelLoginView) => {
    const authenticated = login.status === "authenticated";
    const actionPending = props.kernelLoginActionPending || props.kernelLoginSession?.status === "running";
    const showLogin = login.loginAvailable && login.status === "missing";
    const showLogout = authenticated && login.logoutAvailable;
    const statusLabel = {
      authenticated: t("settings.loginStatusAuthenticated"),
      missing: t("settings.loginStatusMissing"),
      unknown: t("settings.loginStatusUnknown"),
      unavailable: t("settings.loginStatusUnavailable"),
    }[login.status];
    const statusText =
      login.configuredCommand && login.configuredCommandIssue
        ? t(
            login.configuredCommandIssue === "missing"
              ? "settings.loginConfiguredCliMissing"
              : "settings.loginConfiguredCliFailed",
            { path: login.configuredCommand },
          )
        : statusLabel;
    const showResetCommand = Boolean(login.configuredCommand && login.configuredCommandIssue);
    return (
      <div key={login.kernelId} className="settings-list-group settings-provider-item login-state">
        <div className="settings-list-row settings-provider-row login-row">
          <span className="settings-provider-summary as-static">
            <ProviderIcon
              providerId={`${login.kernelId}-login`}
              providerName={login.label}
              className="settings-provider-logo"
              size={16}
            />
            <span className="settings-provider-main">
              <strong>{login.label}</strong>
              <small title={showResetCommand ? statusText : undefined}>{statusText}</small>
            </span>
          </span>
          <span className="settings-provider-row-actions">
            {showResetCommand ? (
              <button
                type="button"
                className="ghost-button settings-login-action-button"
                disabled={actionPending || props.saving}
                onClick={() => props.onResetKernelBinaryPath?.(login.kernelId)}
              >
                {t("settings.resetCliPath")}
              </button>
            ) : null}
            {showLogin ? (
              <button
                type="button"
                className="ghost-button settings-login-action-button"
                disabled={actionPending}
                onClick={() => props.onKernelLoginAction?.(login.kernelId, "login")}
              >
                {t("settings.logIn")}
              </button>
            ) : null}
            {showLogout ? (
              <button
                type="button"
                className="ghost-button settings-login-action-button danger-text"
                disabled={actionPending}
                onClick={() => props.onKernelLoginAction?.(login.kernelId, "logout")}
              >
                {t("settings.logOut")}
              </button>
            ) : null}
          </span>
        </div>
      </div>
    );
  };

  const renderProviderItem = (provider: ProviderProfile) => {
    const providerEnabled = isProviderEnabled(provider);
    const providerAvailable = isProviderAvailable(provider);
    const active = props.selectedProviderId === provider.id;
    const sourceManaged = providerSettingsAreSourceManaged(provider);
    const sourceLabel = [provider.sourceKernel, provider.source].filter(Boolean).join(" · ");
    return (
      <div
        key={provider.id}
        className={[
          "settings-provider-item",
          "settings-list-group",
          active ? "active" : "",
          providerEnabled ? "enabled" : "disabled",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="settings-list-row settings-provider-row choice">
          <button className="settings-provider-summary" type="button" onClick={() => props.onSelectProvider(provider)}>
            <ProviderIcon provider={provider} className="settings-provider-logo" size={16} />
            <span className="settings-provider-main">
              <strong>{provider.name}</strong>
              <small>
                {formatModelCount(provider.modelCount ?? provider.models?.length ?? 0, t)} ·{" "}
                {providerMetaLabel(provider, t)}
              </small>
              {sourceLabel ? <small className="settings-provider-source-line">{sourceLabel}</small> : null}
            </span>
          </button>
          <span className="settings-provider-row-actions">
            {!providerAvailable ? (
              <span className="settings-provider-status-badge">{t("common.unavailable")}</span>
            ) : null}
            <button
              className={
                providerEnabled ? "settings-provider-enable-button enabled" : "settings-provider-enable-button"
              }
              type="button"
              role="switch"
              aria-checked={providerEnabled}
              aria-label={`${provider.name} ${providerEnabled ? t("settings.providerEnabled") : t("settings.providerDisabled")}`}
              disabled={props.loading || props.saving}
              onClick={() => props.onSetProviderEnabled(provider.id, !providerEnabled)}
            >
              <span aria-hidden="true" />
            </button>
            <button
              className="settings-provider-icon-button"
              type="button"
              onClick={() => props.onSelectProvider(provider)}
              aria-label={active ? t("common.cancel") : t("settings.baseConfig")}
            >
              <ChevronDown size={16} />
            </button>
          </span>
        </div>
        {props.providerDetailOpen && active ? renderProviderDetail(provider.id, sourceManaged) : null}
      </div>
    );
  };

  return (
    <div className="settings-providers-workspace">
      <SettingsModelProviderBlock
        t={t}
        providers={props.providers}
        kernels={props.kernels}
        modelProviderBindings={props.modelProviderBindings}
        loading={props.loading}
        saving={props.saving}
        onBindModelProvider={props.onBindModelProvider}
      />
      <section className="settings-provider-block">
        <div className="settings-provider-block-heading">
          <h2>{t("settings.reusableProviders")}</h2>
          <p>{t("settings.reusableProvidersCopy")}</p>
        </div>
        <div className="settings-list settings-provider-list">
          {providerProfiles.map(renderProviderItem)}
          <button
            className="settings-list-row settings-provider-add-row"
            type="button"
            onClick={props.onOpenProviderAdd}
          >
            <Plus size={15} />
            <span>{t("settings.addProvider")}</span>
          </button>
        </div>
      </section>
      <SettingsProviderPickerDialog
        t={t}
        open={props.providerAddOpen}
        providers={addableProviders}
        detailOpen={props.providerDetailOpen && !selectedProvider}
        detailTitle={providerDetailTitle}
        renderDetail={() => renderProviderDetail("new")}
        onClose={props.onCloseProviderAdd}
        onBack={props.onCloseProviderDetail}
        onSelectProvider={props.onStartAddProviderFrom}
        onSelectCustom={props.onStartAddProvider}
      />
      {props.kernelLogins.length || props.kernelLoginsLoading ? (
        <section className="settings-provider-block">
          <div className="settings-provider-block-heading">
            <h2>{t("settings.loginStates")}</h2>
            <p>{t("settings.loginStatesCopy")}</p>
          </div>
          <div className="settings-list settings-provider-list login-state-list">
            {props.kernelLoginsLoading && !props.kernelLogins.length ? (
              <div className="settings-list-row">{t("settings.loginChecking")}</div>
            ) : (
              props.kernelLogins.map(renderLoginItem)
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function SettingsModelProviderBlock(props: {
  t: TranslationFn;
  providers: ProviderProfile[];
  kernels: KernelOption[];
  modelProviderBindings: ModelProviderBinding[];
  loading: boolean;
  saving: boolean;
  onBindModelProvider(modelId: string, providerId: string): void;
}) {
  const availableRows = buildModelProviderRouteRows(props.providers, props.kernels);
  const modelRouteRows = availableRows.sort((left, right) => left.modelId.localeCompare(right.modelId));
  if (!modelRouteRows.length) return null;

  const displayRows = modelRouteRows.map((row) => {
    const candidates = row.candidates.map((candidate) => ({
      ...candidate,
      label: providerDisplayName(candidate.provider, props.t),
    }));
    const explicitProviderId = providerRouteIdForStoredBinding(
      props.modelProviderBindings.find((binding) =>
        modelIdsEquivalent(binding.modelId, row.modelId, props.providers, binding.providerId),
      )?.providerId,
      props.providers,
    );
    const noSelectionLabel = props.t("settings.modelProviderNoSelection");
    const unavailableOptions =
      explicitProviderId && !candidates.some((candidate) => candidate.providerId === explicitProviderId)
        ? [
            {
              id: explicitProviderId,
              label: `${props.providers.find((candidate) => candidate.id === explicitProviderId)?.name || explicitProviderId} (${props.t("common.unavailable")})`,
            },
          ]
        : [];
    const options = [
      ...candidates.map((candidate) => ({
        id: candidate.providerId,
        label: candidate.label,
        icon: (
          <ProviderIcon
            provider={candidate.provider}
            providerId={candidate.provider.id}
            providerName={candidate.provider.name}
            size={13}
          />
        ),
      })),
      ...unavailableOptions,
      { id: "", label: noSelectionLabel },
    ];
    return {
      ...row,
      candidates,
      options,
      value: explicitProviderId ?? "",
    };
  });

  return (
    <section className="settings-provider-block settings-model-provider-block">
      <div className="settings-provider-block-heading settings-model-provider-heading">
        <h2>{props.t("settings.modelDefaultProviders")}</h2>
        <p>{props.t("settings.modelDefaultProvidersCopy")}</p>
      </div>
      <div className="settings-list settings-model-provider-list">
        {displayRows.map((row) => (
          <div className="settings-list-row settings-model-provider-row" key={row.modelId}>
            <span className="settings-model-provider-summary">
              <strong>{row.label}</strong>
            </span>
            <InlineSelect
              value={row.value}
              options={row.options}
              align="end"
              menuSize="compact"
              sideOffset={4}
              disabled={props.loading || props.saving}
              onChange={(providerId) => props.onBindModelProvider(row.modelId, providerId)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

type ModelProviderCandidate = {
  providerId: string;
  label: string;
  provider: ProviderProfile;
  preferred: boolean;
};

export type ModelProviderRouteRow = {
  modelId: string;
  label: string;
  candidates: ModelProviderCandidate[];
};

export function buildModelProviderRouteRows(
  providers: ProviderProfile[],
  kernels: KernelOption[],
): ModelProviderRouteRow[] {
  const rows = new Map<string, ModelProviderRouteRow>();
  for (const kernel of kernels) {
    for (const provider of providers) {
      if (!isProviderUsable(provider) || !providerSupportsKernel(provider, kernel.id)) continue;
      const providerId = providerRouteIdForKernel(provider, kernel.id);
      const declaredModels = provider.models ?? [];
      const routeModels = declaredModels.length
        ? declaredModels
        : isLoginStateProvider(provider) && provider.sourceKernel === kernel.id
          ? [{ id: `${kernel.id}-default`, label: `${kernel.label} default` }]
          : [];
      for (const model of routeModels) {
        const modelId = model.canonicalModelId?.trim() || model.id?.trim();
        if (!modelId) continue;
        const offeringKey = modelOfferingKey(model);
        const row = rows.get(offeringKey) ?? {
          modelId,
          label: model.label || modelId,
          candidates: [],
        };
        const existing = row.candidates.find((candidate) => candidate.providerId === providerId);
        if (!existing) {
          row.candidates.push({
            providerId,
            label: provider.name,
            provider,
            preferred: model.defaultProviderId === provider.id,
          });
        } else if (model.defaultProviderId === provider.id) {
          existing.preferred = true;
        }
        rows.set(offeringKey, row);
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      candidates: [...row.candidates].sort((left, right) => left.label.localeCompare(right.label)),
    }))
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}
