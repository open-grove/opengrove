import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clamp } from "../format";
import { APP_STORAGE_KEYS } from "../identity";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, readStoredSidebarWidth } from "./app-shell-state";
import { MIN_COMPOSER_HEIGHT } from "./ui-model";

export function useAppLayoutResize(options: { composerHeight: number; setComposerHeight(height: number): void }) {
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const composerResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const composerResizeCleanupRef = useRef<(() => void) | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (options.composerHeight > 64) {
      options.setComposerHeight(MIN_COMPOSER_HEIGHT);
    }
  }, [options.composerHeight, options.setComposerHeight]);

  useEffect(
    () => () => {
      composerResizeCleanupRef.current?.();
      sidebarResizeCleanupRef.current?.();
    },
    [],
  );

  function onComposerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-action='resize-composer']");
    if (!handle) {
      return;
    }
    event.preventDefault();
    composerResizeCleanupRef.current?.();
    composerResizeRef.current = {
      startY: event.clientY,
      startHeight: options.composerHeight,
    };
    composerResizeCleanupRef.current = beginPointerDrag({
      handle,
      pointerId: event.pointerId,
      onMove(pointerEvent) {
        const resize = composerResizeRef.current;
        if (!resize) return;
        options.setComposerHeight(resize.startHeight + resize.startY - pointerEvent.clientY);
      },
      onFinish() {
        composerResizeRef.current = null;
        composerResizeCleanupRef.current = null;
      },
    });
  }

  function onSidebarResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    sidebarResizeCleanupRef.current?.();
    const handle = event.currentTarget;
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    document.body.dataset.sidebarResizing = "true";
    sidebarResizeCleanupRef.current = beginPointerDrag({
      handle,
      pointerId: event.pointerId,
      onMove(pointerEvent) {
        const resize = sidebarResizeRef.current;
        if (!resize) return;
        const nextWidth = clamp(
          resize.startWidth + pointerEvent.clientX - resize.startX,
          MIN_SIDEBAR_WIDTH,
          MAX_SIDEBAR_WIDTH,
        );
        setSidebarWidth(nextWidth);
        window.localStorage.setItem(APP_STORAGE_KEYS.sidebarWidth, String(Math.round(nextWidth)));
      },
      onFinish() {
        sidebarResizeRef.current = null;
        delete document.body.dataset.sidebarResizing;
        sidebarResizeCleanupRef.current = null;
      },
    });
  }

  return {
    sidebarWidth,
    onComposerPointerDown,
    onSidebarResizePointerDown,
  };
}

function beginPointerDrag(options: {
  handle: HTMLElement;
  pointerId: number;
  onMove(event: PointerEvent): void;
  onFinish(): void;
}) {
  let active = true;

  function finish(event?: Event) {
    if (!active) return;
    if (event instanceof PointerEvent && event.pointerId !== options.pointerId) return;
    active = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.removeEventListener("visibilitychange", finishWhenHidden);
    options.handle.removeEventListener("lostpointercapture", finish);
    try {
      if (options.handle.hasPointerCapture(options.pointerId)) {
        options.handle.releasePointerCapture(options.pointerId);
      }
    } catch {
      // non-critical-fallback: A detached handle needs no pointer-capture release before finishing resize.
    }
    options.onFinish();
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== options.pointerId) return;
    if (event.buttons === 0) {
      finish(event);
      return;
    }
    options.onMove(event);
  }

  function finishWhenHidden() {
    if (document.visibilityState === "hidden") finish();
  }

  try {
    options.handle.setPointerCapture(options.pointerId);
  } catch {
    // Window listeners still provide a safe fallback when capture is unavailable.
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  document.addEventListener("visibilitychange", finishWhenHidden);
  options.handle.addEventListener("lostpointercapture", finish);

  return () => finish();
}
