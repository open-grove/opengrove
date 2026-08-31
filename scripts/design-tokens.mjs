#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const designPath = join(projectRoot, "web", "src", "styles", "design.md");
const tokensPath = join(projectRoot, "web", "src", "styles", "tokens.css");

export const GENERATED_START = "/* AUTO-GENERATED DESIGN TOKENS START";
export const GENERATED_END = "/* AUTO-GENERATED DESIGN TOKENS END */";

const SYSTEM_DARK_SELECTOR =
  ':root[data-theme="system"]:not([data-resolved-theme]),\n' + "  :root:not([data-theme]):not([data-resolved-theme])";

const COLOR_VAR_OVERRIDES = new Map([
  ["white", "--og-white"],
  ["canvas", "--og-canvas"],
  ["sidebar-bg", "--og-sidebar-bg"],
  ["brand-green", "--c-brand-green"],
  ["interaction-blue", "--c-interaction-blue"],
  ["sapling-green", "--og-sapling-green"],
  ["sapling-highlight", "--og-sapling-highlight"],
  ["sapling-shade", "--og-sapling-shade"],
  ["sapling-trunk", "--og-sapling-trunk"],
  ["sapling-trunk-highlight", "--og-sapling-trunk-highlight"],
  ["bg", "--c-bg"],
  ["surface", "--c-surface"],
  ["surface-hover", "--c-surface-hover"],
  ["surface-active", "--c-surface-active"],
  ["surface-raised", "--c-surface-raised"],
  ["surface-sunken", "--c-surface-sunken"],
  ["popover", "--c-popover"],
  ["popover-solid", "--c-popover-solid"],
  ["text-strong", "--c-text-strong"],
  ["text", "--c-text"],
  ["text-2", "--c-text-2"],
  ["text-3", "--c-text-3"],
  ["text-muted", "--c-muted"],
  ["text-faint", "--c-faint"],
  ["border", "--c-border"],
  ["border-strong", "--c-border-strong"],
  ["accent", "--c-accent"],
  ["accent-hover", "--c-accent-hover"],
  ["accent-soft", "--c-accent-soft"],
  ["focus-ring", "--c-focus-ring"],
  ["success", "--c-success"],
  ["warning", "--c-warning"],
  ["error", "--c-error"],
  ["link", "--c-link"],
  ["link-strong", "--c-link-strong"],
  ["violet", "--c-violet"],
  ["success-soft", "--c-success-soft"],
  ["error-soft", "--c-error-soft"],
  ["warning-soft", "--c-warning-soft"],
  ["section-text", "--og-section-text"],
  ["section-title", "--og-section-title"],
  ["section-muted", "--og-section-muted"],
  ["section-icon", "--og-section-icon"],
  ["section-hover", "--og-section-hover"],
  ["section-active", "--og-section-active"],
  ["section-border", "--og-section-border"],
  ["overlay-scrim", "--c-overlay-scrim"],
]);

const BUILTIN_COMPAT_ALIASES = {
  "og-text-strong": "{colors.text-strong}",
  "c-text-muted": "{colors.text-muted}",
  "c-text-faint": "{colors.text-faint}",
};

function cssVarForColor(key) {
  if (COLOR_VAR_OVERRIDES.has(key)) return COLOR_VAR_OVERRIDES.get(key);
  if (/^neutral-\d+$/.test(key) || /^line-\d+$/.test(key)) return `--c-${key}`;
  return `--c-${key}`;
}

function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && i + 1 < line.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function splitKeyValue(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) {
      return [text.slice(0, i), text.slice(i + 1)];
    }
  }
  return [text, ""];
}

function unquote(text) {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineObject(text) {
  const body = text.trim().slice(1, -1);
  const out = {};
  for (const part of splitTopLevel(body, ",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawKey, rawValue] = splitKeyValue(trimmed);
    out[unquote(rawKey)] = parseScalar(rawValue.trim());
  }
  return out;
}

function parseScalar(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return parseInlineObject(trimmed);
  return unquote(trimmed);
}

export function parseFrontmatter(markdown) {
  const opening = /^---\r?\n/.exec(markdown);
  if (!opening) {
    throw new Error("design.md is missing frontmatter");
  }
  const body = markdown.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(body);
  if (!closing) throw new Error("design.md frontmatter is not closed");
  return body.slice(0, closing.index);
}

export function parseDesignFrontmatter(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  let skipBlockIndent = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const rawIndent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (skipBlockIndent !== null) {
      if (rawLine.trim() === "" || rawIndent > skipBlockIndent) continue;
      skipBlockIndent = null;
    }

    const withoutComment = stripInlineComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    const [rawKey, rawValue] = splitKeyValue(trimmed);
    const key = unquote(rawKey);
    const valueText = rawValue.trim();
    if (!key) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (valueText === ">-" || valueText === "|" || valueText === "|-" || valueText === ">") {
      parent[key] = "";
      skipBlockIndent = indent;
      continue;
    }
    if (!valueText) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }
    parent[key] = parseScalar(valueText);
  }
  return root;
}

export function loadDesign() {
  return parseDesignFrontmatter(parseFrontmatter(readFileSync(designPath, "utf8")));
}

function cssVarForPath(path) {
  const parts = path.split(".");
  if (parts[0] === "colors") return cssVarForColor(parts.slice(1).join("-"));
  if (parts[0] === "typography") {
    if (parts[1] === "fontFamily") return `--font-${parts[2]}`;
    if (parts[1] === "fontWeight") return `--fw-${parts[2]}`;
    if (parts[1] === "fontSize") return `--fs-${parts[2]}`;
    if (parts[1] === "lineHeight") return `--lh-${parts[2]}`;
    if (parts[1] === "letterSpacing") return "--letter-spacing";
  }
  if (parts[0] === "spacing") return `--sp-${parts[1]}`;
  if (parts[0] === "rounded") return `--r-${parts[1]}`;
  if (parts[0] === "elevation") return `--shadow-${parts[1]}`;
  if (parts[0] === "motion") {
    if (parts[1] === "duration") return `--motion-${parts[2]}`;
    if (parts[1] === "easing") return parts[2] === "standard" ? "--motion-ease" : `--motion-ease-${parts[2]}`;
  }
  if (parts[0] === "layout") return `--${parts[1]}`;
  if (parts[0] === "state") return `--state-${parts[1]}`;
  if (parts[0] === "focus") return `--focus-${parts[1]}`;
  throw new Error(`Unsupported design token reference: ${path}`);
}

function renderReferences(value) {
  return String(value).replace(/\{([^}]+)\}/g, (_, path) => `var(${cssVarForPath(path)})`);
}

function valueForTheme(rawValue, theme) {
  if (rawValue && typeof rawValue === "object") {
    if ("ref" in rawValue) return renderReferences(rawValue.ref);
    if ("light" in rawValue || "dark" in rawValue) {
      return renderReferences(rawValue[theme] ?? rawValue.light);
    }
  }
  return renderReferences(rawValue);
}

function aliasCssVar(name) {
  if (name.startsWith("paper-")) return `--og-${name}`;
  return `--${name}`;
}

function addDeclaration(list, prop, value) {
  list.push({ prop, value: String(value) });
}

// Half-step keys ("1-5") are not integer-like, so plain object iteration would
// emit them after every whole step. Order the scale by its own values instead.
function spacingEntriesByValue(spacing) {
  return Object.entries(spacing).sort(
    ([, left], [, right]) => Number.parseFloat(String(left)) - Number.parseFloat(String(right)),
  );
}

function buildThemeDeclarations(design, theme) {
  const declarations = [];
  if (theme === "light") {
    addDeclaration(declarations, "color-scheme", "light");
  } else {
    addDeclaration(declarations, "color-scheme", "dark");
  }

  for (const [key, rawValue] of Object.entries(design.colors ?? {})) {
    addDeclaration(declarations, cssVarForColor(key), valueForTheme(rawValue, theme));
  }

  if (theme === "light") {
    const aliases = { ...(design.aliases ?? {}), ...BUILTIN_COMPAT_ALIASES };
    for (const [key, rawValue] of Object.entries(aliases)) {
      addDeclaration(declarations, aliasCssVar(key), valueForTheme(rawValue, theme));
    }

    const typography = design.typography ?? {};
    for (const [key, rawValue] of Object.entries(typography.fontFamily ?? {})) {
      addDeclaration(declarations, `--font-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(typography.fontWeight ?? {})) {
      addDeclaration(declarations, `--fw-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(typography.fontSize ?? {})) {
      addDeclaration(declarations, `--fs-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(typography.lineHeight ?? {})) {
      addDeclaration(declarations, `--lh-${key}`, valueForTheme(rawValue, theme));
    }
    if (typography.letterSpacing !== undefined) {
      addDeclaration(declarations, "--letter-spacing", valueForTheme(typography.letterSpacing, theme));
    }

    for (const [key, rawValue] of spacingEntriesByValue(design.spacing ?? {})) {
      addDeclaration(declarations, `--sp-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(design.rounded ?? {})) {
      addDeclaration(declarations, `--r-${key}`, valueForTheme(rawValue, theme));
    }
  }

  for (const [key, rawValue] of Object.entries(design.elevation ?? {})) {
    addDeclaration(declarations, `--shadow-${key}`, valueForTheme(rawValue, theme));
  }

  if (theme === "light") {
    const motion = design.motion ?? {};
    for (const [key, rawValue] of Object.entries(motion.duration ?? {})) {
      addDeclaration(declarations, `--motion-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(motion.easing ?? {})) {
      const suffix = key === "standard" ? "ease" : `ease-${key}`;
      addDeclaration(declarations, `--motion-${suffix}`, valueForTheme(rawValue, theme));
    }
    for (const key of Object.keys(motion.duration ?? {})) {
      addDeclaration(declarations, `--dur-${key}`, `var(--motion-${key})`);
    }
    for (const key of Object.keys(motion.easing ?? {})) {
      const suffix = key === "standard" ? "ease" : `ease-${key}`;
      const compat = key === "standard" ? "ease" : `ease-${key}`;
      addDeclaration(declarations, `--${compat}`, `var(--motion-${suffix})`);
    }

    for (const [key, rawValue] of Object.entries(design.zIndex ?? {})) {
      addDeclaration(declarations, `--z-${key}`, valueForTheme(rawValue, theme));
    }
    for (const [key, rawValue] of Object.entries(design.layout ?? {})) {
      const rendered = valueForTheme(rawValue, theme);
      addDeclaration(declarations, `--${key}`, rendered);
      addDeclaration(declarations, `--layout-${key}`, `var(--${key})`);
    }
    for (const [key, rawValue] of Object.entries(design.focus ?? {})) {
      addDeclaration(declarations, `--focus-${key}`, valueForTheme(rawValue, theme));
    }

    for (const [componentKey, spec] of Object.entries(design.components ?? {})) {
      for (const [key, rawValue] of Object.entries(spec ?? {})) {
        const cssKey = key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
        addDeclaration(declarations, `--${componentKey}-${cssKey}`, valueForTheme(rawValue, theme));
      }
    }
  }

  for (const [key, rawValue] of Object.entries(design.state ?? {})) {
    addDeclaration(declarations, `--state-${key}`, valueForTheme(rawValue, theme));
  }

  return declarations;
}

function formatDeclarations(declarations, indent) {
  return declarations.map(({ prop, value }) => `${indent}${prop}: ${value};`).join("\n");
}

export function buildGeneratedTokenBlock(design = loadDesign()) {
  const light = buildThemeDeclarations(design, "light");
  const dark = buildThemeDeclarations(design, "dark");
  const generated = [
    `${GENERATED_START}\n * Source: web/src/styles/design.md\n * Do not edit this block by hand. Run: npm run tokens:gen\n */`,
    ":root {",
    formatDeclarations(light, "  "),
    "}",
    "",
    ':root[data-resolved-theme="dark"] {',
    formatDeclarations(dark, "  "),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    `  ${SYSTEM_DARK_SELECTOR} {`,
    formatDeclarations(dark, "    "),
    "  }",
    "}",
    GENERATED_END,
  ].join("\n");
  return `${generated}\n`;
}

export function generatedTokenNames(design = loadDesign()) {
  const names = new Set();
  for (const decl of [...buildThemeDeclarations(design, "light"), ...buildThemeDeclarations(design, "dark")]) {
    if (decl.prop.startsWith("--")) names.add(decl.prop);
  }
  return names;
}

function findBlock(css, selector, startIndex = 0) {
  const selectorIndex = css.indexOf(selector, startIndex);
  if (selectorIndex < 0) return null;
  const open = css.indexOf("{", selectorIndex);
  if (open < 0) return null;
  let depth = 1;
  for (let i = open + 1; i < css.length; i += 1) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`Unclosed CSS comment after ${selector}`);
      i = end + 1;
      continue;
    }
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          start: selectorIndex,
          open,
          close: i,
          end: i + 1,
          content: css.slice(open + 1, i),
        };
      }
    }
  }
  throw new Error(`Unclosed CSS block: ${selector}`);
}

function removeDeclarations(content, generatedNames) {
  let next = content;
  for (const prop of generatedNames) {
    const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\n?\\s*${escaped}\\s*:[\\s\\S]*?;`, "g"), "");
  }
  next = next
    .replace(
      /\n?\s*\/\*\s*── (Color|Typography|Spacing|Radius|Elevation|Motion|Z-index|Layout|State|Focus).*?\*\//g,
      "",
    )
    .replace(/\n?\s*\/\*\s*Palette consolidation targets[\s\S]*?\*\//g, "")
    .replace(/\n?\s*\/\*\s*Translucent hairlines[\s\S]*?\*\//g, "")
    .replace(/\n?\s*\/\*\s*Extra semantic accents[\s\S]*?\*\//g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return next ? `${next}\n` : "";
}

function componentRootContent(rootContent, generatedNames) {
  const marker = "/* ── Component semantic tokens ── */";
  const markerIndex = rootContent.indexOf(marker);
  const componentSlice = markerIndex >= 0 ? rootContent.slice(markerIndex) : rootContent;
  return removeDeclarations(componentSlice, generatedNames);
}

function extractSystemInnerContent(css) {
  const media = findBlock(css, "@media (prefers-color-scheme: dark)");
  if (!media) return "";
  const inner = findBlock(media.content, ':root[data-theme="system"]:not([data-resolved-theme])');
  return inner?.content ?? "";
}

function buildComponentCss(css, generatedNames) {
  const withoutGenerated = removeGeneratedBlock(css);
  const root = findBlock(withoutGenerated, ":root {");
  if (!root) throw new Error("tokens.css is missing the light :root block");
  const dark = findBlock(withoutGenerated, ':root[data-resolved-theme="dark"]');
  if (!dark) throw new Error('tokens.css is missing :root[data-resolved-theme="dark"]');
  const rootContent = componentRootContent(root.content, generatedNames);
  const darkContent = removeDeclarations(dark.content, generatedNames);
  const systemContent = removeDeclarations(extractSystemInnerContent(withoutGenerated), generatedNames);

  const blocks = [];
  if (rootContent.trim()) blocks.push([":root {", rootContent.trimEnd(), "}"].join("\n"));
  if (darkContent.trim()) blocks.push([':root[data-resolved-theme="dark"] {', darkContent.trimEnd(), "}"].join("\n"));
  if (systemContent.trim()) {
    blocks.push(
      [
        "@media (prefers-color-scheme: dark) {",
        `  ${SYSTEM_DARK_SELECTOR} {`,
        systemContent.trimEnd(),
        "  }",
        "}",
      ].join("\n"),
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

export function hasGeneratedBlock(css) {
  return css.includes(GENERATED_START) && css.includes(GENERATED_END);
}

export function removeGeneratedBlock(css) {
  const start = css.indexOf(GENERATED_START);
  if (start < 0) return css;
  const end = css.indexOf(GENERATED_END, start);
  if (end < 0) throw new Error("Generated token block start exists without an end marker");
  return `${css.slice(0, start)}${css.slice(end + GENERATED_END.length)}`.trimStart();
}

export function replaceGeneratedBlock(css, generatedBlock, design = loadDesign()) {
  if (hasGeneratedBlock(css)) {
    const start = css.indexOf(GENERATED_START);
    const end = css.indexOf(GENERATED_END, start);
    if (end < 0) throw new Error("Generated token block start exists without an end marker");
    const next = `${css.slice(0, start)}${generatedBlock}${css.slice(end + GENERATED_END.length).replace(/^\s*/, "\n")}`;
    return next.endsWith("\n") ? next : `${next}\n`;
  }
  const componentCss = buildComponentCss(css, generatedTokenNames(design));
  return `${generatedBlock}\n${componentCss}`;
}

function normalizeCssForCompare(css) {
  return css.replace(/\r\n/g, "\n").trim();
}

function buildReport(currentCss, expectedCss) {
  const inSync = normalizeCssForCompare(currentCss) === normalizeCssForCompare(expectedCss);
  return {
    inSync,
    generatedBlockPresent: hasGeneratedBlock(currentCss),
    expectedBytes: Buffer.byteLength(expectedCss),
    currentBytes: Buffer.byteLength(currentCss),
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  const check = args.has("--check");
  const json = args.has("--json");
  const design = loadDesign();
  const generated = buildGeneratedTokenBlock(design);
  const current = existsSync(tokensPath) ? readFileSync(tokensPath, "utf8") : "";
  const expected = replaceGeneratedBlock(current, generated, design);
  const report = buildReport(current, expected);

  if (write) {
    if (!report.inSync) writeFileSync(tokensPath, expected, "utf8");
    console.log(
      report.inSync
        ? "Design tokens already synchronized."
        : `Design tokens synchronized in ${relative(projectRoot, tokensPath)}.`,
    );
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.inSync) {
    console.log("Design tokens are synchronized with web/src/styles/design.md.");
  } else {
    console.log("Design tokens are not synchronized with web/src/styles/design.md.");
    console.log("Run: npm run tokens:gen");
  }

  if (check && !report.inSync) process.exit(1);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  main();
}
