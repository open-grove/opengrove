import { useId } from "react";
import { Cloud } from "lucide-react";
import { useI18n } from "../../i18n";
import { MotionMenuItem } from "../ui/motion/menu";
import type { NetworkConfiguration } from "./use-network-configuration";
import styles from "./remote-agent-menu-item.module.css";

export function RemoteAgentMenuItem(props: { configuration: NetworkConfiguration; onSelect(): void }) {
  const { t } = useI18n();
  const descriptionId = useId();
  const status = props.configuration.status;
  const available = status === "configured";
  const description =
    status === "loading"
      ? t("remoteAgent.configurationLoading")
      : status === "error"
        ? t("remoteAgent.configurationError")
        : status === "unconfigured"
          ? t("remoteAgent.notConfigured")
          : undefined;
  return (
    <MotionMenuItem
      aria-label={t("remoteAgent.add")}
      aria-disabled={!available && status !== "error"}
      aria-describedby={description ? descriptionId : undefined}
      closeOnClick={available}
      label={t("remoteAgent.add")}
      onClick={() => {
        if (available) props.onSelect();
        else if (status === "error") props.configuration.retry();
      }}
    >
      <Cloud size={17} aria-hidden />
      <span className={styles.label}>
        <span>{t("remoteAgent.add")}</span>
        {description ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </span>
    </MotionMenuItem>
  );
}
