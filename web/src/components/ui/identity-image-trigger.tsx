import type { ReactNode } from "react";
import { ProductIcon } from "./product-icon";
import styles from "./identity-image-trigger.module.css";

export function IdentityImageTrigger(props: {
  label: string;
  title?: string;
  shape?: "circle" | "rounded";
  disabled?: boolean;
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <div className={styles.field}>
      <button
        className={styles.trigger}
        type="button"
        data-shape={props.shape ?? "circle"}
        disabled={props.disabled}
        aria-label={props.label}
        onClick={props.onClick}
      >
        <span className={styles.preview}>{props.children}</span>
        <span className={styles.badge} aria-hidden="true">
          <ProductIcon name="camera" size={17} />
        </span>
      </button>
      {props.title ? <strong className={styles.title}>{props.title}</strong> : null}
    </div>
  );
}
