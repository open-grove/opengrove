import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { KernelOption, KernelPathOverride } from "../../bridge";
import type { TranslationFn } from "../../i18n";
import { KernelIcon } from "../ui/entity-icons";
import styles from "./settings-kernel-panel.module.css";

export function SettingsKernelPanel(props: {
  t: TranslationFn;
  kernels: KernelOption[];
  expandedKernelId: string;
  kernelPathOverrides: Record<string, KernelPathOverride>;
  loading: boolean;
  saving: boolean;
  installingKernelId?: string;
  onToggleKernelExpanded(kernelId: string): void;
  onInstallKernel?(kernelId: string, actionId: string): void;
  onSetKernelPathDraft(kernelId: string, key: keyof KernelPathOverride, value: string): void;
  onSaveKernelPathOverride(kernelId: string, patch?: Partial<KernelPathOverride>): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className={styles.list}>
          {props.kernels.map((option) => {
            const expanded = props.expandedKernelId === option.id;
            const installAction = (option.installActions ?? []).find((action) => action.command?.length);
            const canInstall = !option.available && option.installed !== true && installAction && props.onInstallKernel;
            const installing = props.installingKernelId === option.id;
            const installInFlight = Boolean(props.installingKernelId);

            return (
              <div
                key={option.id}
                className={clsx(styles.item, expanded && styles.expanded)}
                data-kernel-choice
                data-active="false"
              >
                <div className={styles.row}>
                  <button
                    className={styles.rowMain}
                    type="button"
                    aria-expanded={expanded}
                    disabled={props.saving || props.loading}
                    onClick={() => props.onToggleKernelExpanded(option.id)}
                  >
                    <KernelIcon kernelId={option.id} className={styles.icon} size={18} />
                    <span className={styles.main}>
                      <strong>{option.label}</strong>
                    </span>
                  </button>
                  <span className={styles.action}>
                    {canInstall ? (
                      <button
                        className={styles.installButton}
                        type="button"
                        disabled={installInFlight || props.saving || props.loading}
                        onClick={() => props.onInstallKernel?.(option.id, installAction.id)}
                      >
                        {installing ? t("common.installing") : t("common.install")}
                      </button>
                    ) : null}
                    <button
                      className={styles.expandButton}
                      type="button"
                      aria-label={expanded ? t("settings.collapseKernel") : t("settings.expandKernel")}
                      aria-expanded={expanded}
                      disabled={props.saving || props.loading}
                      onClick={() => props.onToggleKernelExpanded(option.id)}
                    >
                      <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
                    </button>
                  </span>
                </div>

                {expanded ? (
                  <div className={styles.expandedPanel}>
                    <label className={styles.detailRow} data-kernel-detail-row>
                      <strong>{t("settings.executablePath")}</strong>
                      <input
                        value={props.kernelPathOverrides[option.id]?.binaryPath ?? option.binaryPath ?? ""}
                        disabled={props.loading || props.saving}
                        placeholder={option.binaryPath || "/path/to/command"}
                        onBlur={(event) =>
                          props.onSaveKernelPathOverride(option.id, { binaryPath: event.currentTarget.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        onChange={(event) => props.onSetKernelPathDraft(option.id, "binaryPath", event.target.value)}
                      />
                    </label>
                    <label className={styles.detailRow} data-kernel-detail-row>
                      <strong>{t("settings.kernelConfigDirectory")}</strong>
                      <input
                        value={props.kernelPathOverrides[option.id]?.configHome ?? option.configHome ?? ""}
                        disabled={props.loading || props.saving}
                        placeholder={option.configHome || "~/.config"}
                        onBlur={(event) =>
                          props.onSaveKernelPathOverride(option.id, { configHome: event.currentTarget.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        onChange={(event) => props.onSetKernelPathDraft(option.id, "configHome", event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
