import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { APP_STORAGE_KEYS } from "../identity";
import { migrateAppRailLayout } from "../migrations/app-rail-layout";
import { beginPointerDrag } from "./app-layout-resize";
import {
  commitRailWidth,
  getRailMode,
  parseRailLayout,
  previewRailWidth,
  RAIL_FULL_MIN_WIDTH,
  RAIL_ICON_WIDTH,
  RAIL_MAX_WIDTH,
  settleRailWidth,
  toggleRailLayout,
  type RailLayout,
} from "./app-rail-layout-model";

function readRailLayout(): RailLayout {
  const fallback = { width: RAIL_FULL_MIN_WIDTH, lastVisibleWidth: RAIL_FULL_MIN_WIDTH };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(APP_STORAGE_KEYS.railLayout);
    return raw === null ? migrateAppRailLayout(window.localStorage) : (parseRailLayout(raw) ?? fallback);
  } catch (error) {
    console.warn("[opengrove-ui] navigation preference could not be read", error);
    return fallback;
  }
}

export function useAppRailLayout() {
  const [layout, setLayout] = useState(readRailLayout);
  const layoutRef = useRef(layout);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeCleanup = useRef<(() => void) | null>(null);

  const persist = useCallback((next: RailLayout) => {
    layoutRef.current = next;
    setLayout(next);
    try {
      window.localStorage.setItem(APP_STORAGE_KEYS.railLayout, JSON.stringify(next));
    } catch (error) {
      console.warn("[opengrove-ui] navigation preference could not be saved", error);
    }
  }, []);

  useEffect(() => () => resizeCleanup.current?.(), []);

  const toggle = useCallback(() => persist(toggleRailLayout(layoutRef.current)), [persist]);

  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>, displayedWidth: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const scale = handle.getBoundingClientRect().width / handle.offsetWidth || 1;
    const before = layoutRef.current;
    let nextWidth = displayedWidth;
    let moved = false;
    setIsResizing(true);
    document.body.dataset.railResizing = "true";
    resizeCleanup.current = beginPointerDrag({
      handle,
      pointerId: event.pointerId,
      onMove(pointer) {
        const delta = (pointer.clientX - startX) / scale;
        if (!moved && Math.abs(delta) < 3) return;
        moved = true;
        nextWidth = previewRailWidth(displayedWidth + delta);
        setPreviewWidth(nextWidth);
      },
      onFinish(finishEvent) {
        const cancelled = !finishEvent || finishEvent.type === "pointercancel" || finishEvent.type === "keydown";
        if (moved && !cancelled) persist(commitRailWidth(before, settleRailWidth(nextWidth, displayedWidth)));
        setPreviewWidth(null);
        setIsResizing(false);
        delete document.body.dataset.railResizing;
        resizeCleanup.current = null;
      },
    });
  }

  function onResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = layoutRef.current;
    let width: number;
    if (event.key === "Home") width = 0;
    else if (event.key === "End") width = RAIL_MAX_WIDTH;
    else if (event.key === "ArrowLeft") {
      width =
        current.width <= RAIL_ICON_WIDTH
          ? 0
          : current.width <= RAIL_FULL_MIN_WIDTH
            ? RAIL_ICON_WIDTH
            : Math.max(RAIL_FULL_MIN_WIDTH, current.width - 10);
    } else if (event.key === "ArrowRight") {
      width =
        current.width === 0
          ? RAIL_ICON_WIDTH
          : current.width === RAIL_ICON_WIDTH
            ? RAIL_FULL_MIN_WIDTH
            : Math.min(RAIL_MAX_WIDTH, current.width + 10);
    } else return;
    event.preventDefault();
    persist(commitRailWidth(current, width));
  }

  const width = previewWidth ?? layout.width;
  return {
    width,
    mode: getRailMode(width),
    lastVisibleWidth: layout.lastVisibleWidth,
    isResizing,
    toggle,
    onResizePointerDown,
    onResizeKeyDown,
  };
}

export type AppRailLayoutController = ReturnType<typeof useAppRailLayout>;
