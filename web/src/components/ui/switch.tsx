import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import clsx from "clsx";
import styles from "./switch.module.css";

export function Switch(props: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <SwitchPrimitive.Root
      className={clsx(styles.root, props.className)}
      checked={props.checked}
      disabled={props.disabled}
      onCheckedChange={props.onCheckedChange}
      aria-label={props.ariaLabel}
    >
      <SwitchPrimitive.Thumb className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
}
