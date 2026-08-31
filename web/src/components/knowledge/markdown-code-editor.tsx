import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownKeymap, pasteURLAsLink } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { Annotation, EditorSelection, EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

export type MarkdownEditorSelection = {
  text: string;
  rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
};

export type MarkdownCodeEditorFormat =
  | "markdown"
  | "yaml"
  | "json"
  | "html"
  | "css"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "text"
  | string;

interface MarkdownCodeEditorProps {
  value: string;
  format: MarkdownCodeEditorFormat;
  autoFocus?: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onOpenLink?(href: string): boolean;
  onTextSelectionChange?(selection: MarkdownEditorSelection | null): void;
}

export type MarkdownCodeEditorHandle = {
  getValue(): string;
};

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: "tok-heading" },
  { tag: tags.emphasis, class: "tok-emphasis" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.link, class: "tok-link" },
  { tag: tags.url, class: "tok-url" },
  { tag: tags.monospace, class: "tok-monospace" },
]);

const externalValueUpdate = Annotation.define<boolean>();

const headingClasses = new Map([
  ["ATXHeading1", "cm-md-heading cm-md-heading-1"],
  ["ATXHeading2", "cm-md-heading cm-md-heading-2"],
  ["ATXHeading3", "cm-md-heading cm-md-heading-3"],
  ["ATXHeading4", "cm-md-heading cm-md-heading-4"],
  ["ATXHeading5", "cm-md-heading cm-md-heading-5"],
  ["ATXHeading6", "cm-md-heading cm-md-heading-6"],
  ["SetextHeading1", "cm-md-heading cm-md-heading-1"],
  ["SetextHeading2", "cm-md-heading cm-md-heading-2"],
]);

const syntaxMarkNodes = new Set([
  "HeaderMark",
  "EmphasisMark",
  "LinkMark",
  "CodeMark",
  "CodeInfo",
  "ListMark",
  "QuoteMark",
]);

const markdownLivePreviewDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownLivePreviewDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildMarkdownLivePreviewDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

function buildMarkdownLivePreviewDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head);
  decorations.push(Decoration.line({ class: "cm-md-active-line" }).range(activeLine.from));
  const frontmatterEnd = markdownFrontmatterEnd(view.state.doc.toString());
  if (frontmatterEnd > 0) {
    let line = view.state.doc.lineAt(0);
    while (line.from < frontmatterEnd) {
      decorations.push(Decoration.line({ class: "cm-md-frontmatter-line" }).range(line.from));
      if (line.to >= frontmatterEnd || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  syntaxTree(view.state).iterate({
    enter(node) {
      const name = node.name;
      const inFrontmatter = frontmatterEnd > 0 && node.from < frontmatterEnd && node.to <= frontmatterEnd;
      if (inFrontmatter) return false;
      const onActiveLine = node.from <= activeLine.to && node.to >= activeLine.from;
      const headingClass = headingClasses.get(name);
      if (headingClass) {
        decorations.push(Decoration.mark({ class: headingClass }).range(node.from, node.to));
      }
      if (syntaxMarkNodes.has(name)) {
        const hiddenTo = inactiveSyntaxEnd(view, name, node.to);
        if (name === "ListMark" && !onActiveLine) {
          decorations.push(
            Decoration.replace({
              widget: new MarkdownListMarkerWidget(view.state.sliceDoc(node.from, node.to)),
            }).range(node.from, hiddenTo),
          );
          return;
        }
        decorations.push(
          onActiveLine
            ? Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" }).range(node.from, node.to)
            : Decoration.replace({}).range(node.from, hiddenTo),
        );
      }
      if (name === "URL" && !onActiveLine) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }
    },
  });
  return Decoration.set(decorations, true);
}

class MarkdownListMarkerWidget extends WidgetType {
  constructor(private readonly marker: string) {
    super();
  }

  eq(other: MarkdownListMarkerWidget): boolean {
    return this.marker === other.marker;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    const marker = this.marker.trim();
    const ordered = /^\d+[.)]$/.test(marker);
    element.className = "cm-md-list-widget";
    element.dataset.ordered = ordered ? "true" : "false";
    element.setAttribute("aria-hidden", "true");
    element.textContent = ordered ? marker : "•";
    return element;
  }
}

function inactiveSyntaxEnd(view: EditorView, nodeName: string, to: number): number {
  if (nodeName !== "HeaderMark" && nodeName !== "ListMark" && nodeName !== "QuoteMark") return to;
  const line = view.state.doc.lineAt(to);
  let next = to;
  while (next < line.to) {
    const char = view.state.sliceDoc(next, next + 1);
    if (char !== " " && char !== "\t") break;
    next += 1;
  }
  return next;
}

function markdownFrontmatterEnd(text: string): number {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return 0;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return 0;
  return end + "\n---".length;
}

export const MarkdownCodeEditor = forwardRef<MarkdownCodeEditorHandle, MarkdownCodeEditorProps>(
  function MarkdownCodeEditor(props, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(props.onChange);
    const onOpenLinkRef = useRef(props.onOpenLink);
    const onTextSelectionChangeRef = useRef(props.onTextSelectionChange);
    const valueRef = useRef(props.value);

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => viewRef.current?.state.doc.toString() ?? valueRef.current,
      }),
      [],
    );

    const extensions = useMemo(() => {
      const languageExtensions = codeMirrorLanguageExtensions(props.format);
      const editorKeymap =
        props.format === "markdown"
          ? keymap.of([...markdownKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap])
          : keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]);
      const base: Extension[] = [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        EditorView.lineWrapping,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ...languageExtensions,
        editorKeymap,
        placeholder(props.placeholder ?? ""),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((transaction) => transaction.annotation(externalValueUpdate))
          ) {
            const nextValue = update.state.doc.toString();
            valueRef.current = nextValue;
            onChangeRef.current(nextValue);
          }
          if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
            emitTextSelection(update.view, onTextSelectionChangeRef.current);
          }
        }),
        EditorView.domEventHandlers({
          click(event, view) {
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            const line = view.state.doc.lineAt(position);
            const href = markdownLinkAtOffset(line.text, position - line.from);
            if (!href) return false;
            if (onOpenLinkRef.current?.(href)) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            return false;
          },
        }),
        EditorView.theme({
          "&": {
            background: "transparent",
            color: "var(--knowledge-markdown-fg)",
            fontSize: "inherit",
          },
          ".cm-scroller": {
            fontFamily: "inherit",
            lineHeight: "1.75",
          },
          ".cm-content": {
            padding: "0",
            caretColor: "var(--knowledge-markdown-fg)",
            minHeight: "calc(100vh - 230px)",
          },
          ".cm-line": {
            color: "inherit",
            padding: "0",
          },
          ".cm-activeLine": {
            backgroundColor: "transparent",
          },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
            backgroundColor: "var(--knowledge-selection-bg)",
          },
          ".cm-cursor": {
            borderLeftColor: "var(--knowledge-markdown-fg)",
          },
          ".cm-placeholder": {
            color: "var(--knowledge-placeholder-fg)",
          },
          ".cm-gutters": {
            display: "none",
          },
          "&.cm-focused": {
            outline: "none",
          },
        }),
      ];
      if (props.format === "markdown") {
        base.splice(10, 0, syntaxHighlighting(markdownHighlightStyle), markdownLivePreviewDecorations, pasteURLAsLink);
      }
      return base;
    }, [props.format, props.placeholder]);

    useEffect(() => {
      onChangeRef.current = props.onChange;
    }, [props.onChange]);

    useEffect(() => {
      onOpenLinkRef.current = props.onOpenLink;
    }, [props.onOpenLink]);

    useEffect(() => {
      onTextSelectionChangeRef.current = props.onTextSelectionChange;
    }, [props.onTextSelectionChange]);

    useEffect(() => {
      if (!hostRef.current) return;
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: props.value,
          extensions,
        }),
      });
      viewRef.current = view;
      valueRef.current = props.value;
      if (props.autoFocus) {
        view.focus();
      }
      return () => {
        onTextSelectionChangeRef.current?.(null);
        view.destroy();
        viewRef.current = null;
      };
    }, [extensions]);

    useEffect(() => {
      if (props.autoFocus) {
        viewRef.current?.focus();
      }
    }, [props.autoFocus]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentValue = view.state.doc.toString();
      if (props.value === currentValue) return;
      const change = minimalTextChange(currentValue, props.value);
      const nextSelection = EditorSelection.create(
        view.state.selection.ranges.map((range) =>
          EditorSelection.range(
            mapPositionThroughTextChange(range.anchor, change),
            mapPositionThroughTextChange(range.head, change),
          ),
        ),
        view.state.selection.mainIndex,
      );
      const wasFocused = view.hasFocus;
      valueRef.current = props.value;
      view.dispatch({
        changes: change,
        selection: nextSelection,
        annotations: externalValueUpdate.of(true),
      });
      if (wasFocused) {
        view.focus();
      }
    }, [props.value]);

    return <div className="knowledge-markdown-codemirror" ref={hostRef} />;
  },
);

function minimalTextChange(currentValue: string, nextValue: string): { from: number; to: number; insert: string } {
  let start = 0;
  const currentLength = currentValue.length;
  const nextLength = nextValue.length;
  while (start < currentLength && start < nextLength && currentValue[start] === nextValue[start]) {
    start += 1;
  }

  let currentEnd = currentLength;
  let nextEnd = nextLength;
  while (currentEnd > start && nextEnd > start && currentValue[currentEnd - 1] === nextValue[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return {
    from: start,
    to: currentEnd,
    insert: nextValue.slice(start, nextEnd),
  };
}

function mapPositionThroughTextChange(position: number, change: { from: number; to: number; insert: string }): number {
  const removedLength = change.to - change.from;
  const insertedLength = change.insert.length;
  if (position <= change.from) return position;
  if (position >= change.to) return position + insertedLength - removedLength;
  return change.from + Math.min(insertedLength, position - change.from);
}

function codeMirrorLanguageExtensions(format: MarkdownCodeEditorFormat): Extension[] {
  switch (format) {
    case "markdown":
      return [markdown()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "json":
    case "jsonl":
      return [json()];
    case "html":
    case "htm":
      return [html()];
    case "css":
    case "scss":
    case "sass":
    case "less":
      return [css()];
    case "javascript":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true })];
    case "typescript":
    case "ts":
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    default:
      return [];
  }
}

function emitTextSelection(
  view: EditorView,
  onTextSelectionChange: MarkdownCodeEditorProps["onTextSelectionChange"],
): void {
  if (!onTextSelectionChange) return;
  const range = view.state.selection.main;
  if (range.empty) {
    onTextSelectionChange(null);
    return;
  }
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  const text = view.state.sliceDoc(from, to);
  if (!text.trim()) {
    onTextSelectionChange(null);
    return;
  }
  const anchor = view.coordsAtPos(range.head) ?? view.coordsAtPos(to) ?? view.coordsAtPos(from);
  if (!anchor) {
    onTextSelectionChange(null);
    return;
  }
  const width = Math.max(1, anchor.right - anchor.left);
  const height = Math.max(1, anchor.bottom - anchor.top);
  onTextSelectionChange({
    text,
    rect: {
      left: anchor.left,
      top: anchor.top,
      right: anchor.right,
      bottom: anchor.bottom,
      width,
      height,
    },
  });
}

function markdownLinkAtOffset(line: string, offset: number): string {
  const pattern = /\[\[([^\]]+)]]|\[([^\]]+)]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const start = match.index;
    const end = pattern.lastIndex;
    if (offset < start || offset > end) continue;
    const wikiTarget = match[1]?.split("|")[0]?.trim();
    const markdownTarget = match[3]?.trim();
    return wikiTarget || markdownTarget || "";
  }
  return "";
}
