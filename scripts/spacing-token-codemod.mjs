#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import { loadDesign } from "./design-tokens.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const allowedRoots = [resolve(projectRoot, "web", "src")];
const tokensPath = resolve(projectRoot, "web", "src", "styles", "tokens.css");
const SPACING_PROPERTY_RE = /^(?:padding|margin|gap|row-gap|column-gap|inset)(?:-|$)/;
const RAW_LENGTH_RE =
  /-?(?:\d*\.)?\d+(?:px|rem|rlh|cap|ch|ex|ic|lh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|lvw|lvh|lvi|lvb|dvw|dvh|dvi|dvb|cqw|cqh|cqi|cqb|cqmin|cqmax|em|pt|pc|in|cm|mm|q|%)(?![a-z%])/gi;
const POSITIVE_PX_RE = /(?<![\w.-])(?:\d*\.)?\d+px(?![\w-])/gi;

export const SPACING_TOKEN_BY_PX = spacingTokenMap(loadDesign().spacing ?? {});

export function spacingTokenMap(spacing) {
  const map = new Map();
  for (const [key, rawValue] of Object.entries(spacing)) {
    const match = String(rawValue)
      .trim()
      .match(/^(\d+(?:\.\d+)?)px$/i);
    if (!match) continue;
    const numeric = Number.parseFloat(match[1]);
    if (numeric === 0 || numeric === 1) continue;
    map.set(numeric, `var(--sp-${key})`);
  }
  return map;
}

export function rewriteSpacingValue(value, tokenByPx = SPACING_TOKEN_BY_PX) {
  const valueWithoutComments = value.replace(/\/\*[\s\S]*?\*\//g, " ");
  RAW_LENGTH_RE.lastIndex = 0;
  if (!RAW_LENGTH_RE.test(valueWithoutComments)) {
    return { changed: false, value, replacements: 0, reason: "no-raw-length" };
  }
  if (!containsNonExemptRawLength(valueWithoutComments)) {
    return { changed: false, value, replacements: 0, reason: "only-exempt-lengths" };
  }

  const normalized = valueWithoutComments.trim();
  if (/[()]/.test(normalized)) {
    return { changed: false, value, replacements: 0, reason: "function-or-variable" };
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) {
    return { changed: false, value, replacements: 0, reason: "complex-value" };
  }

  let replacements = 0;
  for (const part of parts) {
    if (/^0(?:\.0+)?(?:px)?$/i.test(part) || /^1(?:\.0+)?px$/i.test(part)) continue;
    if (/^-(?:\d*\.)?\d+[a-z%]+$/i.test(part)) {
      return { changed: false, value, replacements: 0, reason: "negative-length" };
    }
    const px = part.match(/^(\d+(?:\.\d+)?)px$/i);
    if (px) {
      const numeric = Number.parseFloat(px[1]);
      if (!tokenByPx.has(numeric)) {
        return { changed: false, value, replacements: 0, reason: "unmapped-px" };
      }
      replacements += 1;
      continue;
    }
    if (/^(?:\d*\.)?\d+[a-z%]+$/i.test(part)) {
      return { changed: false, value, replacements: 0, reason: "non-px-length" };
    }
    return { changed: false, value, replacements: 0, reason: "mixed-or-keyword-value" };
  }

  if (!replacements) {
    return { changed: false, value, replacements: 0, reason: "only-exempt-lengths" };
  }

  const nextValue = value
    .split(/(\/\*[\s\S]*?\*\/)/g)
    .map((segment) =>
      segment.startsWith("/*")
        ? segment
        : segment.replace(POSITIVE_PX_RE, (raw) => {
            const token = tokenByPx.get(Number.parseFloat(raw));
            return token ?? raw;
          }),
    )
    .join("");
  return {
    changed: nextValue !== value,
    value: nextValue,
    replacements,
    reason: nextValue !== value ? "safe-exact-match" : "no-change",
  };
}

function containsNonExemptRawLength(value) {
  RAW_LENGTH_RE.lastIndex = 0;
  for (const match of value.matchAll(RAW_LENGTH_RE)) {
    const numeric = Math.abs(Number.parseFloat(match[0]));
    const unit = match[0].match(/[a-z%]+$/i)?.[0]?.toLowerCase();
    if (numeric === 0) continue;
    if (numeric === 1 && unit === "px") continue;
    return true;
  }
  return false;
}

export function rewriteSpacingCss(source, options = {}) {
  const root = postcss.parse(source, { from: options.from ?? "<spacing-codemod>" });
  const skipped = {};
  let declarationsChanged = 0;
  let valuesChanged = 0;

  root.walkDecls((decl) => {
    if (!SPACING_PROPERTY_RE.test(decl.prop)) return;
    const rawValue = decl.raws.value?.raw ?? decl.value;
    const result = rewriteSpacingValue(rawValue, options.tokenByPx ?? SPACING_TOKEN_BY_PX);
    if (!result.changed) {
      if (result.reason !== "no-raw-length" && result.reason !== "only-exempt-lengths") {
        skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
      }
      return;
    }
    const normalizedResult = rewriteSpacingValue(decl.value, options.tokenByPx ?? SPACING_TOKEN_BY_PX);
    decl.value = normalizedResult.value;
    if (decl.raws.value?.raw) {
      decl.raws.value = {
        raw: result.value,
        value: normalizedResult.value,
      };
    }
    declarationsChanged += 1;
    valuesChanged += result.replacements;
  });

  return {
    css: root.toString(),
    declarationsChanged,
    valuesChanged,
    skipped,
  };
}

export function runSpacingCodemod(options = {}) {
  if (options.apply && !options.paths?.length) {
    throw new Error("spacing codemod --apply requires one or more explicit CSS files or directories");
  }
  const files = resolveInputFiles(options.paths ?? []);
  const results = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const result = rewriteSpacingCss(source, { from: file });
    if (options.apply && result.css !== source) {
      writeFileSync(file, result.css, "utf8");
    }
    results.push({
      rel: relative(projectRoot, file).replaceAll("\\", "/"),
      declarationsChanged: result.declarationsChanged,
      valuesChanged: result.valuesChanged,
      skipped: result.skipped,
    });
  }
  return {
    apply: options.apply === true,
    filesScanned: results.length,
    filesChanged: results.filter((result) => result.declarationsChanged > 0).length,
    declarationsChanged: results.reduce((sum, result) => sum + result.declarationsChanged, 0),
    valuesChanged: results.reduce((sum, result) => sum + result.valuesChanged, 0),
    files: results.filter((result) => result.declarationsChanged > 0),
    skipped: mergeSkipped(results.map((result) => result.skipped)),
  };
}

function resolveInputFiles(inputs) {
  const requested = inputs.length ? inputs : allowedRoots;
  const files = [];
  for (const input of requested) {
    const absolute = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
    if (!existsSync(absolute)) throw new Error(`spacing codemod input does not exist: ${input}`);
    const real = realpathSync(absolute);
    if (!allowedRoots.some((root) => isWithin(root, real))) {
      throw new Error(`spacing codemod input must stay within web/src: ${input}`);
    }
    if (statSync(real).isDirectory()) {
      files.push(...listCssFiles(real));
    } else if (real === tokensPath) {
      throw new Error(
        "spacing codemod does not edit generated web/src/styles/tokens.css; change web/src/styles/design.md instead",
      );
    } else if (real.endsWith(".css")) {
      files.push(real);
    } else {
      throw new Error(`spacing codemod input must be a CSS file or directory: ${input}`);
    }
  }
  return [...new Set(files.filter((file) => file !== tokensPath))].sort();
}

function listCssFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".css") && full !== tokensPath) files.push(full);
  }
  return files;
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mergeSkipped(groups) {
  const merged = {};
  for (const group of groups) {
    for (const [reason, count] of Object.entries(group)) {
      merged[reason] = (merged[reason] ?? 0) + count;
    }
  }
  return merged;
}

function printReport(report) {
  console.log(`Spacing token codemod (${report.apply ? "apply" : "dry run"})`);
  console.log(`Files scanned: ${report.filesScanned}`);
  console.log(`Files ${report.apply ? "changed" : "with safe changes"}: ${report.filesChanged}`);
  console.log(`Declarations ${report.apply ? "changed" : "planned"}: ${report.declarationsChanged}`);
  console.log(`Length values ${report.apply ? "changed" : "planned"}: ${report.valuesChanged}`);
  for (const file of report.files) {
    console.log(`  ${file.rel}: ${file.declarationsChanged} declarations, ${file.valuesChanged} values`);
  }
  const skipped = Object.entries(report.skipped).sort(([left], [right]) => left.localeCompare(right));
  if (skipped.length) {
    console.log("Skipped candidate declarations:");
    for (const [reason, count] of skipped) console.log(`  ${reason}: ${count}`);
  }
  if (!report.apply && report.declarationsChanged > 0) {
    console.log("Dry run only. Re-run with --apply after reviewing the plan.");
  }
}

function parseCliArgs(argv) {
  const options = { apply: false, json: false, paths: [] };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) throw new Error(`unknown spacing codemod option: ${arg}`);
    else options.paths.push(arg);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = runSpacingCodemod(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
