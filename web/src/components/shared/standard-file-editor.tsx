import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
// Crepe 样式随主包 eager 加载（异步 chunk 的 CSS 不会被自动加载）。
import "./markdown-rich-editor-styles";
import type { MarkdownCodeEditorHandle, MarkdownEditorSelection } from "../knowledge/markdown-code-editor";
import type { MarkdownRichEditorHandle } from "./markdown-rich-editor";
import type { StandardFileCapability } from "./standard-file-capabilities";

// @milkdown/* 与 @codemirror/* 体积大，编辑器本体拆成异步 chunk，按需加载。
const LazyMarkdownRichEditor = lazy(() =>
  import("./markdown-rich-editor").then((module) => ({ default: module.MarkdownRichEditor })),
);
const LazyMarkdownCodeEditor = lazy(() =>
  import("../knowledge/markdown-code-editor").then((module) => ({ default: module.MarkdownCodeEditor })),
);

export type StandardFileEditorSelection = MarkdownEditorSelection;
export type StandardFileEditorHandle = {
  getValue(): string;
};

type StandardFileEditorProps = {
  capability: StandardFileCapability;
  value: string;
  autoFocus?: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onAttachSelection?(selection: StandardFileEditorSelection): void;
  onTextSelectionChange?(selection: StandardFileEditorSelection | null): void;
};

export const StandardFileEditor = forwardRef<StandardFileEditorHandle, StandardFileEditorProps>(
  function StandardFileEditor(props, ref) {
    const markdownRef = useRef<MarkdownRichEditorHandle | null>(null);
    const codeRef = useRef<MarkdownCodeEditorHandle | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => markdownRef.current?.getValue() ?? codeRef.current?.getValue() ?? props.value,
      }),
      [props.value],
    );

    if (!props.capability.editor) return null;
    if (props.capability.kind === "markdown") {
      return (
        <Suspense fallback={<EditorLoadingFallback />}>
          <LazyMarkdownRichEditor
            ref={markdownRef}
            value={props.value}
            autoFocus={props.autoFocus}
            placeholder={props.placeholder ?? ""}
            onChange={props.onChange}
            onAttachSelection={props.onAttachSelection}
            onTextSelectionChange={props.onTextSelectionChange}
          />
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<EditorLoadingFallback />}>
        <LazyMarkdownCodeEditor
          ref={codeRef}
          value={props.value}
          format={props.capability.editor.language}
          autoFocus={props.autoFocus}
          placeholder={props.placeholder ?? ""}
          onChange={props.onChange}
          onTextSelectionChange={props.onTextSelectionChange}
        />
      </Suspense>
    );
  },
);

function EditorLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="file-preview-empty mounted-app-preview-empty" role="status">
      <LoaderCircle size={18} className="spin" aria-hidden="true" />
      <strong>{t("editor.loading")}</strong>
    </div>
  );
}
