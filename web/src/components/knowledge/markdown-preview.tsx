import { useState, type MouseEvent, type ReactNode } from "react";
import { Download, Loader2, Maximize2, Plus, X } from "lucide-react";
import { BridgeDownloadError, downloadBridgeFile } from "../../bridge-client";
import { APP_VAULT_DIR } from "../../identity";
import { translate, useI18n } from "../../i18n";
import { MotionMenu, MotionMenuItem } from "../ui/motion/menu";
import "./markdown-preview.css";

export function MarkdownPreview(props: {
  text: string;
  format: string;
  vaultPath?: string;
  onActivate?(): void;
  onOpenLink?(href: string): boolean;
}) {
  const { t } = useI18n();
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const text = props.format === "markdown" ? stripMarkdownFrontmatter(props.text) : props.text;
  if (props.format !== "markdown") {
    return (
      <pre className="markdown-preview markdown-preview-code" onClick={props.onActivate}>
        <code>{props.text || " "}</code>
      </pre>
    );
  }
  const nodes = markdownBlocks(text, props.vaultPath, setPreviewImage, props.onOpenLink);
  return (
    <>
      <div className="markdown-preview" data-click-to-edit="true" onClick={props.onActivate}>
        {nodes.length ? nodes : <p className="markdown-empty">{t("knowledge.emptyPage")}</p>}
      </div>
      {previewImage ? (
        <div
          className="markdown-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.alt || t("knowledge.imagePreview")}
          onClick={() => setPreviewImage(null)}
        >
          <div className="markdown-image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <div className="markdown-image-lightbox-actions">
              <MarkdownImageDownloadAction
                src={previewImage.src}
                fileName={fileNameFromAssetUri(previewImage.src) || "image"}
                label={t("knowledge.saveImage")}
                iconSize={17}
              />
              <button
                className="markdown-image-action"
                type="button"
                aria-label={t("knowledge.closePreview")}
                title={t("knowledge.closePreview")}
                onClick={() => setPreviewImage(null)}
              >
                <X size={17} />
              </button>
            </div>
            <img src={previewImage.src} alt={previewImage.alt || t("knowledge.imagePreview")} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function MarkdownProperties(props: {
  properties: MarkdownProperty[];
  recommendations: MarkdownPropertyDefinition[];
  onActivate?(): void;
  onAddProperty(property: MarkdownPropertyDefinition): void;
}) {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!props.properties.length && !props.recommendations.length) return null;

  function stopRowActivate(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  function addProperty(event: MouseEvent<HTMLButtonElement>, property: MarkdownPropertyDefinition) {
    event.stopPropagation();
    props.onAddProperty(property);
    setPickerOpen(false);
  }

  return (
    <section className="md-properties" aria-label={t("knowledge.noteProperties")}>
      <div className="md-properties-title">{t("knowledge.noteProperties")}</div>
      <div className="md-properties-list">
        {props.properties.map((property) => (
          <button className="md-property-row" key={property.key} type="button" onClick={props.onActivate}>
            <span className="md-property-icon" aria-hidden="true" />
            <span className="md-property-key">{property.key}</span>
            <span className="md-property-value">{formatMarkdownPropertyValue(property.value)}</span>
          </button>
        ))}
        <MotionMenu
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          className="md-property-recommendations"
          size="preserve"
          align="start"
          ariaLabel={t("knowledge.recommendedProperties")}
          trigger={
            <button
              className="md-add-property"
              type="button"
              onClick={stopRowActivate}
              disabled={!props.recommendations.length}
              title={
                props.recommendations.length
                  ? t("knowledge.addRecommendedPropertyTitle")
                  : t("knowledge.recommendedPropertiesComplete")
              }
            >
              <Plus size={15} />
              {props.recommendations.length ? t("knowledge.addRecommendedProperty") : t("knowledge.propertiesComplete")}
            </button>
          }
        >
          {props.recommendations.map((property) => (
            <MotionMenuItem
              className="md-property-recommendation"
              key={property.key}
              onClick={(event) => addProperty(event, property)}
            >
              <span>{property.key}</span>
              <small>{property.description}</small>
            </MotionMenuItem>
          ))}
        </MotionMenu>
      </div>
    </section>
  );
}

export type MarkdownProperty = { key: string; value: string | string[] };
export type MarkdownPropertyValue = string | string[] | boolean | number;
export type MarkdownPropertyDefinition = {
  key: string;
  description: string;
  value: MarkdownPropertyValue;
};

export function parseMarkdownFrontmatter(text: string): { properties: MarkdownProperty[]; body: string } | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const raw = normalized.slice(4, end);
  const properties: MarkdownProperty[] = [];
  let current: MarkdownProperty | undefined;
  for (const line of raw.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && current) {
      const item = listItem[1] ?? "";
      current.value = Array.isArray(current.value)
        ? [...current.value, cleanYamlScalar(item)]
        : [String(current.value), cleanYamlScalar(item)].filter(Boolean);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    current = {
      key,
      value: cleanYamlScalar(match[2] || ""),
    };
    properties.push(current);
  }
  return {
    properties: properties.filter((property) =>
      Array.isArray(property.value) ? property.value.length > 0 : Boolean(String(property.value).trim()),
    ),
    body: normalized.slice(end + 5),
  };
}

export function recommendedMarkdownProperties(
  document: any,
  vaultPath: string,
  properties: MarkdownProperty[],
): MarkdownPropertyDefinition[] {
  const existing = new Set(properties.map((property) => canonicalPropertyKey(property.key)));
  const definitions = markdownPropertyDefinitionsForDocument(document, vaultPath);
  return definitions.filter((property) => !existing.has(canonicalPropertyKey(property.key)));
}

export function insertMarkdownFrontmatterProperty(text: string, property: MarkdownPropertyDefinition): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const entry = formatMarkdownFrontmatterEntry(property);
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    if (end >= 0) {
      const before = normalized.slice(0, end).replace(/\s+$/, "");
      return `${before}\n${entry}${normalized.slice(end)}`;
    }
  }
  return `---\n${entry}\n---\n\n${normalized}`;
}

export function stripMarkdownFrontmatter(text: string): string {
  return parseMarkdownFrontmatter(text)?.body.trimStart() ?? text;
}

export function vaultFileDisplayTitle(fileName: string | undefined, fallback: string): string {
  const name = String(fileName || "").trim();
  if (!name) return fallback;
  return name.replace(/\.(md|markdown|mdx|txt|json|ya?ml)$/i, "") || fallback;
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatMarkdownPropertyValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function markdownPropertyDefinitionsForDocument(document: any, vaultPath: string): MarkdownPropertyDefinition[] {
  const path = String(vaultPath || "");
  const type = String(document?.type || "");
  const isSkill = type === "skill" || path.startsWith("skills/");
  if (isSkill) {
    return [
      { key: "when_to_use", description: translate("knowledge.propWhenToUse"), value: "" },
      { key: "allowed-tools", description: translate("knowledge.propAllowedTools"), value: [] },
      { key: "activities", description: translate("knowledge.propActivities"), value: [] },
      { key: "user-invocable", description: translate("knowledge.propUserInvocable"), value: true },
      { key: "disable-model-invocation", description: translate("knowledge.propDisableModelInvocation"), value: false },
      { key: "references", description: translate("knowledge.propReferences"), value: [] },
      { key: "native_publish", description: translate("knowledge.propNativePublish"), value: [] },
    ];
  }
  if (type === "artifact_ref" || path.startsWith("artifacts/")) {
    return [
      { key: "artifact_type", description: translate("knowledge.propArtifactType"), value: "" },
      { key: "version", description: translate("knowledge.propVersion"), value: 1 },
      { key: "created_by", description: translate("knowledge.propCreatedBy"), value: "" },
      { key: "source_run", description: translate("knowledge.propSourceRun"), value: "" },
      { key: "derived_from", description: translate("knowledge.propDerivedFrom"), value: [] },
      { key: "status", description: "draft / generated / selected / deprecated", value: "generated" },
    ];
  }
  if (type === "memory" || path.startsWith("memories/")) {
    return [
      { key: "memory_type", description: "preference / fact / correction / project_rule", value: "" },
      { key: "scope", description: "global / project / thread / page", value: document?.scope || "project" },
      {
        key: "confidence",
        description: translate("knowledge.propConfidence"),
        value: typeof document?.confidence === "number" ? document.confidence : 0.6,
      },
      { key: "last_used", description: translate("knowledge.propLastUsed"), value: "" },
      { key: "feedback", description: translate("knowledge.propFeedback"), value: [] },
    ];
  }
  return [
    { key: "summary", description: translate("knowledge.propSummary"), value: "" },
    { key: "status", description: "draft / active / archived / stale", value: document?.lifecycle || "active" },
    { key: "source", description: translate("knowledge.propSource"), value: "" },
    { key: "tags", description: translate("knowledge.propTags"), value: [] },
  ];
}

function canonicalPropertyKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

function formatMarkdownFrontmatterEntry(property: MarkdownPropertyDefinition): string {
  const value = property.value;
  if (Array.isArray(value)) {
    return value.length
      ? `${property.key}:\n${value.map((item) => `  - ${yamlFrontmatterScalar(item)}`).join("\n")}`
      : `${property.key}: []`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return `${property.key}: ${String(value)}`;
  }
  return `${property.key}: ${yamlFrontmatterScalar(value)}`;
}

function yamlFrontmatterScalar(value: string): string {
  const text = String(value ?? "");
  if (!text) return '""';
  return /^[\w\u4e00-\u9fff .,:/@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function markdownBlocks(
  text: string,
  vaultPath?: string,
  onImageOpen?: (image: { src: string; alt: string }) => void,
  onOpenLink?: (href: string) => boolean,
): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isMarkdownHorizontalRule(line)) {
      blocks.push(<hr className="markdown-hr" key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    const imageBlock = line.trim().match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    if (imageBlock) {
      const alt = imageBlock[1] || "";
      const src = resolveMarkdownImageHref(imageBlock[2] || "", vaultPath);
      blocks.push(<MarkdownPreviewImage alt={alt} key={`image-${index}`} onOpen={onImageOpen} src={src} />);
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="markdown-code-block" key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length, 6);
      blocks.push(
        renderMarkdownHeading(level, heading[2] ?? "", `heading-${index}`, vaultPath, onImageOpen, onOpenLink),
      );
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(line, lines[index + 1] || "")) {
      const table = parseMarkdownTable(lines, index, vaultPath, onImageOpen, onOpenLink);
      blocks.push(table.node);
      index = table.nextIndex;
      continue;
    }

    if (matchMarkdownListItem(line)) {
      const list = parseMarkdownList(lines, index, undefined, vaultPath, onImageOpen, onOpenLink);
      blocks.push(list.node);
      index = list.nextIndex;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {markdownBlocks(quoteLines.join("\n"), vaultPath, onImageOpen, onOpenLink)}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !isMarkdownBlockStart(lines[index] ?? "", lines[index + 1] || "")
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join(" "), vaultPath, onImageOpen, onOpenLink)}</p>,
    );
  }

  return blocks;
}

function renderMarkdownHeading(
  level: number,
  text: string,
  key: string,
  vaultPath?: string,
  onImageOpen?: (image: { src: string; alt: string }) => void,
  onOpenLink?: (href: string) => boolean,
): ReactNode {
  const content = renderInlineMarkdown(text, vaultPath, onImageOpen, onOpenLink);
  if (level === 1) return <h1 key={key}>{content}</h1>;
  if (level === 2) return <h2 key={key}>{content}</h2>;
  if (level === 3) return <h3 key={key}>{content}</h3>;
  if (level === 4) return <h4 key={key}>{content}</h4>;
  if (level === 5) return <h5 key={key}>{content}</h5>;
  return <h6 key={key}>{content}</h6>;
}

function isMarkdownBlockStart(line: string, nextLine = ""): boolean {
  return (
    /^(```|#{1,6}\s+|>\s?)/.test(line) ||
    Boolean(matchMarkdownListItem(line)) ||
    isMarkdownHorizontalRule(line) ||
    isMarkdownTableStart(line, nextLine)
  );
}

function isMarkdownHorizontalRule(line: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

type MarkdownTableAlignment = "left" | "center" | "right" | undefined;

function isMarkdownTableStart(headerLine: string, separatorLine: string): boolean {
  if (!headerLine.includes("|")) return false;
  const header = splitMarkdownTableRow(headerLine);
  const separator = splitMarkdownTableRow(separatorLine);
  return (
    header.length > 0 &&
    separator.length >= header.length &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number,
  vaultPath?: string,
  onImageOpen?: (image: { src: string; alt: string }) => void,
  onOpenLink?: (href: string) => boolean,
): { node: ReactNode; nextIndex: number } {
  const headers = splitMarkdownTableRow(lines[startIndex] || "");
  const alignments = splitMarkdownTableRow(lines[startIndex + 1] || "").map(markdownTableAlignment);
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (
    index < lines.length &&
    (lines[index] ?? "").trim() &&
    (lines[index] ?? "").includes("|") &&
    !isMarkdownBlockStart(lines[index] ?? "", lines[index + 1] || "")
  ) {
    rows.push(splitMarkdownTableRow(lines[index] || ""));
    index += 1;
  }
  const cellStyle = (alignment: MarkdownTableAlignment) => (alignment ? { textAlign: alignment } : undefined);
  return {
    nextIndex: index,
    node: (
      <div className="markdown-table-wrap" key={`table-${startIndex}`}>
        <table className="markdown-table">
          <thead>
            <tr>
              {headers.map((header, columnIndex) => (
                <th key={`h-${columnIndex}`} style={cellStyle(alignments[columnIndex])}>
                  {renderInlineMarkdown(header, vaultPath, onImageOpen, onOpenLink)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`r-${rowIndex}`}>
                {headers.map((_header, columnIndex) => (
                  <td key={`c-${columnIndex}`} style={cellStyle(alignments[columnIndex])}>
                    {renderInlineMarkdown(row[columnIndex] || "", vaultPath, onImageOpen, onOpenLink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function markdownTableAlignment(separator: string): MarkdownTableAlignment {
  const value = separator.replace(/\s+/g, "");
  const left = value.startsWith(":");
  const right = value.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

type MarkdownListItemMatch = {
  indent: number;
  ordered: boolean;
  checked?: boolean;
  text: string;
};

function matchMarkdownListItem(line: string): MarkdownListItemMatch | undefined {
  const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+((?:\[[ xX]\]\s+)?)(.*)$/);
  if (!match) return undefined;
  const task = (match[3] || "").match(/^\[([ xX])]\s+$/);
  return {
    indent: markdownIndentWidth(match[1] || ""),
    ordered: /^\d/.test(match[2] || ""),
    checked: task ? /x/i.test(task[1] || "") : undefined,
    text: match[4] || "",
  };
}

function parseMarkdownList(
  lines: string[],
  startIndex: number,
  baseIndent: number | undefined,
  vaultPath?: string,
  onImageOpen?: (image: { src: string; alt: string }) => void,
  onOpenLink?: (href: string) => boolean,
): { node: ReactNode; nextIndex: number } {
  const first = matchMarkdownListItem(lines[startIndex] || "");
  const indent = baseIndent ?? first?.indent ?? 0;
  const ordered = Boolean(first?.ordered);
  const items: ReactNode[] = [];
  let hasTaskItems = false;
  let index = startIndex;

  while (index < lines.length) {
    const match = matchMarkdownListItem(lines[index] || "");
    if (!match || match.indent < indent || match.indent !== indent || match.ordered !== ordered) break;

    const itemKey = index;
    const contentLines = [match.text];
    const children: ReactNode[] = [];
    const checked = match.checked;
    if (checked !== undefined) hasTaskItems = true;
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index] || "";
      if (!nextLine.trim()) {
        index += 1;
        break;
      }
      const nextMatch = matchMarkdownListItem(nextLine);
      if (nextMatch) {
        if (nextMatch.indent > indent) {
          const nested = parseMarkdownList(lines, index, nextMatch.indent, vaultPath, onImageOpen, onOpenLink);
          children.push(nested.node);
          index = nested.nextIndex;
          continue;
        }
        break;
      }
      if (markdownIndentWidth(nextLine.match(/^\s*/)?.[0] || "") > indent) {
        contentLines.push(nextLine.trim());
        index += 1;
        continue;
      }
      break;
    }

    items.push(
      renderMarkdownListItem({
        checked,
        children,
        content: contentLines.join(" "),
        key: `li-${itemKey}`,
        vaultPath,
        onImageOpen,
        onOpenLink,
      }),
    );
  }

  const className = hasTaskItems ? "markdown-task-list" : undefined;
  return {
    nextIndex: index,
    node: ordered ? (
      <ol className={className} key={`ol-${startIndex}`}>
        {items}
      </ol>
    ) : (
      <ul className={className} key={`ul-${startIndex}`}>
        {items}
      </ul>
    ),
  };
}

function renderMarkdownListItem(props: {
  checked?: boolean;
  children: ReactNode[];
  content: string;
  key: string;
  vaultPath?: string;
  onImageOpen?: (image: { src: string; alt: string }) => void;
  onOpenLink?: (href: string) => boolean;
}): ReactNode {
  const content = renderInlineMarkdown(props.content, props.vaultPath, props.onImageOpen, props.onOpenLink);
  if (props.checked !== undefined) {
    return (
      <li className="markdown-task-item" key={props.key}>
        <label>
          <input type="checkbox" checked={props.checked} disabled readOnly />
          <span>{content}</span>
        </label>
        {props.children}
      </li>
    );
  }
  return (
    <li key={props.key}>
      {content}
      {props.children}
    </li>
  );
}

function markdownIndentWidth(value: string): number {
  return value.replace(/\t/g, "    ").length;
}

function renderInlineMarkdown(
  text: string,
  vaultPath?: string,
  onImageOpen?: (image: { src: string; alt: string }) => void,
  onOpenLink?: (href: string) => boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  function pushText(value: string) {
    if (!value) return;
    const previous = nodes[nodes.length - 1];
    if (typeof previous === "string") {
      nodes[nodes.length - 1] = previous + value;
    } else {
      nodes.push(value);
    }
  }

  while (index < text.length) {
    const char = text[index] || "";

    if (char === "\\" && index + 1 < text.length) {
      pushText(text[index + 1] || "");
      index += 2;
      continue;
    }

    if (text.startsWith("![", index)) {
      const parsed = parseMarkdownLinkLike(text, index + 1);
      if (parsed) {
        const src = resolveMarkdownImageHref(parsed.href, vaultPath);
        nodes.push(
          <MarkdownPreviewImage alt={parsed.label} inline key={`image-${index}`} onOpen={onImageOpen} src={src} />,
        );
        index = parsed.end;
        continue;
      }
    }

    if (char === "`") {
      const end = findUnescapedToken(text, "`", index + 1);
      if (end > index) {
        nodes.push(<code key={`code-${index}`}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("***", index)) {
      const end = findUnescapedToken(text, "***", index + 3);
      if (end > index) {
        nodes.push(
          <strong key={`strong-em-${index}`}>
            <em>{renderInlineMarkdown(text.slice(index + 3, end), vaultPath, onImageOpen, onOpenLink)}</em>
          </strong>,
        );
        index = end + 3;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = findUnescapedToken(text, "**", index + 2);
      if (end > index) {
        nodes.push(
          <strong key={`strong-${index}`}>
            {renderInlineMarkdown(text.slice(index + 2, end), vaultPath, onImageOpen, onOpenLink)}
          </strong>,
        );
        index = end + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const end = findUnescapedToken(text, "~~", index + 2);
      if (end > index) {
        nodes.push(
          <del key={`del-${index}`}>
            {renderInlineMarkdown(text.slice(index + 2, end), vaultPath, onImageOpen, onOpenLink)}
          </del>,
        );
        index = end + 2;
        continue;
      }
    }

    if (
      (char === "*" || char === "_") &&
      !text.startsWith(`${char}${char}`, index) &&
      isInlineEmphasisOpeningBoundary(text, index)
    ) {
      const end = findInlineEmphasisEnd(text, char, index + 1);
      if (end > index && text.slice(index + 1, end).trim()) {
        nodes.push(
          <em key={`em-${index}`}>
            {renderInlineMarkdown(text.slice(index + 1, end), vaultPath, onImageOpen, onOpenLink)}
          </em>,
        );
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("[[", index)) {
      const end = findUnescapedToken(text, "]]", index + 2);
      if (end > index) {
        const wikiLink = parseWikiLinkToken(text.slice(index, end + 2));
        nodes.push(renderMarkdownLink(wikiLink.label, wikiLink.href, `wikilink-${index}`, onOpenLink));
        index = end + 2;
        continue;
      }
    }

    if (char === "[") {
      const parsed = parseMarkdownLinkLike(text, index);
      if (parsed) {
        nodes.push(
          renderMarkdownLink(
            renderInlineMarkdown(parsed.label, vaultPath, onImageOpen, onOpenLink),
            parsed.href,
            `link-${index}`,
            onOpenLink,
          ),
        );
        index = parsed.end;
        continue;
      }
    }

    const urlMatch = text.slice(index).match(/^(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/i);
    if (urlMatch && isAutoLinkBoundary(text, index)) {
      const rawUrl = trimAutoLinkTrailingPunctuation(urlMatch[0] || "");
      const href = rawUrl.startsWith("www.") ? `https://${rawUrl}` : rawUrl;
      nodes.push(renderMarkdownLink(rawUrl, href, `autolink-${index}`, onOpenLink));
      index += rawUrl.length;
      continue;
    }

    pushText(char);
    index += 1;
  }

  return nodes;
}

function renderMarkdownLink(
  label: ReactNode,
  href: string,
  key: string,
  onOpenLink?: (href: string) => boolean,
): ReactNode {
  const external = isExternalHref(href);
  function open(event: MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (onOpenLink?.(href)) {
      event.preventDefault();
    }
  }
  return (
    <a href={href || "#"} key={key} rel="noreferrer" target={external ? "_blank" : undefined} onClick={open}>
      {label || href}
    </a>
  );
}

function parseMarkdownLinkLike(
  text: string,
  startIndex: number,
): { label: string; href: string; end: number } | undefined {
  if (text[startIndex] !== "[") return undefined;
  const labelEnd = findUnescapedToken(text, "]", startIndex + 1);
  if (labelEnd <= startIndex || text[labelEnd + 1] !== "(") return undefined;
  const hrefEnd = findUnescapedToken(text, ")", labelEnd + 2);
  if (hrefEnd <= labelEnd) return undefined;
  return {
    label: text.slice(startIndex + 1, labelEnd),
    href: text
      .slice(labelEnd + 2, hrefEnd)
      .trim()
      .replace(/^<|>$/g, ""),
    end: hrefEnd + 1,
  };
}

function findUnescapedToken(text: string, token: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length) {
    const found = text.indexOf(token, index);
    if (found < 0) return -1;
    let slashCount = 0;
    for (let cursor = found - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return found;
    index = found + token.length;
  }
  return -1;
}

function findInlineEmphasisEnd(text: string, token: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length) {
    const found = findUnescapedToken(text, token, index);
    if (found < 0) return -1;
    if (isInlineEmphasisClosingBoundary(text, found, token.length)) return found;
    index = found + token.length;
  }
  return -1;
}

function isInlineEmphasisOpeningBoundary(text: string, index: number): boolean {
  const previous = text[index - 1] || "";
  const next = text[index + 1] || "";
  if (!next || /\s/.test(next)) return false;
  return !(isAsciiWord(previous) && isAsciiWord(next));
}

function isInlineEmphasisClosingBoundary(text: string, index: number, tokenLength: number): boolean {
  const previous = text[index - 1] || "";
  const next = text[index + tokenLength] || "";
  if (!previous || /\s/.test(previous)) return false;
  return !(isAsciiWord(previous) && isAsciiWord(next));
}

function isAsciiWord(value: string): boolean {
  return /^[A-Za-z0-9_]$/.test(value);
}

function isAutoLinkBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{"']/.test(text[index - 1] || "");
}

function trimAutoLinkTrailingPunctuation(url: string): string {
  return url.replace(/[.,!?;:。，！？；：、]+$/g, "");
}

function parseWikiLinkToken(token: string): { href: string; label: string } {
  const content = token.slice(2, -2).trim();
  const [href, label] = content.split("|");
  const cleanHref = (href ?? "").trim();
  return {
    href: cleanHref,
    label: (label || cleanHref.split("/").filter(Boolean).pop() || cleanHref).trim(),
  };
}

function MarkdownPreviewImage(props: {
  src: string;
  alt: string;
  inline?: boolean;
  onOpen?(image: { src: string; alt: string }): void;
}) {
  const { t } = useI18n();
  const fileName = fileNameFromAssetUri(props.src) || "image";
  function stop(event: MouseEvent) {
    event.stopPropagation();
  }
  function open(event: MouseEvent) {
    event.stopPropagation();
    props.onOpen?.({ src: props.src, alt: props.alt });
  }

  return (
    <span className="markdown-image-block" data-inline={props.inline ? "true" : "false"}>
      <button
        className="markdown-image-preview-button"
        type="button"
        onClick={open}
        aria-label={t("knowledge.zoomImageNamed", { name: props.alt || fileName })}
      >
        <img alt={props.alt} className="markdown-preview-image" loading="lazy" src={props.src} />
      </button>
      <span className="markdown-image-actions" onClick={stop}>
        <button
          className="markdown-image-action"
          type="button"
          onClick={open}
          aria-label={t("knowledge.zoomImageNamed", { name: props.alt || fileName })}
          title={t("knowledge.zoomImage")}
        >
          <Maximize2 size={16} />
        </button>
        <MarkdownImageDownloadAction
          src={props.src}
          fileName={fileName}
          label={t("knowledge.saveImageNamed", { name: props.alt || fileName })}
          iconSize={16}
        />
      </span>
    </span>
  );
}

function MarkdownImageDownloadAction(props: { src: string; fileName: string; label: string; iconSize: number }) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  function download(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDownloading(true);
    setDownloadError("");
    void downloadBridgeFile(props.src, props.fileName)
      .catch((error) => setDownloadError(markdownImageDownloadErrorMessage(error, t)))
      .finally(() => setDownloading(false));
  }

  return (
    <>
      <button
        className="markdown-image-action"
        type="button"
        onClick={download}
        disabled={downloading}
        aria-label={props.label}
        title={t("filePreview.save")}
      >
        {downloading ? (
          <Loader2 className="markdown-image-download-spinner" size={props.iconSize} />
        ) : (
          <Download size={props.iconSize} />
        )}
      </button>
      {downloadError ? (
        <span className="markdown-image-download-error" role="alert">
          {downloadError}
        </span>
      ) : null}
    </>
  );
}

function markdownImageDownloadErrorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof BridgeDownloadError) {
    if (error.kind === "auth") return t("filePreview.downloadAuthError");
    if (error.kind === "network") return t("filePreview.downloadNetworkError");
    if (error.kind === "timeout") return t("filePreview.downloadTimeoutError");
  }
  return t("filePreview.downloadFailed");
}

function resolveMarkdownImageHref(href: string, vaultPath?: string): string {
  const trimmed = href.trim().replace(/^<|>$/g, "");
  if (!trimmed) return "";
  if (
    /^(?:https?:|data:|blob:|#)/i.test(trimmed) ||
    trimmed.startsWith("/generated/") ||
    trimmed.startsWith("/vault-file/")
  ) {
    return trimmed;
  }

  const normalizedInput = trimmed.replace(/\\/g, "/");
  const vaultMarker = `/data/${APP_VAULT_DIR}/`;
  const markerIndex = normalizedInput.indexOf(vaultMarker);
  const relativeInput =
    markerIndex >= 0 ? normalizedInput.slice(markerIndex + vaultMarker.length) : normalizedInput.replace(/^\/+/, "");
  const baseDir = vaultPath && !relativeInput.startsWith("/") ? vaultPath.split("/").slice(0, -1).join("/") : "";
  const normalized = normalizeVaultRoutePath([baseDir, relativeInput].filter(Boolean).join("/"));
  return normalized ? `/vault-file/${normalized.split("/").map(encodeURIComponent).join("/")}` : trimmed;
}

function normalizeVaultRoutePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

// forwarding-boundary: names the navigation trust decision for rendered Markdown links.
function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function fileNameFromAssetUri(uri: string): string {
  const text = String(uri || "");
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    const part = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(part);
  } catch {
    return text.split("/").filter(Boolean).pop() || "";
  }
}
