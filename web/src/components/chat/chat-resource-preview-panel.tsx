import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { FilePreviewPanel } from "../shared/file-preview-panel";
import type { ChatResourcePreviewState } from "./use-chat-resource-actions";

export function ChatResourcePreviewPanel(props: { preview: ChatResourcePreviewState; onClose(): void }) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    blurActiveElement();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  const panel = (
    <div
      className="thread-resource-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.resourcePreviewDialog")}
      onClick={props.onClose}
    >
      <section className="thread-resource-preview-panel" onClick={(event) => event.stopPropagation()}>
        <header className="thread-resource-preview-header">
          <div>
            <strong>{props.preview.resource.title}</strong>
            <span>{props.preview.selectedPath}</span>
          </div>
          <button
            ref={closeButtonRef}
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
      </section>
    </div>
  );
  if (typeof document === "undefined") {
    return panel;
  }
  return createPortal(panel, document.body);
}

function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}
