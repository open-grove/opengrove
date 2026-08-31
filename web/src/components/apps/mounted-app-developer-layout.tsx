import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clamp } from "../../format";
import { useI18n } from "../../i18n";
import "./mounted-app-workbench.css";

const DEFAULT_DEVELOPER_PANEL_WIDTH = 420;
const MIN_DEVELOPER_PANEL_WIDTH = 280;
const MAX_DEVELOPER_PANEL_WIDTH = 860;
const MIN_APP_CANVAS_WIDTH = 320;
const RESIZE_HANDLE_WIDTH = 10;

export function MountedAppDeveloperLayout(props: { appId: string; open: boolean; canvas: ReactNode; chat: ReactNode }) {
  const { t } = useI18n();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    handle: HTMLDivElement;
    startX: number;
    startWidth: number;
    containerWidth: number;
  } | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => readStoredDeveloperPanelWidth(props.appId));

  useEffect(() => {
    const containerWidth = layoutRef.current?.getBoundingClientRect().width ?? 0;
    setPanelWidth(constrainDeveloperPanelWidth(readStoredDeveloperPanelWidth(props.appId), containerWidth));
  }, [props.appId]);

  function persistPanelWidth(width: number, containerWidth: number) {
    const nextWidth = Math.round(constrainDeveloperPanelWidth(width, containerWidth));
    setPanelWidth(nextWidth);
    try {
      window.localStorage.setItem(developerPanelWidthStorageKey(props.appId), String(nextWidth));
    } catch {
      // Resizing remains available for the current session when persistence is unavailable.
    }
  }

  function beginPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !props.open) return;
    event.preventDefault();
    const containerWidth = layoutRef.current?.getBoundingClientRect().width ?? 0;
    resizeRef.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      startX: event.clientX,
      startWidth: constrainDeveloperPanelWidth(panelWidth, containerWidth),
      containerWidth,
    };
    event.currentTarget.dataset.resizing = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    persistPanelWidth(resize.startWidth - (event.clientX - resize.startX), resize.containerWidth);
  }

  function finishPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    delete resize.handle.dataset.resizing;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function adjustPanelWidthWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const step = event.shiftKey ? 40 : 16;
    const containerWidth = layoutRef.current?.getBoundingClientRect().width ?? 0;
    persistPanelWidth(panelWidth - direction * step, containerWidth);
  }

  return (
    <div
      ref={layoutRef}
      className="mounted-app-developer-layout"
      data-open={props.open ? "true" : "false"}
      style={{ "--mounted-app-developer-panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <main className="mounted-app-developer-canvas">{props.canvas}</main>
      <div
        className="mounted-app-resize-handle mounted-app-developer-resize-handle"
        role="separator"
        aria-label={t("mountedApp.resizeChat")}
        aria-orientation="vertical"
        aria-valuemin={MIN_DEVELOPER_PANEL_WIDTH}
        aria-valuemax={MAX_DEVELOPER_PANEL_WIDTH}
        aria-valuenow={panelWidth}
        tabIndex={props.open ? 0 : -1}
        onKeyDown={adjustPanelWidthWithKeyboard}
        onPointerCancel={finishPanelResize}
        onPointerDown={beginPanelResize}
        onPointerMove={updatePanelResize}
        onPointerUp={finishPanelResize}
      />
      <aside className="mounted-app-developer-chat" aria-label={t("mountedApp.developerChatLabel")}>
        {props.chat}
      </aside>
    </div>
  );
}

function constrainDeveloperPanelWidth(width: number, containerWidth: number): number {
  if (!containerWidth) return clamp(width, MIN_DEVELOPER_PANEL_WIDTH, MAX_DEVELOPER_PANEL_WIDTH);
  const available = containerWidth - MIN_APP_CANVAS_WIDTH - RESIZE_HANDLE_WIDTH;
  const maximum = Math.max(MIN_DEVELOPER_PANEL_WIDTH, Math.min(MAX_DEVELOPER_PANEL_WIDTH, available));
  return clamp(width, MIN_DEVELOPER_PANEL_WIDTH, maximum);
}

function developerPanelWidthStorageKey(appId: string): string {
  return `opengroveMountedAppDeveloperPanelWidth:${appId || "default"}`;
}

function readStoredDeveloperPanelWidth(appId: string): number {
  try {
    const value = Number(window.localStorage.getItem(developerPanelWidthStorageKey(appId)));
    return Number.isFinite(value) && value > 0
      ? clamp(value, MIN_DEVELOPER_PANEL_WIDTH, MAX_DEVELOPER_PANEL_WIDTH)
      : DEFAULT_DEVELOPER_PANEL_WIDTH;
  } catch {
    return DEFAULT_DEVELOPER_PANEL_WIDTH;
  }
}
