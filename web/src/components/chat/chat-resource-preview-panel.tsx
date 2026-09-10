import { useRef } from "react";
import { X } from "lucide-react";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { FilePreviewPanel } from "../shared/file-preview-panel";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import type { ChatResourcePreviewState } from "./use-chat-resource-actions";

export function ChatResourcePreviewPanel(props: { preview: ChatResourcePreviewState; onClose(): void }) {
  const { t } = useI18n();
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="thread-resource-preview-panel"
        mobilePresentation="page"
        aria-label={t("chat.resourcePreviewDialog")}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus({ preventScroll: true });
          }
        }}
      >
        <header className="thread-resource-preview-header">
          <div>
            <DialogTitle asChild>
              <strong>{props.preview.resource.title}</strong>
            </DialogTitle>
            <span>{props.preview.selectedPath}</span>
          </div>
          <button
            type="button"
            className="thread-image-icon-button"
            onClick={props.onClose}
            aria-label={t("knowledge.closePreview")}
            title={t("mountedApp.close")}
          >
            <X size={16} />
          </button>
        </header>
        {props.preview.error ? (
          <div className="thread-resource-preview-error">{rawDiagnosticText(props.preview.error)}</div>
        ) : (
          <FilePreviewPanel
            file={props.preview.file}
            loading={props.preview.loading}
            rawUrl={props.preview.rawUrl}
            selectedPath={props.preview.selectedPath}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
