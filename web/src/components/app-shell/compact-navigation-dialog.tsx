import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

export function ConversationNavigation(props: {
  compact: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  section: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (props.compact) {
    return (
      <CompactNavigationDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={t("compact.conversations")}
        triggerId="app-conversations-toggle"
      >
        {props.children}
      </CompactNavigationDialog>
    );
  }
  return (
    <aside className="sidebar" data-section={props.section} aria-label={t("layout.sidebar")}>
      {props.children}
    </aside>
  );
}

export function CompactNavigationDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  triggerId: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        placement="left"
        className="compact-navigation-dialog"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(props.triggerId)?.focus({ preventScroll: true });
        }}
      >
        <header className="compact-navigation-header">
          <DialogTitle>{props.title}</DialogTitle>
          <button
            type="button"
            className="app-titlebar-control"
            onClick={() => props.onOpenChange(false)}
            aria-label={t("common.close")}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="compact-navigation-body">{props.children}</div>
      </DialogContent>
    </Dialog>
  );
}
