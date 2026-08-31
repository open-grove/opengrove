import type { ReactNode } from "react";
import clsx from "clsx";

import { useI18n } from "../../i18n";
import styles from "./directory-panel.module.css";

export function DirectoryPanel(props: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  "aria-label"?: string;
}) {
  const { t } = useI18n();
  return (
    <section className={clsx("directory-panel", styles.panel, props.className)} aria-label={props["aria-label"]}>
      <div className={clsx("directory-panel-header", styles.header)}>
        <div className={clsx("directory-panel-title-block", styles.titleBlock)}>
          {props.kicker ? <div className={clsx("directory-panel-kicker", styles.kicker)}>{props.kicker}</div> : null}
          <div className={clsx("directory-panel-title", styles.title)}>{props.title}</div>
        </div>
        {props.actions ? (
          <div
            className={clsx("directory-panel-actions", styles.actions, styles.actionsActive)}
            aria-label={t("filePreview.directoryActions")}
          >
            {props.actions}
          </div>
        ) : null}
      </div>
      {props.status ? <div className={clsx("directory-panel-status", styles.status)}>{props.status}</div> : null}
      {props.search}
      <div className={clsx("directory-panel-body", styles.body, props.bodyClassName)}>{props.children}</div>
    </section>
  );
}
