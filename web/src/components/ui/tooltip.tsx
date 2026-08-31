import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import styles from "./tooltip.module.css";

type TooltipSide = "top" | "bottom" | "left" | "right";
type TooltipAlign = "start" | "center" | "end";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={450} closeDelay={0} timeout={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip(props: {
  children: ReactElement;
  content: ReactNode;
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  disabled?: boolean;
}) {
  return (
    <TooltipPrimitive.Root disabled={props.disabled}>
      <TooltipPrimitive.Trigger render={props.children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          className={styles.positioner}
          side={props.side ?? "top"}
          align={props.align ?? "center"}
          sideOffset={props.sideOffset ?? 8}
          collisionPadding={12}
        >
          <TooltipPrimitive.Popup className={styles.popup} role="tooltip">
            {props.content}
            <TooltipPrimitive.Arrow className={styles.arrow} />
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
