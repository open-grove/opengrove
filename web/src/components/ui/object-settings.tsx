import type { ReactNode } from "react";
import clsx from "clsx";
import { ProductIcon, type ProductIconName } from "./product-icon";
import styles from "./object-settings.module.css";

export function ObjectSettingsSection(props: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx(styles.section, props.className)}>
      {props.title || props.action ? (
        <header className={styles.sectionHeader}>
          {props.title ? <h3>{props.title}</h3> : <span />}
          {props.action}
        </header>
      ) : null}
      <div className={styles.group}>{props.children}</div>
    </section>
  );
}
export function ObjectSettingsRow(props: {
  icon?: ProductIconName;
  leading?: ReactNode;
  title: ReactNode;
  value?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const content = (
    <>
      {props.leading ??
        (props.icon ? (
          <span className={styles.icon}>
            <ProductIcon name={props.icon} size={20} />
          </span>
        ) : null)}
      <span className={styles.copy}>
        <strong>{props.title}</strong>
        {props.detail != null ? <small>{props.detail}</small> : null}
      </span>
      {props.value != null ? <span className={styles.value}>{props.value}</span> : null}
      {props.trailing ??
        (props.onClick ? (
          <span className={styles.chevron}>
            <ProductIcon name="next" size={18} />
          </span>
        ) : null)}
    </>
  );

  if (props.onClick) {
    return (
      <button
        className={clsx(styles.row, styles.button, props.className)}
        type="button"
        disabled={props.disabled}
        onClick={props.onClick}
        aria-label={props.ariaLabel}
      >
        {content}
      </button>
    );
  }

  return <div className={clsx(styles.row, props.className)}>{content}</div>;
}

export type ProductStatusTone = "running" | "success" | "warning" | "error" | "neutral";

export function ProductStatus(props: {
  tone: ProductStatusTone;
  label: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const icon: ProductIconName =
    props.tone === "running"
      ? "loading"
      : props.tone === "success"
        ? "success"
        : props.tone === "warning"
          ? "warning"
          : props.tone === "error"
            ? "error"
            : "info";
  return (
    <span
      className={clsx(styles.status, props.compact && styles.statusCompact, props.className)}
      data-tone={props.tone}
    >
      <ProductIcon name={icon} size={props.compact ? 15 : 17} />
      <span>{props.label}</span>
    </span>
  );
}
