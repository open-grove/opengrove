import { useState } from "react";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { ProductIcon } from "../ui/product-icon";
import { AppIconPickerField, DEFAULT_APP_SYSTEM_ICON } from "./app-icon-picker";
import "./app-create-wizard.css";

export type AppBuilderRequest = {
  mode: "import" | "describe";
  title?: string;
  source?: string;
  description?: string;
  icon?: string;
};

export function AppCreateWizard(props: {
  title: string;
  source: string;
  description: string;
  loading?: boolean;
  saving?: boolean;
  error?: string;
  localFolderPicking?: boolean;
  canRequestAgent?: boolean;
  onTitleChange(value: string): void;
  onSourceChange(value: string): void;
  onDescriptionChange(value: string): void;
  onChooseLocalFolder?(): void;
  onCancel(): void;
  onRequestAgent(request: AppBuilderRequest): void;
  onOpenStore?(): void;
}) {
  const { t } = useI18n();
  const disabled = Boolean(props.loading || props.saving);
  const canImport = Boolean(props.source.trim());
  const canRequestAgent = canImport || Boolean(props.title.trim());
  const canAttemptFolderPick = Boolean(props.onChooseLocalFolder);
  const [selectedIcon, setSelectedIcon] = useState(DEFAULT_APP_SYSTEM_ICON);
  const displayedIcon = canImport ? undefined : selectedIcon;

  return (
    <div className="app-create-wizard">
      <div className="app-create-hero">
        <AppIconPickerField
          value={displayedIcon}
          title={props.title.trim() || t("app.createApp")}
          disabled={disabled || canImport}
          onChange={setSelectedIcon}
        />
      </div>

      <section className="app-create-section">
        <h3>{t("settings.appName")}</h3>
        <div className="app-create-group">
          <label className="app-create-row">
            <span>{t("settings.appName")}</span>
            <input
              value={props.title}
              disabled={disabled}
              placeholder="Sample Workbench"
              onChange={(event) => props.onTitleChange(event.target.value)}
            />
          </label>
          <label className="app-create-row app-create-description-row">
            <span>{t("wizard.description")}</span>
            <textarea
              value={props.description}
              disabled={disabled}
              placeholder={t("wizard.descriptionPlaceholder")}
              onChange={(event) => props.onDescriptionChange(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="app-create-section">
        <h3>{t("wizard.localDirectory")}</h3>
        <div className="app-create-group">
          <label className="app-create-row">
            <span>{t("wizard.localDirectory")}</span>
            <div className="app-create-source-field">
              <input
                value={props.source}
                disabled={disabled}
                placeholder={t("wizard.sourcePlaceholder")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canRequestAgent) {
                    props.onRequestAgent(buildRequest(props, canImport ? undefined : selectedIcon));
                  }
                }}
                onChange={(event) => props.onSourceChange(event.target.value)}
              />
              <button
                type="button"
                disabled={disabled || props.localFolderPicking || !canAttemptFolderPick}
                onClick={props.onChooseLocalFolder}
                title={t("wizard.chooseLocalFolder")}
                aria-label={t("wizard.chooseLocalFolder")}
              >
                <ProductIcon name="external" size={17} />
              </button>
            </div>
          </label>
        </div>
      </section>

      {props.error ? <div className="app-create-error">{rawDiagnosticText(props.error)}</div> : null}

      <div className="settings-form-actions">
        {props.onOpenStore ? (
          <button type="button" disabled={disabled} onClick={props.onOpenStore}>
            <ProductIcon name="store" size={17} />
            {t("wizard.browseStore")}
          </button>
        ) : null}
        <button type="button" disabled={disabled} onClick={props.onCancel}>
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          type="button"
          disabled={disabled || !canRequestAgent || !props.canRequestAgent}
          onClick={() => props.onRequestAgent(buildRequest(props, canImport ? undefined : selectedIcon))}
        >
          <ProductIcon name="add" size={17} />
          {t("wizard.createAndOpen")}
        </button>
      </div>
    </div>
  );
}

function buildRequest(props: Parameters<typeof AppCreateWizard>[0], icon: string | undefined): AppBuilderRequest {
  const source = props.source.trim();
  const description = props.description.trim();
  return {
    mode: source ? "import" : "describe",
    title: props.title.trim() || undefined,
    source: source || undefined,
    description: description || undefined,
    icon: source ? undefined : icon,
  };
}
