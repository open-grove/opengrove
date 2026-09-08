import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useI18n } from "../../i18n";

export function FileConflictEditor(props: {
  original: string;
  value: string;
  stale: boolean;
  saving: boolean;
  onChange(value: string): void;
  onCancel(): void;
  onSave(): Promise<void>;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!container.current) return;
    const extensions = [lineNumbers(), EditorView.lineWrapping];
    const merge = new MergeView({
      parent: container.current,
      a: {
        doc: props.original,
        extensions: [...extensions, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      b: {
        doc: props.value,
        extensions: [
          ...extensions,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      },
      revertControls: "a-to-b",
      renderRevertControl: () => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "→";
        button.title = t("filePreview.copyDiskChange");
        button.setAttribute("aria-label", t("filePreview.copyDiskChange"));
        return button;
      },
    });
    view.current = merge;
    return () => {
      merge.destroy();
      view.current = null;
    };
  }, [props.original, t]);
  return (
    <div className="file-conflict-editor">
      <p>{t("filePreview.conflictInstructions")}</p>
      <div className="file-conflict-headings">
        <strong>{t("filePreview.diskVersion")}</strong>
        <strong>{t("filePreview.mergeResult")}</strong>
      </div>
      <div ref={container} className="file-conflict-comparison" />
      {props.stale ? <p role="alert">{t("filePreview.changedAgain")}</p> : null}
      <div className="file-conflict-actions">
        <button
          type="button"
          onClick={() => {
            const editor = view.current?.b;
            if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.original } });
          }}
        >
          {t("filePreview.copyDiskVersion")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t("filePreview.keepDraft")}
        </button>
        <button type="button" disabled={props.stale || props.saving} onClick={() => void props.onSave()}>
          {t("filePreview.saveResolution")}
        </button>
      </div>
    </div>
  );
}
