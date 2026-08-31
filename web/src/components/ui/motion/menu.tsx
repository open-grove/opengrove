import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import type { ButtonHTMLAttributes, ReactElement, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { Tooltip } from "../tooltip";
import styles from "./menu.module.css";
import overlayStyles from "./overlay-surface.module.css";
import type { BoundedOverlaySurfaceSize, OverlaySurfaceSize } from "./overlay-surface";

type MenuSide = "top" | "bottom" | "left" | "right";
type MenuAlign = "start" | "center" | "end";
export function MotionMenu(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
  side?: MenuSide;
  align?: MenuAlign;
  sideOffset?: number;
  collisionPadding?: number;
  ariaLabel?: string;
  size?: OverlaySurfaceSize;
  tooltipContent?: ReactNode;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const reduceMotion = useReducedMotion();
  const side = props.side ?? "bottom";
  const closedOffset =
    side === "top"
      ? { x: 0, y: 4 }
      : side === "bottom"
        ? { x: 0, y: -4 }
        : side === "left"
          ? { x: 4, y: 0 }
          : { x: -4, y: 0 };

  return (
    <MenuPrimitive.Root open={props.open} onOpenChange={(open) => props.onOpenChange(open)} modal={false}>
      {props.tooltipContent ? (
        <Tooltip content={props.tooltipContent} side={props.tooltipSide}>
          <MenuPrimitive.Trigger nativeButton render={props.trigger} />
        </Tooltip>
      ) : (
        <MenuPrimitive.Trigger nativeButton render={props.trigger} />
      )}
      <AnimatePresence>
        {props.open ? (
          <MenuPrimitive.Portal keepMounted>
            <MenuPrimitive.Positioner
              className={styles.positioner}
              side={side}
              align={props.align ?? "end"}
              sideOffset={props.sideOffset ?? 6}
              collisionPadding={props.collisionPadding ?? 8}
            >
              <MenuPrimitive.Popup
                aria-label={props.ariaLabel}
                className={clsx(overlayStyles.surface, overlayStyles.baseSurface, styles.popup, props.className)}
                data-overlay-surface=""
                data-size={props.size ?? "content"}
                render={
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.98, ...closedOffset }}
                    animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, ...closedOffset }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  />
                }
              >
                {props.children}
              </MenuPrimitive.Popup>
            </MenuPrimitive.Positioner>
          </MenuPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </MenuPrimitive.Root>
  );
}

export function MotionContextMenu(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  size?: BoundedOverlaySurfaceSize;
  collisionPadding?: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <ContextMenuPrimitive.Root open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <ContextMenuPrimitive.Trigger render={props.trigger} />
      <AnimatePresence initial={false}>
        {props.open ? (
          <ContextMenuPrimitive.Portal keepMounted>
            <ContextMenuPrimitive.Positioner
              className={styles.positioner}
              positionMethod="fixed"
              side="bottom"
              align="start"
              sideOffset={2}
              collisionPadding={props.collisionPadding ?? 8}
            >
              <ContextMenuPrimitive.Popup
                aria-label={props.ariaLabel}
                className={clsx(overlayStyles.surface, overlayStyles.baseSurface, styles.popup, props.className)}
                data-overlay-surface=""
                data-size={props.size ?? "content"}
                render={
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  />
                }
              >
                {props.children}
              </ContextMenuPrimitive.Popup>
            </ContextMenuPrimitive.Positioner>
          </ContextMenuPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </ContextMenuPrimitive.Root>
  );
}

type MotionMenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> & {
  children: ReactNode;
  className?: string;
  danger?: boolean;
  closeOnClick?: boolean;
  label?: string;
};

export function MotionMenuItem({
  children,
  className,
  danger,
  closeOnClick,
  label,
  ...buttonProps
}: MotionMenuItemProps) {
  const { onClick, ...renderButtonProps } = buttonProps;
  return (
    <MenuPrimitive.Item
      className={clsx(styles.item, className)}
      closeOnClick={closeOnClick ?? true}
      disabled={buttonProps.disabled}
      nativeButton
      label={label}
      onClick={onClick ? (event) => onClick(event as unknown as ReactMouseEvent<HTMLButtonElement>) : undefined}
      data-danger={danger ? "true" : undefined}
      render={<button {...renderButtonProps} type={renderButtonProps.type ?? "button"} />}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

export function MotionMenuSeparator({ className }: { className?: string }) {
  return <MenuPrimitive.Separator className={clsx(styles.separator, className)} />;
}

export const MotionMenuSurface = forwardRef<
  HTMLDivElement,
  HTMLMotionProps<"div"> & {
    size?: OverlaySurfaceSize;
  }
>(function MotionMenuSurface({ className, size = "content", ...props }, ref) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      {...props}
      ref={ref}
      className={clsx(overlayStyles.surface, styles.popup, className)}
      data-overlay-surface=""
      data-size={size}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    />
  );
});
