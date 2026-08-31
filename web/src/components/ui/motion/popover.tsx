import * as PopoverPrimitive from "@radix-ui/react-popover";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AriaRole, ComponentPropsWithoutRef, ReactElement, ReactNode, RefObject } from "react";
import overlayStyles from "./overlay-surface.module.css";
import type { OverlaySurfaceSize } from "./overlay-surface";

// Radix owns positioning, collision handling, focus, dismissal, and keyboard
// behavior. Motion supplies the subtle origin-aware enter/exit transition.
type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>;

type MotionPopoverProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
  className?: string;
  side: "top" | "bottom";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
  size?: OverlaySurfaceSize;
  role?: AriaRole;
  ariaLabel?: string;
  onOpenAutoFocus?: PopoverContentProps["onOpenAutoFocus"];
  onCloseAutoFocus?: PopoverContentProps["onCloseAutoFocus"];
  onFocusOutside?: PopoverContentProps["onFocusOutside"];
  onInteractOutside?: PopoverContentProps["onInteractOutside"];
} & (
  | { trigger: ReactElement; anchorRef?: RefObject<HTMLElement | null> }
  | { trigger?: never; anchorRef: RefObject<HTMLElement | null> }
);

export function MotionPopover(props: MotionPopoverProps) {
  const reduceMotion = useReducedMotion();
  const closedY = props.side === "top" ? 6 : -6;

  return (
    <PopoverPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      {props.anchorRef && (!props.trigger || props.open) ? (
        <PopoverPrimitive.Anchor virtualRef={props.anchorRef as PopoverPrimitive.PopoverAnchorProps["virtualRef"]} />
      ) : null}
      {props.trigger ? <PopoverPrimitive.Trigger asChild>{props.trigger}</PopoverPrimitive.Trigger> : null}
      <AnimatePresence>
        {props.open ? (
          <PopoverPrimitive.Content
            asChild
            forceMount
            side={props.side}
            align={props.align}
            sideOffset={props.sideOffset ?? 8}
            collisionPadding={props.collisionPadding ?? 12}
            onOpenAutoFocus={props.onOpenAutoFocus}
            onCloseAutoFocus={props.onCloseAutoFocus}
            onFocusOutside={props.onFocusOutside}
            onInteractOutside={props.onInteractOutside}
          >
            <motion.div
              className={clsx(
                props.size && overlayStyles.surface,
                props.size && overlayStyles.radixSurface,
                props.className,
              )}
              data-overlay-surface={props.size ? "" : undefined}
              data-size={props.size}
              role={props.role}
              aria-label={props.ariaLabel}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: closedY }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98, y: closedY }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
            >
              {props.children}
            </motion.div>
          </PopoverPrimitive.Content>
        ) : null}
      </AnimatePresence>
    </PopoverPrimitive.Root>
  );
}
