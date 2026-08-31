import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronsUpDown } from "lucide-react";
import { MotionPopover } from "../ui/motion/popover";
import type { BoundedOverlaySurfaceSize } from "../ui/motion/overlay-surface";
import styles from "../shared/inline-select.module.css";

export type RoomInlineSelectOption = {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  tone?: "danger";
};

export function RoomInlineSelect(props: {
  value: string;
  options: RoomInlineSelectOption[];
  onChange(value: string): void;
  className?: string;
  menuSize?: BoundedOverlaySurfaceSize;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.options.find((option) => option.id === props.value) ??
    props.options[0] ?? { id: props.value, label: props.value };
  const hasDescriptions = props.options.some((option) => Boolean(option.description));

  return (
    <span className={clsx(styles.root, styles.contactsRoot, props.className)} data-inline-select>
      <MotionPopover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="start"
        size={props.menuSize ?? (hasDescriptions ? "wide" : "content")}
        className={clsx(styles.menu, styles.contactsMenu)}
        role="listbox"
        trigger={
          <button
            className={styles.trigger}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            data-tone={selected.tone}
            data-inline-select-button
          >
            <span className={styles.value}>
              {selected.icon ? <span className={styles.icon}>{selected.icon}</span> : null}
              <span>{selected.label}</span>
            </span>
            <ChevronsUpDown size={14} />
          </button>
        }
      >
        {props.options.map((option) => (
          <button
            className={styles.option}
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === props.value}
            data-tone={option.tone}
            onClick={() => {
              props.onChange(option.id);
              setOpen(false);
            }}
          >
            <span className={styles.optionCopy}>
              {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
              <span>
                <strong title={option.label}>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
            </span>
          </button>
        ))}
      </MotionPopover>
    </span>
  );
}
