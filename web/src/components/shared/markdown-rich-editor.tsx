import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { replaceAll } from "@milkdown/kit/utils";
import { translate } from "../../i18n";
import {
  MarkdownCodeEditor,
  type MarkdownCodeEditorHandle,
  type MarkdownEditorSelection,
} from "../knowledge/markdown-code-editor";

export type MarkdownRichEditorHandle = {
  getValue(): string;
};

type MarkdownRichEditorProps = {
  value: string;
  autoFocus?: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onAttachSelection?(selection: MarkdownEditorSelection): void;
  onTextSelectionChange?(selection: MarkdownEditorSelection | null): void;
};

export const MarkdownRichEditor = forwardRef<MarkdownRichEditorHandle, MarkdownRichEditorProps>(
  function MarkdownRichEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyCrepeRef = useRef<Crepe | null>(null);
    const codeEditorRef = useRef<MarkdownCodeEditorHandle | null>(null);
    const currentValueRef = useRef(props.value);
    const pendingExternalValueRef = useRef<string | null>(null);
    const changeHandlerRef = useRef(props.onChange);
    const attachHandlerRef = useRef(props.onAttachSelection);
    const selectionHandlerRef = useRef(props.onTextSelectionChange);
    const applyingExternalValueRef = useRef(false);
    const [fallbackReason, setFallbackReason] = useState<unknown>(null);

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => {
          if (fallbackReason) {
            return codeEditorRef.current?.getValue() ?? props.value;
          }
          const crepe = readyCrepeRef.current;
          if (!crepe) {
            return currentValueRef.current;
          }
          try {
            const markdown = crepe.getMarkdown();
            currentValueRef.current = markdown;
            return markdown;
          } catch (error) {
            console.warn("[markdown-rich-editor] failed to read current markdown", normalizeEditorError(error));
            return currentValueRef.current;
          }
        },
      }),
      [fallbackReason, props.value],
    );

    useEffect(() => {
      changeHandlerRef.current = props.onChange;
    }, [props.onChange]);

    useEffect(() => {
      attachHandlerRef.current = props.onAttachSelection;
    }, [props.onAttachSelection]);

    useEffect(() => {
      selectionHandlerRef.current = props.onTextSelectionChange;
    }, [props.onTextSelectionChange]);

    const fallBackToCodeEditor = useCallback((error: unknown) => {
      console.error("[markdown-rich-editor] falling back to code editor", normalizeEditorError(error));
      selectionHandlerRef.current?.(null);
      crepeRef.current = null;
      setFallbackReason(error);
    }, []);

    useEffect(() => {
      if (fallbackReason) return;
      const root = hostRef.current;
      if (!root) return;
      let cancelled = false;
      const crepe = new Crepe({
        root,
        defaultValue: props.value,
        features: {
          [CrepeFeature.AI]: false,
          [CrepeFeature.ImageBlock]: false,
          [CrepeFeature.Latex]: false,
          [CrepeFeature.ListItem]: false,
          [CrepeFeature.TopBar]: false,
        },
        featureConfigs: {
          [CrepeFeature.BlockEdit]: {
            blockHandle: {
              getOffset: () => 32,
              getPlacement: () => "left-start",
            },
          },
          [CrepeFeature.Placeholder]: {
            mode: "block",
            text: props.placeholder || translate("filePreview.editorPlaceholder"),
          },
          [CrepeFeature.Toolbar]: {
            buildToolbar: props.onAttachSelection
              ? (builder) => {
                  builder.addGroup("opengrove", "OpenGrove").addItem("attach-selection", {
                    icon: ATTACH_SELECTION_ICON,
                    active: () => false,
                    onRun: (ctx) => {
                      const selection = readEditorSelection(ctx);
                      if (selection) attachHandlerRef.current?.(selection);
                    },
                  });
                }
              : undefined,
          },
        },
      });
      currentValueRef.current = props.value;
      try {
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            if (applyingExternalValueRef.current) return;
            currentValueRef.current = markdown;
            if (!readyCrepeRef.current) return;
            changeHandlerRef.current(markdown);
          });
          listener.selectionUpdated((ctx, selection) => {
            const onTextSelectionChange = selectionHandlerRef.current;
            if (!onTextSelectionChange) return;
            if (selection.empty) {
              onTextSelectionChange(null);
              return;
            }
            try {
              onTextSelectionChange(readEditorSelection(ctx));
            } catch (error) {
              console.warn("[markdown-rich-editor] ignored selection read failure", normalizeEditorError(error));
              onTextSelectionChange(null);
            }
          });
        });
      } catch (error) {
        fallBackToCodeEditor(error);
        return;
      }
      crepeRef.current = crepe;
      void crepe
        .create()
        .then(() => {
          if (cancelled) {
            void crepe.destroy().catch(() => undefined);
            return;
          }
          try {
            crepe.editor.action((ctx) => {
              const view = readEditorView(ctx);
              if (!view) throw new Error("Milkdown editor view was not ready after create");
              view.dom.classList.add("markdown-preview");
            });
            if (props.autoFocus) {
              crepe.editor.action((ctx) => {
                readEditorView(ctx)?.focus();
              });
            }
            readyCrepeRef.current = crepe;
            const pendingExternalValue = pendingExternalValueRef.current;
            if (pendingExternalValue !== null && pendingExternalValue !== currentValueRef.current) {
              applyExternalValue(crepe, pendingExternalValue);
            }
            pendingExternalValueRef.current = null;
          } catch (error) {
            fallBackToCodeEditor(error);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) fallBackToCodeEditor(error);
        });
      return () => {
        cancelled = true;
        selectionHandlerRef.current?.(null);
        crepeRef.current = null;
        readyCrepeRef.current = null;
        void crepe.destroy().catch(() => undefined);
      };
    }, [fallBackToCodeEditor, fallbackReason]);

    useEffect(() => {
      const crepe = readyCrepeRef.current;
      if (fallbackReason || props.value === currentValueRef.current) return;
      if (!crepe) {
        pendingExternalValueRef.current = props.value;
        return;
      }
      try {
        applyExternalValue(crepe, props.value);
      } catch (error) {
        fallBackToCodeEditor(error);
      }
    }, [fallBackToCodeEditor, fallbackReason, props.value]);

    function applyExternalValue(crepe: Crepe, value: string) {
      applyingExternalValueRef.current = true;
      try {
        crepe.editor.action((ctx) => {
          const view = readEditorView(ctx);
          if (!view) throw new Error("Milkdown editor view is not ready for external value update");
          replaceAll(value)(ctx);
        });
        currentValueRef.current = value;
        pendingExternalValueRef.current = null;
      } finally {
        applyingExternalValueRef.current = false;
      }
    }

    if (fallbackReason) {
      return (
        <MarkdownCodeEditor
          ref={codeEditorRef}
          value={props.value}
          format="markdown"
          autoFocus={props.autoFocus}
          placeholder={props.placeholder ?? ""}
          onChange={props.onChange}
          onTextSelectionChange={props.onTextSelectionChange}
        />
      );
    }

    return <div className="markdown-rich-editor" ref={hostRef} />;
  },
);

function readEditorSelection(ctx: Ctx): MarkdownEditorSelection | null {
  const view = readEditorView(ctx);
  if (!view) return null;
  const { selection } = view.state;
  if (selection.empty) return null;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const text = view.state.doc.textBetween(from, to, "\n\n");
  if (!text.trim()) return null;
  const anchor = view.coordsAtPos(selection.to);
  return {
    text,
    rect: {
      left: anchor.left,
      top: anchor.top,
      right: anchor.right,
      bottom: anchor.bottom,
      width: Math.max(1, anchor.right - anchor.left),
      height: Math.max(1, anchor.bottom - anchor.top),
    },
  };
}

type EditorViewLike = {
  state: {
    selection: {
      empty: boolean;
      from: number;
      to: number;
    };
    doc: {
      content: {
        size: number;
      };
      textBetween(from: number, to: number, separator?: string): string;
    };
    tr: unknown;
  };
  dom: HTMLElement;
  coordsAtPos(position: number): { left: number; right: number; top: number; bottom: number };
  dispatch(transaction: unknown): void;
  focus(): void;
};

function readEditorView(ctx: Ctx): EditorViewLike | null {
  const view = ctx.get(editorViewCtx) as unknown;
  if (!isEditorViewLike(view)) return null;
  return view;
}

function isEditorViewLike(view: unknown): view is EditorViewLike {
  if (!view || typeof view !== "object") return false;
  const candidate = view as Partial<EditorViewLike>;
  return Boolean(
    candidate.state &&
      candidate.state.selection &&
      candidate.state.doc &&
      candidate.dom instanceof HTMLElement &&
      typeof candidate.coordsAtPos === "function" &&
      typeof candidate.dispatch === "function" &&
      typeof candidate.focus === "function",
  );
}

const ATTACH_SELECTION_ICON = `
  <svg class="og-toolbar-attach-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12.13 20.5a6.05 6.05 0 0 1-4.28-10.32l5.54-5.54a4.35 4.35 0 1 1 6.15 6.15l-6.16 6.16a2.77 2.77 0 0 1-3.92-3.92l5.38-5.38 1.42 1.42-5.39 5.38a.77.77 0 0 0 1.09 1.09l6.16-6.16a2.35 2.35 0 0 0-3.32-3.32l-5.54 5.54a4.05 4.05 0 0 0 5.73 5.73l5.7-5.7 1.41 1.42-5.7 5.7a6.03 6.03 0 0 1-4.27 1.75Z" />
  </svg>
`;

function normalizeEditorError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}
