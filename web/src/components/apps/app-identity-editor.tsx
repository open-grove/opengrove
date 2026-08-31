import { useI18n } from "../../i18n";
import { AppIconPickerField } from "./app-icon-picker";
import styles from "./app-identity-editor.module.css";

export interface AppIdentityDraft {
  title: string;
  description: string;
  icon?: string;
}

export function AppIdentityEditor(props: {
  value: AppIdentityDraft;
  disabled?: boolean;
  onChange(value: AppIdentityDraft): void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.editor}>
      <AppIconPickerField
        value={props.value.icon}
        title={props.value.title || t("app.createApp")}
        disabled={props.disabled}
        onChange={(icon) => props.onChange({ ...props.value, icon })}
      />
      <div className={styles.fields}>
        <label className={styles.row}>
          <span>
            {t("appStore.release.nameLabel")} <em>*</em>
          </span>
          <input
            value={props.value.title}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ ...props.value, title: event.target.value })}
          />
        </label>
        <label className={`${styles.row} ${styles.stacked}`}>
          <span>{t("appStore.release.descriptionLabel")}</span>
          <textarea
            value={props.value.description}
            disabled={props.disabled}
            rows={4}
            onChange={(event) => props.onChange({ ...props.value, description: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
