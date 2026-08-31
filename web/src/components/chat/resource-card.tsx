import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ChatResourceAction, ChatResourceRef } from "./resource-model";
import { ResourceContextMenu, type ResourceMenuPosition } from "./resource-context-menu";

export function ResourceCardFrame(props: {
  resource: ChatResourceRef;
  children: ReactNode;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
}) {
  const { t } = useI18n();
  const [menuPosition, setMenuPosition] = useState<ResourceMenuPosition | null>(null);
  const open = (action: ChatResourceAction = "preview") => {
    setMenuPosition(null);
    props.onOpenResource?.(props.resource, action);
  };
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open("preview");
    }
  };
  return (
    <>
      <article
        className="thread-artifact-card thread-resource-card"
        role="button"
        tabIndex={0}
        data-resource-reference="true"
        data-resource-origin={props.resource.origin}
        data-resource-kind={props.resource.kind}
        data-resource-path={props.resource.path}
        data-resource-title={props.resource.title}
        data-resource-line={props.resource.line ? String(props.resource.line) : undefined}
        onClick={() => open("preview")}
        onDoubleClick={() => open("open")}
        onContextMenu={openMenu}
        onKeyDown={onKeyDown}
      >
        {props.children}
        <span className="thread-resource-card-actions">
          <button
            type="button"
            className="thread-resource-card-action"
            title={t("conversation.more")}
            aria-label={t("conversation.more")}
            onClick={openMenu}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
      </article>
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
