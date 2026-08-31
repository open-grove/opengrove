import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Copy, ExternalLink, Eye, FileSearch, FolderOpen } from "lucide-react";
import { useI18n } from "../../i18n";
import { MotionMenuSurface } from "../ui/motion/menu";
import type { ChatResourceAction, ChatResourceRef } from "./resource-model";

export type ResourceMenuPosition = {
  x: number;
  y: number;
};

const MENU_MARGIN = 8;
const FALLBACK_MENU_WIDTH = 220;
const FALLBACK_MENU_HEIGHT = 220;

export function ResourceContextMenu(props: {
  resource: ChatResourceRef;
  position: ResourceMenuPosition;
  onAction(action: ChatResourceAction): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [resolvedPosition, setResolvedPosition] = useState(() =>
    clampMenuPosition(props.position, FALLBACK_MENU_WIDTH, FALLBACK_MENU_HEIGHT),
  );

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      setResolvedPosition(
        clampMenuPosition(props.position, rect?.width ?? FALLBACK_MENU_WIDTH, rect?.height ?? FALLBACK_MENU_HEIGHT),
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
    };
  }, [props.position.x, props.position.y]);

  useEffect(() => {
    const close = () => props.onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.onClose]);

  const defaultActions: ChatResourceAction[] = [
    "preview",
    "open",
    "copy-path",
    ...(props.resource.origin === "workspace" || props.resource.origin === "mounted-app"
      ? ["copy-contents" as const]
      : []),
    ...(props.resource.origin === "workspace" || props.resource.origin === "mounted-app" ? ["reveal" as const] : []),
  ];
  const actions = new Set<ChatResourceAction>(props.resource.actions ?? defaultActions);
  const menu = (
    <MotionMenuSurface
      ref={menuRef}
      className="thread-resource-menu"
      style={{ left: resolvedPosition.x, top: resolvedPosition.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      {actions.has("preview") ? (
        <ResourceMenuButton
          icon={<Eye size={14} />}
          label={t("thread.resourcePreview")}
          action="preview"
          onAction={props.onAction}
        />
      ) : null}
      {actions.has("open") ? (
        <ResourceMenuButton
          icon={<ExternalLink size={14} />}
          label={props.resource.origin === "http" ? t("thread.resourceOpenNewWindow") : t("thread.resourceOpenSystem")}
          action="open"
          onAction={props.onAction}
        />
      ) : null}
      {actions.has("copy-path") ? (
        <ResourceMenuButton
          icon={<Copy size={14} />}
          label={t("thread.resourceCopyPath")}
          action="copy-path"
          onAction={props.onAction}
        />
      ) : null}
      {actions.has("copy-contents") ? (
        <ResourceMenuButton
          icon={<FileSearch size={14} />}
          label={t("thread.resourceCopyContents")}
          action="copy-contents"
          onAction={props.onAction}
        />
      ) : null}
      {actions.has("reveal") ? (
        <ResourceMenuButton
          icon={<FolderOpen size={14} />}
          label={t("thread.resourceReveal")}
          action="reveal"
          onAction={props.onAction}
        />
      ) : null}
    </MotionMenuSurface>
  );

  if (typeof document === "undefined") {
    return menu;
  }
  return createPortal(menu, document.body);
}

export function clampMenuPosition(position: ResourceMenuPosition, width: number, height: number): ResourceMenuPosition {
  if (typeof window === "undefined") {
    return position;
  }
  const maxX = Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN);
  const maxY = Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN);
  return {
    x: Math.min(Math.max(MENU_MARGIN, position.x), maxX),
    y: Math.min(Math.max(MENU_MARGIN, position.y), maxY),
  };
}

function ResourceMenuButton(props: {
  icon: ReactNode;
  label: string;
  action: ChatResourceAction;
  onAction(action: ChatResourceAction): void;
}) {
  return (
    <button
      type="button"
      className="thread-resource-menu-item"
      role="menuitem"
      onClick={() => props.onAction(props.action)}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}
