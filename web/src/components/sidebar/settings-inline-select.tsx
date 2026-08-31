import { useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import { MotionPopover } from "../ui/motion/popover";
import type { BoundedOverlaySurfaceSize } from "../ui/motion/overlay-surface";
import styles from "../shared/inline-select.module.css";

export type InlineSelectOption = { id: string; label: string; icon?: ReactNode };

export function InlineSelect(props: {
  value: string;
  options: InlineSelectOption[];
  align?: "start" | "center" | "end";
  menuSize?: BoundedOverlaySurfaceSize;
  sideOffset?: number;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.options.find((option) => option.id === props.value) ?? props.options[0];

  return (
    <span className={styles.root} data-inline-select data-open={open ? "true" : "false"}>
      <MotionPopover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align={props.align ?? "start"}
        sideOffset={props.sideOffset}
        className={styles.menu}
        size={props.menuSize ?? "content"}
        role="listbox"
        trigger={
          <button
            className={styles.trigger}
            type="button"
            disabled={props.disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-inline-select-button
          >
            <span className={styles.value}>
              {selected?.icon ? <span className={styles.icon}>{selected.icon}</span> : null}
              <span>{selected?.label}</span>
            </span>
            <ChevronsUpDown size={14} />
          </button>
        }
      >
        {props.options.map((option) => (
          <button
            className={styles.option}
            key={option.id || "native"}
            type="button"
            role="option"
            aria-selected={option.id === props.value}
            onClick={() => {
              props.onChange(option.id);
              setOpen(false);
            }}
          >
            <span className={styles.value}>
              {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
              <span>{option.label}</span>
            </span>
          </button>
        ))}
      </MotionPopover>
    </span>
  );
}
