import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { ChatResourceAction, ChatResourceRef } from "./resource-model";
import { ResourceContextMenu, type ResourceMenuPosition } from "./resource-context-menu";

export function ResourceLink(props: {
  resource: ChatResourceRef;
  children: ReactNode;
  title?: string;
  className?: string;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
}) {
  const [menuPosition, setMenuPosition] = useState<ResourceMenuPosition | null>(null);
  const open = (action: ChatResourceAction = "preview") => {
    setMenuPosition(null);
    props.onOpenResource?.(props.resource, action);
  };
  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    open(defaultResourceAction(props.resource));
  };
  const handleContextMenu = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(defaultResourceAction(props.resource));
    }
  };

  return (
    <>
      <span
        className={props.className ?? "thread-md-file-link"}
        role="button"
        tabIndex={0}
        title={props.title ?? props.resource.subtitle ?? props.resource.title}
        aria-label={props.title ?? props.resource.title}
        data-resource-reference="true"
        data-resource-origin={props.resource.origin}
        data-resource-kind={props.resource.kind}
        data-resource-path={props.resource.path}
        data-resource-title={props.resource.title}
        data-resource-line={props.resource.line ? String(props.resource.line) : undefined}
        onClick={handleClick}
        onDoubleClick={() => open(props.resource.origin === "local" ? "reveal" : "open")}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        {props.children}
      </span>
      {menuPosition ? (
        <ResourceContextMenu
          resource={props.resource}
          position={menuPosition}
          onAction={open}
          onClose={() => setMenuPosition(null)}
        />
      ) : null}
    </>
  );
}

function defaultResourceAction(resource: ChatResourceRef): ChatResourceAction {
  if (resource.origin === "http") return "open";
  if (resource.origin === "local") return "reveal";
  return "preview";
}
