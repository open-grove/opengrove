import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { getRailMode, RAIL_MAX_WIDTH } from "../../runtime/app-rail-layout-model";
import type { AppRailLayoutController } from "../../runtime/use-app-rail-layout";
import { ResizeHandle } from "../ui/resize-handle";
import clsx from "clsx";
import styles from "./app-navigation-panel.module.css";

export function AppNavigationPanel(props: {
  layout: AppRailLayoutController;
  overlayOpen: boolean;
  children(expanded: boolean): ReactNode;
}) {
  const { t } = useI18n();
  const { layout } = props;
  const hidden = layout.mode === "hidden";
  const [floating, setFloating] = useState(false);
  const pointerInside = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocked = useRef(false);
  blocked.current = props.overlayOpen || layout.isResizing;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    if (panelRef.current?.contains(document.activeElement)) {
      document.getElementById("app-navigation-toggle")?.focus({ preventScroll: true });
    }
    setFloating(false);
  }, [clearTimers]);

  const scheduleDismiss = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(function closeAfterOverlays() {
      closeTimer.current = null;
      if (blocked.current || pointerInside.current) return;
      // Confirm dialogs can be owned by the shell rather than a navigation item.
      const modalOpen = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
        (node) => node.getBoundingClientRect().width > 0,
      );
      if (modalOpen) {
        closeTimer.current = setTimeout(closeAfterOverlays, 300);
        return;
      }
      dismiss();
    }, 300);
  }, [dismiss]);

  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => {
    if (!hidden) {
      clearTimers();
      setFloating(false);
    } else if (props.overlayOpen || layout.isResizing) clearTimers();
    else if (floating && !pointerInside.current) scheduleDismiss();
  }, [hidden, props.overlayOpen, layout.isResizing, floating, clearTimers, scheduleDismiss]);

  const panelWidth = hidden ? layout.lastVisibleWidth : layout.width;
  const expanded = getRailMode(panelWidth) === "full";
  const inactive = hidden && !floating;

  return (
    <div
      className={clsx("app-navigation-slot", styles.slot)}
      data-mode={layout.mode}
      data-floating={hidden && floating ? "true" : "false"}
      data-resizing={layout.isResizing ? "true" : "false"}
      onPointerEnter={(event) => {
        pointerInside.current = true;
        clearTimers();
        if (hidden && !floating && !layout.isResizing && event.pointerType !== "touch") {
          openTimer.current = setTimeout(() => setFloating(true), 200);
        }
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        clearTimers();
        if (hidden && floating) scheduleDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && floating && !props.overlayOpen) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div
        id="app-main-navigation"
        className={clsx("app-navigation-panel", styles.panel)}
        ref={panelRef}
        style={{ width: panelWidth }}
        aria-hidden={inactive || undefined}
        inert={inactive}
      >
        {props.children(expanded)}
      </div>
      <ResizeHandle
        className={clsx("app-navigation-resize-handle", styles.handle)}
        aria-label={t("shell.resizeMainNav")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={RAIL_MAX_WIDTH}
        aria-valuenow={layout.width}
        tabIndex={0}
        style={{ left: hidden ? (floating ? panelWidth : 4) : `calc(${panelWidth}px + var(--app-page-inline-inset))` }}
        onPointerDown={(event) => {
          clearTimers();
          layout.onResizePointerDown(event, hidden && !floating ? 0 : panelWidth);
        }}
        onKeyDown={layout.onResizeKeyDown}
      />
    </div>
  );
}
