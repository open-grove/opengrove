import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";

export const BASELINE_VERSION = 4;

export const DEBT_METRICS = [
  "rawColor",
  "fontSizeLiteral",
  "radiusLiteral",
  "spacingLiteral",
  "motionLiteral",
  "shadowLiteral",
  "important",
  "darkScoped",
];

const PATCH_LAYER_MARKERS = [
  "brand-refresh",
  "visual-cleanup",
  "chat-pass",
  "fixed-layout",
  "refresh-",
  "cleanup",
  "patch",
  "override",
];

const APPROVED_GLOBAL_STYLES = new Set([
  "styles.css",
  "styles/base/document.css",
  "styles/primitives.css",
  "styles/reset.css",
  "styles/tokens.css",
  "components/knowledge/markdown-preview.css",
]);

const RAW_COLOR_RE =
  /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(|(?<![-\w])(?:black|white)(?![-\w])/i;
const RAW_LENGTH_RE =
  /-?(?:\d*\.)?\d+(?<unit>cqmin|cqmax|vmin|vmax|svw|svh|svi|svb|lvw|lvh|lvi|lvb|dvw|dvh|dvi|dvb|cqw|cqh|cqi|cqb|rem|rlh|cap|ch|ex|ic|lh|vw|vh|vi|vb|px|em|pt|pc|in|cm|mm|q|%)(?![a-z%])/gi;
const RAW_TIME_RE = /-?(?:\d*\.)?\d+(?:ms|s)\b/gi;
const SPACING_PROPERTY_RE = /^(?:padding|margin|gap|row-gap|column-gap|inset)(?:-|$)/;
const RADIUS_PROPERTY_RE = /(?:^|-)border-(?:top-left-|top-right-|bottom-right-|bottom-left-)?radius$|^border-radius$/;
const MOTION_PROPERTY_RE =
  /^(?:transition|transition-duration|transition-delay|animation|animation-duration|animation-delay)$/;
const SHADOW_PROPERTY_RE = /^(?:box-shadow|text-shadow)$/;

export function analyzeCssTree({ cssRoot, tokensFile }) {
  const files = listCssFiles(cssRoot)
    .map((file) => ({
      file,
      rel: normalizeAuditPath(relative(cssRoot, file)),
    }))
    .sort((left, right) => left.rel.localeCompare(right.rel));
  const perFile = [];
  const selectorOwners = new Map();
  const divergentDeclarations = new Map();
  const patchLayerFiles = [];
  const legacyGlobalFiles = [];
  let totalLines = 0;

  for (const { file, rel } of files) {
    const source = readFileSync(file, "utf8");
    const root = postcss.parse(source, { from: file });
    const isTokens = file === tokensFile;
    const isCssModule = rel.endsWith(".module.css");
    const counts = Object.fromEntries(DEBT_METRICS.map((metric) => [metric, 0]));
    const lines = source.split("\n").length;
    totalLines += lines;

    if (isPatchLayerFile(rel)) patchLayerFiles.push(rel);
    if (!isCssModule && !APPROVED_GLOBAL_STYLES.has(rel)) legacyGlobalFiles.push(rel);

    if (!isTokens) {
      root.walkDecls((decl) => {
        if (containsRawColor(decl.value)) counts.rawColor += 1;
        if (decl.prop === "font-size" && containsRawLength(decl.value)) counts.fontSizeLiteral += 1;
        if (RADIUS_PROPERTY_RE.test(decl.prop) && containsRawLength(decl.value)) counts.radiusLiteral += 1;
        if (SPACING_PROPERTY_RE.test(decl.prop) && containsRawSpacing(decl.value)) counts.spacingLiteral += 1;
        if (MOTION_PROPERTY_RE.test(decl.prop) && containsRawTime(decl.value)) counts.motionLiteral += 1;
        if (SHADOW_PROPERTY_RE.test(decl.prop) && containsRawShadow(decl.value)) counts.shadowLiteral += 1;
        if (decl.important) counts.important += 1;
      });

      root.walkRules((rule) => {
        if (rule.selector.includes('data-resolved-theme="dark"')) counts.darkScoped += 1;
      });
      root.walkAtRules("media", (rule) => {
        if (/prefers-color-scheme\s*:\s*dark/i.test(rule.params)) counts.darkScoped += 1;
      });
    }

    if (!isTokens && !isCssModule) {
      root.walkRules((rule) => {
        if (insideKeyframes(rule)) return;
        for (const selector of splitSelectorList(rule.selector)) {
          const normalized = normalizeSelector(selector);
          if (!normalized) continue;
          if (!selectorOwners.has(normalized)) selectorOwners.set(normalized, new Set());
          selectorOwners.get(normalized).add(rel);
        }
      });
    }

    root.walkRules((rule) => {
      if (insideKeyframes(rule)) return;
      const context = atRuleContext(rule);
      for (const selector of splitSelectorList(rule.selector)) {
        const normalizedSelector = normalizeSelector(selector);
        if (!normalizedSelector) continue;
        for (const decl of rule.nodes?.filter((node) => node.type === "decl") ?? []) {
          if (!isVisualProperty(decl.prop)) continue;
          const key = `${context}\u0000${normalizedSelector}\u0000${decl.prop}`;
          if (!divergentDeclarations.has(key)) divergentDeclarations.set(key, []);
          divergentDeclarations.get(key).push({
            file: rel,
            value: normalizeValue(decl.value),
          });
        }
      }
    });

    perFile.push({ rel, lines, ...counts });
  }

  const duplicateSelectors = Object.fromEntries(
    [...selectorOwners.entries()]
      .filter(([, owners]) => owners.size > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([selector, owners]) => [selector, [...owners].sort()]),
  );
  const totals = {
    files: files.length,
    lines: totalLines,
    ...Object.fromEntries(DEBT_METRICS.map((metric) => [metric, perFile.reduce((sum, file) => sum + file[metric], 0)])),
    duplicateSelectors: Object.keys(duplicateSelectors).length,
    patchLayerFiles: patchLayerFiles.length,
    legacyGlobalFiles: legacyGlobalFiles.length,
  };

  return {
    totals,
    perFile,
    duplicateSelectors,
    patchLayerFiles: patchLayerFiles.sort(),
    legacyGlobalFiles: legacyGlobalFiles.sort(),
    divergentDeclarations: formatDivergentDeclarations(divergentDeclarations),
  };
}

export function baselineFromReport(report) {
  const files = {};
  for (const file of report.perFile) {
    const debt = Object.fromEntries(
      DEBT_METRICS.filter((metric) => file[metric] > 0).map((metric) => [metric, file[metric]]),
    );
    if (Object.keys(debt).length) files[file.rel] = debt;
  }
  return {
    version: BASELINE_VERSION,
    policy: "per-file-ratchet",
    files,
    duplicateSelectors: report.duplicateSelectors,
    patchLayerFiles: report.patchLayerFiles,
    legacyGlobalFiles: report.legacyGlobalFiles,
  };
}

export function compareReportToBaseline(report, baseline) {
  if (baseline?.version !== BASELINE_VERSION || baseline?.policy !== "per-file-ratchet") {
    return {
      regressions: [`baseline schema must be version ${BASELINE_VERSION} with policy per-file-ratchet`],
      improvements: [],
    };
  }

  const regressions = [];
  const improvements = [];
  const currentFiles = new Map(report.perFile.map((file) => [file.rel, file]));
  const allFiles = new Set([...Object.keys(baseline.files ?? {}), ...currentFiles.keys()]);

  for (const rel of [...allFiles].sort()) {
    const current = currentFiles.get(rel);
    const allowance = baseline.files?.[rel] ?? {};
    for (const metric of DEBT_METRICS) {
      const before = allowance[metric] ?? 0;
      const after = current?.[metric] ?? 0;
      if (after > before) {
        regressions.push(`${rel}: ${metric} ${before} -> ${after} (+${after - before})`);
      } else if (after < before) {
        improvements.push(`${rel}: ${metric} ${before} -> ${after} (-${before - after})`);
      }
    }
  }

  compareOwnedSets({
    label: "duplicate selector",
    current: report.duplicateSelectors,
    baseline: baseline.duplicateSelectors ?? {},
    regressions,
    improvements,
  });
  compareFlatSet({
    label: "patch-layer file",
    current: report.patchLayerFiles,
    baseline: baseline.patchLayerFiles ?? [],
    regressions,
    improvements,
  });
  compareFlatSet({
    label: "legacy global stylesheet",
    current: report.legacyGlobalFiles,
    baseline: baseline.legacyGlobalFiles ?? [],
    regressions,
    improvements,
  });

  return { regressions, improvements };
}

function listCssFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

function isPatchLayerFile(rel) {
  return PATCH_LAYER_MARKERS.some((marker) => rel.includes(marker));
}

function containsRawColor(value) {
  return RAW_COLOR_RE.test(value);
}

function containsRawLength(value) {
  RAW_LENGTH_RE.lastIndex = 0;
  return RAW_LENGTH_RE.test(value);
}

function containsRawSpacing(value) {
  RAW_LENGTH_RE.lastIndex = 0;
  for (const match of value.matchAll(RAW_LENGTH_RE)) {
    const numeric = Math.abs(Number.parseFloat(match[0]));
    const unit = match.groups?.unit?.toLowerCase();
    if (numeric === 0) continue;
    if (numeric === 1 && unit === "px") continue;
    return true;
  }
  return false;
}

function normalizeAuditPath(path) {
  return path.replaceAll("\\", "/");
}

function containsRawTime(value) {
  RAW_TIME_RE.lastIndex = 0;
  for (const match of value.matchAll(RAW_TIME_RE)) {
    if (Math.abs(Number.parseFloat(match[0])) > 0) return true;
  }
  return false;
}

function containsRawShadow(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") return false;
  return containsRawLength(value) || containsRawColor(value);
}

function splitSelectorList(selectorText) {
  const selectors = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const char of selectorText) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      selectors.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) selectors.push(current);
  return selectors;
}

function normalizeSelector(selector) {
  return selector.trim().replace(/\s+/g, " ");
}

function normalizeValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

function insideKeyframes(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return true;
    parent = parent.parent;
  }
  return false;
}

function atRuleContext(node) {
  const context = [];
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule") context.unshift(`@${parent.name} ${parent.params}`.trim());
    parent = parent.parent;
  }
  return context.join(" > ");
}

function isVisualProperty(prop) {
  return /^(?:background|background-color|color|border|border-color|box-shadow|border-radius|font-size|font-weight)$/.test(
    prop,
  );
}

function formatDivergentDeclarations(entries) {
  const result = [];
  for (const [key, declarations] of entries) {
    const values = [...new Set(declarations.map((entry) => entry.value))];
    if (declarations.length < 2 || values.length < 2) continue;
    const [context, selector, property] = key.split("\u0000");
    result.push({
      context,
      selector,
      property,
      values,
      files: [...new Set(declarations.map((entry) => entry.file))].sort(),
    });
  }
  return result.sort(
    (left, right) =>
      right.values.length - left.values.length ||
      left.selector.localeCompare(right.selector) ||
      left.property.localeCompare(right.property),
  );
}

function compareOwnedSets({ label, current, baseline, regressions, improvements }) {
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const key of [...keys].sort()) {
    const currentOwners = new Set(current[key] ?? []);
    const baselineOwners = new Set(baseline[key] ?? []);
    const added = [...currentOwners].filter((owner) => !baselineOwners.has(owner));
    const removed = [...baselineOwners].filter((owner) => !currentOwners.has(owner));
    if (added.length) regressions.push(`${label} ${JSON.stringify(key)} added owners: ${added.join(", ")}`);
    if (removed.length) improvements.push(`${label} ${JSON.stringify(key)} removed owners: ${removed.join(", ")}`);
  }
}

function compareFlatSet({ label, current, baseline, regressions, improvements }) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  for (const value of currentSet) {
    if (!baselineSet.has(value)) regressions.push(`${label} added: ${value}`);
  }
  for (const value of baselineSet) {
    if (!currentSet.has(value)) improvements.push(`${label} removed: ${value}`);
  }
}
