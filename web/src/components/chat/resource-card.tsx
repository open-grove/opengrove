import type { ReactNode } from "react";
import { ResourceCard } from "@olorinm/agent-ui";
import { useI18n } from "../../i18n";
import type { ChatResourceAction, ChatResourceRef } from "./resource-model";
import { ResourceContextMenu } from "./resource-context-menu";
export function ResourceCardFrame(props: {
  resource: ChatResourceRef;
  children: ReactNode;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
}) {
  const { t } = useI18n();
  return (
    <ResourceCard
      resource={props.resource}
      moreLabel={t("conversation.more")}
      onOpen={(action) => props.onOpenResource?.(props.resource, action as ChatResourceAction)}
      renderMenu={({ position, close, open }) => (
        <ResourceContextMenu resource={props.resource} position={position} onAction={open} onClose={close} />
      )}
    >
      {props.children}
    </ResourceCard>
  );
}
