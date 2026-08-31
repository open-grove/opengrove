import type { ReactNode } from "react";
import clsx from "clsx";
import styles from "./unread-count.module.css";

export type UnreadCountVariant = "primary" | "danger";

export function formatUnreadCount(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export function UnreadCount(props: { count: number; className?: string; variant?: UnreadCountVariant }) {
  const label = formatUnreadCount(props.count);
  if (!label) return null;
  return (
    <span className={clsx(styles.count, props.className)} data-variant={props.variant ?? "primary"} aria-hidden="true">
      {label}
    </span>
  );
}

export function UnreadCountAnchor(props: {
  children: ReactNode;
  count: number;
  className?: string;
  variant?: UnreadCountVariant;
}) {
  return (
    <span className={clsx(styles.anchor, props.className)}>
      {props.children}
      <UnreadCount count={props.count} className={styles.anchoredCount} variant={props.variant} />
    </span>
  );
}
