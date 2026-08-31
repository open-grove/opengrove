import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  Paperclip,
  Pencil,
  Share2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  StandardFileEditor,
  type StandardFileEditorHandle,
  type StandardFileEditorSelection,
} from "./standard-file-editor";
import { StandardFilePreview } from "./standard-file-preview";
import { resolveStandardFileCapability, type PreviewableFile } from "./standard-file-capabilities";
import { useI18n, type TranslationFn } from "../../i18n";
import { BridgeDownloadError, downloadBridgeFile } from "../../bridge-client";
import { AnimatedBackground } from "../ui/motion/animated-background";
import "./file-preview-panel.css";

export type { PreviewableFile } from "./standard-file-capabilities";

type PreviewMode = "preview" | "edit";
export type FilePreviewSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type FilePreviewDirtyState = {
  dirty: boolean;
  path: string;
  discard(): void;
  save(): Promise<boolean>;
};

export type FileTextSelectionAttachment = {
  text: string;
  fileName: string;
  path: string;
  mimeType?: string;
  lineRange?: {
    start: number;
    end: number;
  };
};

type TextSelectionState = {
  text: string;
  rect: SelectionRect;
};

type SelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export function FilePreviewPanel(props: {
  file: PreviewableFile | undefined;
  loading: boolean;
  rawUrl?: string;
  downloadUrl?: string;
  selectedPath: string;
  saving?: boolean;
  onAttachSelection?(selection: FileTextSelectionAttachment): void;
  onDirtyStateChange?(state: FilePreviewDirtyState): void;
  onOpenLocal?(): void;
  onSaveText?(content: string): Promise<void> | void;
}) {
  const { t } = useI18n();
  const capability = useMemo(
    () => resolveStandardFileCapability(props.file, props.selectedPath),
    [props.file?.mimeType, props.file?.name, props.selectedPath],
  );
  const [mode, setMode] = useState<PreviewMode>("preview");
  const [draftPath, setDraftPath] = useState("");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<FilePreviewSaveState>("idle");
  const textWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<StandardFileEditorHandle | null>(null);
  const saveDraftRef = useRef<() => Promise<boolean>>(async () => true);
  const discardDraftRef = useRef<() => void>(() => {});
  const saveTextRef = useRef(props.onSaveText);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const saveStateResetTimeoutRef = useRef<number | null>(null);
  const [textSelection, setTextSelection] = useState<TextSelectionState | null>(null);

  const canEditText = Boolean(
    props.onSaveText &&
      capability.editor &&
      capability.editable &&
      props.file?.content !== undefined &&
      !props.file?.contentTruncated,
  );
  const markdownEditOnly = canEditText && capability.kind === "markdown";
  const activeMode: PreviewMode = markdownEditOnly ? "edit" : canEditText ? mode : "preview";
  const canAttachSelection = Boolean(props.onAttachSelection);

  useEffect(() => {
    return () => {
      if (saveStateResetTimeoutRef.current) {
        window.clearTimeout(saveStateResetTimeoutRef.current);
        saveStateResetTimeoutRef.current = null;
      }
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setTextSelection(null);
  }, [props.selectedPath, activeMode]);

  const clearSaveStateReset = useCallback(() => {
    if (saveStateResetTimeoutRef.current) {
      window.clearTimeout(saveStateResetTimeoutRef.current);
      saveStateResetTimeoutRef.current = null;
    }
  }, []);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimeoutRef.current) {
      window.clearTimeout(autosaveTimeoutRef.current);
      autosaveTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    const nextPath = props.file?.path || props.selectedPath;
    if (nextPath !== draftPath) {
      const saveText = saveTextRef.current;
      if (dirty && saveText) {
        clearAutosaveTimer();
        const latestDraft = editorRef.current?.getValue() ?? draft;
        void Promise.resolve(saveText(latestDraft)).catch((error: unknown) => {
          console.warn("[file-preview] failed to autosave dirty draft before switching files", error);
        });
      }
      saveTextRef.current = props.onSaveText;
      setDraftPath(nextPath);
      setDraft(props.file?.content ?? "");
      setDirty(false);
      setSaveState("idle");
      setMode("preview");
      return;
    }
    if (!dirty && props.file?.content !== undefined && props.file.content !== draft) {
      setDraft(props.file.content);
    }
    saveTextRef.current = props.onSaveText;
  }, [
    clearAutosaveTimer,
    draft,
    draftPath,
    dirty,
    props.file?.content,
    props.file?.path,
    props.onSaveText,
    props.selectedPath,
  ]);

  const showSavedState = useCallback(() => {
    clearSaveStateReset();
    setSaveState("saved");
    saveStateResetTimeoutRef.current = window.setTimeout(() => {
      saveStateResetTimeoutRef.current = null;
      setSaveState("idle");
    }, 1_800);
  }, [clearSaveStateReset]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (!props.onSaveText) return true;
    clearAutosaveTimer();
    const latestDraft = editorRef.current?.getValue() ?? draft;
    const savedContent = props.file?.content ?? "";
    if (!dirty && latestDraft === savedContent) {
      showSavedState();
      return true;
    }
    clearSaveStateReset();
    setSaveState("saving");
    try {
      await Promise.resolve(props.onSaveText(latestDraft));
      const currentDraft = editorRef.current?.getValue() ?? latestDraft;
      setDraft(currentDraft);
      if (currentDraft !== latestDraft) {
        setDirty(true);
        setSaveState("dirty");
      } else {
        setDirty(false);
        showSavedState();
      }
      return true;
    } catch (error) {
      console.warn("[file-preview] failed to save text file", error);
      setSaveState("error");
      return false;
    }
  }, [clearAutosaveTimer, clearSaveStateReset, dirty, draft, props.file?.content, props.onSaveText, showSavedState]);

  const discardDraft = useCallback(() => {
    clearSaveStateReset();
    setDraft(props.file?.content ?? "");
    setDirty(false);
    setSaveState("idle");
  }, [clearSaveStateReset, props.file?.content]);

  useEffect(() => {
    saveDraftRef.current = saveDraft;
    discardDraftRef.current = discardDraft;
  }, [discardDraft, saveDraft]);

  useEffect(() => {
    if (!dirty || !props.onSaveText) {
      clearAutosaveTimer();
      return;
    }
    clearAutosaveTimer();
    autosaveTimeoutRef.current = window.setTimeout(() => {
      autosaveTimeoutRef.current = null;
      void saveDraft();
    }, 800);
    return clearAutosaveTimer;
  }, [clearAutosaveTimer, dirty, draft, props.onSaveText, saveDraft]);

  useEffect(() => {
    props.onDirtyStateChange?.({
      dirty,
      path: draftPath,
      discard: () => discardDraftRef.current(),
      save: () => saveDraftRef.current(),
    });
  }, [dirty, draftPath, props.onDirtyStateChange]);

  useEffect(() => {
    return () => {
      props.onDirtyStateChange?.({
        dirty: false,
        path: "",
        discard() {},
        save: async () => true,
      });
    };
  }, [props.onDirtyStateChange]);

  function updateDraft(value: string) {
    setDraft(value);
    const nextDirty = value !== (props.file?.content ?? "");
    setDirty(nextDirty);
    clearSaveStateReset();
    setSaveState(nextDirty ? "dirty" : "idle");
  }

  function activateTextEditor() {
    if (canEditText) {
      setMode("edit");
    }
  }

  function handleNativeSelection() {
    if (!canAttachSelection || activeMode !== "preview") return;
    window.setTimeout(() => {
      const nextSelection = readNativeTextSelection(textWorkbenchRef.current);
      setTextSelection(nextSelection);
    }, 0);
  }

  function handleEditorSelectionChange(selection: StandardFileEditorSelection | null) {
    if (!canAttachSelection || activeMode !== "edit") return;
    setTextSelection(selection ? { text: selection.text, rect: selection.rect } : null);
  }

  function attachSelection(selection: TextSelectionState) {
    if (!props.file || !props.onAttachSelection) return;
    props.onAttachSelection({
      text: selection.text,
      fileName: props.file.name,
      path: props.file.path || props.selectedPath,
      mimeType: props.file.mimeType,
      lineRange: lineRangeForSelection(activeMode === "edit" ? draft : (props.file.content ?? ""), selection.text),
    });
    setTextSelection(null);
  }

  function attachCurrentSelection() {
    if (!textSelection) return;
    attachSelection(textSelection);
  }

  function attachEditorSelection(selection: StandardFileEditorSelection) {
    attachSelection({ text: selection.text, rect: selection.rect });
  }

  const hasToolbar = Boolean(canEditText || props.rawUrl || props.downloadUrl || props.onOpenLocal);

  if (!props.selectedPath) {
    return (
      <PreviewEmpty
        icon={<FileText size={22} />}
        title={t("filePreview.emptyTitle")}
        copy={t("filePreview.emptyCopy")}
      />
    );
  }

  if (props.loading) {
    return <FilePreviewLoadingState />;
  }

  if (!props.file) {
    return <PreviewEmpty icon={<FileText size={20} />} title={t("filePreview.unavailableTitle")} />;
  }

  const previewContent =
    activeMode === "edit" && canEditText ? (
      <div className="file-preview-editor-shell" data-preview-kind={capability.preview.kind}>
        <StandardFileEditor
          ref={editorRef}
          key={props.file?.path || props.selectedPath}
          capability={capability}
          value={draft}
          autoFocus
          placeholder={t("filePreview.editorPlaceholder")}
          onChange={updateDraft}
          onAttachSelection={canAttachSelection && capability.kind === "markdown" ? attachEditorSelection : undefined}
          onTextSelectionChange={handleEditorSelectionChange}
        />
      </div>
    ) : (
      <StandardFilePreview
        capability={capability}
        file={props.file}
        rawUrl={props.rawUrl}
        onActivate={canEditText && !markdownEditOnly ? activateTextEditor : undefined}
      />
    );

  if (capability.preview.selectableText) {
    return (
      <div
        className="file-preview-workbench"
        ref={textWorkbenchRef}
        onMouseUp={handleNativeSelection}
        onKeyUp={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Escape") {
            setTextSelection(null);
            return;
          }
          handleNativeSelection();
        }}
      >
        <div className="file-preview-surface" data-has-toolbar={hasToolbar ? "true" : "false"}>
          <PreviewToolbar
            canEdit={canEditText}
            dirty={dirty}
            downloadFileName={props.file.name}
            mode={activeMode}
            downloadUrl={props.downloadUrl}
            onOpenLocal={props.onOpenLocal}
            rawUrl={props.rawUrl}
            saving={Boolean(props.saving)}
            saveState={props.saving ? "saving" : saveState}
            showModeTabs={!markdownEditOnly}
            onModeChange={setMode}
          />
          <div className="file-preview-content">{previewContent}</div>
        </div>
        {textSelection && canAttachSelection ? (
          <SelectionAttachButton selection={textSelection} onAttach={attachCurrentSelection} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="file-preview-workbench">
      <div className="file-preview-surface" data-has-toolbar={hasToolbar ? "true" : "false"}>
        <PreviewToolbar
          downloadFileName={props.file.name}
          downloadUrl={props.downloadUrl}
          onOpenLocal={props.onOpenLocal}
          rawUrl={props.rawUrl}
        />
        <div className="file-preview-content">{previewContent}</div>
      </div>
    </div>
  );
}

function FilePreviewLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className="og-skeleton-stack file-preview-loading-state"
      role="status"
      aria-label={t("filePreview.loadingTitle")}
    >
      <span className="og-skeleton og-skeleton-line" style={{ width: "28%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "92%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "84%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "71%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "88%" }} />
    </div>
  );
}

function SelectionAttachButton(props: { selection: TextSelectionState; onAttach(): void }) {
  const { t } = useI18n();
  const point = selectionButtonPoint(props.selection.rect);
  return (
    <button
      className="file-selection-attach-button"
      type="button"
      style={{
        left: point.left,
        top: point.top,
        transform: point.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
      data-placement={point.placement}
      title={t("filePreview.addToChat")}
      aria-label={t("filePreview.addSelectionToChat")}
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onMouseUp={(event: MouseEvent<HTMLButtonElement>) => event.stopPropagation()}
      onClick={() => {
        props.onAttach();
        document.getSelection()?.removeAllRanges();
      }}
    >
      <Paperclip size={13} />
      <span>{t("filePreview.addToChat")}</span>
    </button>
  );
}

function readNativeTextSelection(container: HTMLElement | null): TextSelectionState | null {
  if (!container) return null;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && !container.contains(anchor)) || (focus && !container.contains(focus))) return null;
  const rect = selectionRectFromRange(range);
  if (!rect) return null;
  return { text, rect };
}

function selectionRectFromRange(range: Range): SelectionRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const rect = rects[0] ?? range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

function selectionButtonPoint(rect: SelectionRect): { left: number; top: number; placement: "above" | "below" } {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 56), Math.max(56, viewportWidth - 56));
  if (rect.top > 54) {
    return { left, top: rect.top - 8, placement: "above" };
  }
  return { left, top: rect.bottom + 8, placement: "below" };
}

function lineRangeForSelection(content: string, selectedText: string): FileTextSelectionAttachment["lineRange"] {
  const trimmedSelection = selectedText.trim();
  if (!content || !trimmedSelection) return undefined;
  const index = content.indexOf(selectedText);
  const fallbackIndex = index >= 0 ? index : content.indexOf(trimmedSelection);
  if (fallbackIndex < 0) return undefined;
  const before = content.slice(0, fallbackIndex);
  const selected = content.slice(
    fallbackIndex,
    fallbackIndex + (index >= 0 ? selectedText.length : trimmedSelection.length),
  );
  const start = before.split(/\r\n|\r|\n/).length;
  const end = start + Math.max(0, selected.split(/\r\n|\r|\n/).length - 1);
  return { start, end };
}

function PreviewToolbar(props: {
  canEdit?: boolean;
  dirty?: boolean;
  downloadFileName?: string;
  downloadUrl?: string;
  mode?: PreviewMode;
  onOpenLocal?(): void;
  rawUrl?: string;
  saving?: boolean;
  saveState?: FilePreviewSaveState;
  showModeTabs?: boolean;
  onModeChange?(mode: PreviewMode): void;
}) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const downloadHref = props.downloadUrl || props.rawUrl;
  if (!props.canEdit && !props.rawUrl && !props.onOpenLocal && !downloadHref) return null;
  const showModeTabs = props.canEdit && props.showModeTabs !== false;
  return (
    <div className="file-preview-toolbar">
      {showModeTabs ? (
        <div className="file-preview-mode-tabs" role="tablist" aria-label={t("filePreview.modeLabel")}>
          <AnimatedBackground value={props.mode ?? "preview"} backgroundClassName="file-preview-mode-tab-background">
            <button
              type="button"
              role="tab"
              aria-selected={(props.mode ?? "preview") === "preview"}
              data-id="preview"
              data-active={(props.mode ?? "preview") === "preview" ? "true" : "false"}
              title={t("filePreview.preview")}
              onClick={() => props.onModeChange?.("preview")}
            >
              <Eye size={14} />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={props.mode === "edit"}
              data-id="edit"
              data-active={props.mode === "edit" ? "true" : "false"}
              title={t("filePreview.edit")}
              onClick={() => props.onModeChange?.("edit")}
            >
              <Pencil size={14} />
            </button>
          </AnimatedBackground>
        </div>
      ) : (
        <span />
      )}
      <div className="file-preview-actions">
        {downloadError ? (
          <span className="file-preview-download-error" role="alert">
            {downloadError}
          </span>
        ) : null}
        {props.canEdit && props.mode === "edit" && props.saveState && props.saveState !== "idle" ? (
          <span
            className="file-preview-save-state"
            data-state={props.saveState}
            title={filePreviewSaveStateLabel(props.saveState, t)}
            aria-label={filePreviewSaveStateLabel(props.saveState, t)}
            role="status"
          >
            {filePreviewSaveStateIcon(props.saveState)}
          </span>
        ) : null}
        {props.onOpenLocal || props.rawUrl || downloadHref ? (
          <>
            {props.onOpenLocal ? (
              <button
                className="file-preview-action"
                type="button"
                title={t("thread.resourceReveal")}
                aria-label={t("thread.resourceReveal")}
                onClick={props.onOpenLocal}
              >
                <FolderOpen size={14} />
              </button>
            ) : props.rawUrl ? (
              <a
                className="file-preview-action"
                href={props.rawUrl}
                target="_blank"
                rel="noreferrer"
                title={t("filePreview.openOrShare")}
                aria-label={t("filePreview.openOrShare")}
              >
                <Share2 size={14} />
              </a>
            ) : null}
            {downloadHref ? (
              <button
                className="file-preview-action"
                type="button"
                disabled={downloading}
                title={t("filePreview.download")}
                aria-label={t("filePreview.download")}
                onClick={() => {
                  setDownloading(true);
                  setDownloadError("");
                  void downloadBridgeFile(downloadHref, props.downloadFileName || "download")
                    .catch((error) => setDownloadError(fileDownloadErrorMessage(error, t)))
                    .finally(() => setDownloading(false));
                }}
              >
                {downloading ? <Loader2 size={14} className="file-preview-download-spinner" /> : <Download size={14} />}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function fileDownloadErrorMessage(error: unknown, t: TranslationFn): string {
  if (error instanceof BridgeDownloadError) {
    if (error.kind === "auth") return t("filePreview.downloadAuthError");
    if (error.kind === "network") return t("filePreview.downloadNetworkError");
    if (error.kind === "timeout") return t("filePreview.downloadTimeoutError");
  }
  return t("filePreview.downloadFailed");
}

function filePreviewSaveStateIcon(state: FilePreviewSaveState): ReactNode {
  switch (state) {
    case "dirty":
      return <Circle size={14} strokeWidth={2.1} aria-hidden="true" />;
    case "saving":
      return <Loader2 size={14} strokeWidth={2.1} aria-hidden="true" />;
    case "saved":
      return <CheckCircle2 size={15} strokeWidth={2.1} aria-hidden="true" />;
    case "error":
      return <AlertTriangle size={15} strokeWidth={2.1} aria-hidden="true" />;
    case "idle":
      return null;
  }
}

function filePreviewSaveStateLabel(state: FilePreviewSaveState, t: TranslationFn): string {
  switch (state) {
    case "dirty":
      return t("filePreview.saveDirty");
    case "saving":
      return t("filePreview.saveSaving");
    case "saved":
      return t("filePreview.saveSaved");
    case "error":
      return t("filePreview.saveError");
    case "idle":
      return "";
  }
}

function PreviewEmpty(props: { icon: ReactNode; title: string; copy?: string }) {
  return (
    <div className="file-preview-empty mounted-app-preview-empty">
      {props.icon}
      <strong>{props.title}</strong>
      {props.copy ? <p>{props.copy}</p> : null}
    </div>
  );
}
