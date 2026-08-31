#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGeneratedTokenBlock, GENERATED_END, GENERATED_START, loadDesign } from "./design-tokens.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const tokensPath = join(projectRoot, "web", "src", "styles", "tokens.css");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const apply = args.has("--apply");
const check = args.has("--check");

const AMBIGUOUS_COLOR_VALUES = new Set(["#ffffff", "#168a53", "#6fbf73"]);
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_COLOR_RE = /\brgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/g;
const NAMED_MONO_COLOR_RE = /(?<![-\w])(?:black|white)(?![-\w])/gi;
const SHAPE_RADIUS_PROPS = new Set(["--grove-seed-radius", "--grove-leaf-a-radius", "--grove-leaf-b-radius"]);

const FONT_SIZE_SNAPS = new Map([
  ["9px", "var(--fs-2xs)"],
  ["10.5px", "var(--fs-2xs)"],
  ["11.5px", "var(--fs-xs)"],
  ["12.5px", "var(--fs-base)"],
  ["13.5px", "var(--fs-md)"],
  ["15px", "var(--fs-lg)"],
  ["15.5px", "var(--fs-lg)"],
  ["17px", "var(--fs-lg)"],
  ["18px", "var(--fs-xl)"],
  ["21px", "var(--fs-xl)"],
  ["22px", "var(--fs-2xl)"],
  ["23px", "var(--fs-2xl)"],
  ["26px", "var(--fs-2xl)"],
  ["30px", "var(--fs-3xl)"],
  ["34px", "var(--fs-3xl)"],
  ["0.88em", "var(--fs-base)"],
  ["0.9em", "var(--fs-md)"],
  ["0.92em", "var(--fs-md)"],
  ["1.14em", "var(--fs-lg)"],
  ["1.38em", "var(--fs-xl)"],
  ["1.72em", "var(--fs-3xl)"],
]);

const RADIUS_SNAPS = new Map([
  ["5px", "var(--r-xs)"],
  ["6px", "var(--r-xs)"],
  ["7px", "var(--r-sm)"],
  ["8px", "var(--r-sm)"],
  ["9px", "var(--r-md)"],
  ["10px", "var(--r-md)"],
  ["12px", "var(--r-lg)"],
  ["14px", "var(--r-lg)"],
  ["15px", "var(--r-lg)"],
  ["16px", "var(--r-lg)"],
  ["22px", "var(--r-xl)"],
  ["24px", "var(--r-2xl)"],
  ["28px", "var(--r-2xl)"],
]);

function generatedRanges(css) {
  const start = css.indexOf(GENERATED_START);
  if (start < 0) return [];
  const end = css.indexOf(GENERATED_END, start);
  if (end < 0) throw new Error("Generated token block start exists without an end marker");
  return [{ start, end: end + GENERATED_END.length }];
}

function inRanges(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function componentThemeForIndex(css, index, ranges) {
  const generatedEnd = ranges[0]?.end ?? 0;
  const darkIndex = css.indexOf(':root[data-resolved-theme="dark"]', generatedEnd);
  const systemIndex = css.indexOf("@media (prefers-color-scheme: dark)", generatedEnd);
  if (systemIndex >= 0 && index >= systemIndex) return "dark";
  if (darkIndex >= 0 && index >= darkIndex) return "dark";
  return "light";
}

function normalizeValue(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .replace(/0+\)/g, "0)")
    .replace(/;$/, "");
}

function parseDeclarations(css, ranges = []) {
  const declarations = [];
  const regex = /(^|\n)([ \t]*)(--[\w-]+)\s*:\s*([\s\S]*?);/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    const start = match.index + match[1].length;
    if (inRanges(start, ranges)) continue;
    const end = regex.lastIndex;
    declarations.push({
      start,
      end,
      indent: match[2],
      prop: match[3],
      value: match[4].trim(),
      raw: css.slice(start, end),
      theme: componentThemeForIndex(css, start, ranges),
    });
  }
  return declarations;
}

function parseGeneratedDeclarations(generatedCss) {
  const declarations = parseDeclarations(generatedCss, []);
  const map = new Map();
  for (const decl of declarations) {
    if (!decl.prop.startsWith("--")) continue;
    map.set(decl.prop, decl.value);
  }
  return map;
}

function resolveWholeVar(value, propMap, seen = new Set()) {
  const normalized = value.trim();
  const match = normalized.match(/^var\((--[\w-]+)\)$/);
  if (!match) return normalized;
  const prop = match[1];
  if (seen.has(prop) || !propMap.has(prop)) return normalized;
  seen.add(prop);
  return resolveWholeVar(propMap.get(prop), propMap, seen);
}

function isColorProp(prop) {
  return /(?:^--.*(?:bg|fg|color|border|line|shadow|surface|text|muted|faint|accent|success|warning|error|link|violet|blue|green|icon|ring|scrim|overlay|brand|leaf|stem|root)|-fill$)/.test(
    prop,
  );
}

function semanticRank(prop) {
  if (
    /^--c-(accent|accent-hover|accent-soft|focus-ring|success|warning|error|link|link-strong|violet|success-soft|error-soft|warning-soft)$/.test(
      prop,
    )
  )
    return 0;
  if (/^--c-(neutral-\d+|line-\d+|overlay-scrim)$/.test(prop)) return 1;
  if (
    /^--c-(bg|surface|surface-hover|surface-active|surface-raised|surface-sunken|popover|popover-solid|text|text-2|text-3|muted|faint|border|border-strong)$/.test(
      prop,
    )
  )
    return 2;
  if (/^--c-(brand-green|interaction-blue|text-strong)$/.test(prop)) return 3;
  if (/^--og-/.test(prop)) return 4;
  return 5;
}

function chooseCanonicalProp(props, normalizedValue) {
  if (AMBIGUOUS_COLOR_VALUES.has(normalizedValue)) return null;
  const ranked = props
    .filter((prop) => prop.startsWith("--c-") || prop.startsWith("--og-sapling"))
    .map((prop) => ({ prop, rank: semanticRank(prop) }))
    .sort((a, b) => a.rank - b.rank || a.prop.localeCompare(b.prop));
  if (!ranked.length) return null;
  const bestRank = ranked[0].rank;
  const best = ranked.filter((item) => item.rank === bestRank);
  return best.length === 1 ? best[0].prop : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value) {
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a = "f"] = hex.split("").map((ch) => Number.parseInt(`${ch}${ch}`, 16));
    return { r, g, b, a: a / 255 };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a: alpha };
  }
  return null;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function channelSpread({ r, g, b }) {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function isVisuallyNeutral(color, hsl) {
  return hsl.s < 0.28 || channelSpread(color) < 0.12;
}

function alphaText(alpha) {
  return String(Number.parseFloat(alpha.toFixed(3))).replace(/^0\./, "0.");
}

function varRef(token) {
  return `var(${token})`;
}

function alphaFrom(token, alpha) {
  if (alpha >= 0.995) return varRef(token);
  if (alpha <= 0.005) return "transparent";
  return `oklch(from ${varRef(token)} l c h / ${alphaText(alpha)})`;
}

function isOpaqueWhite(color) {
  return color.a >= 0.995 && color.r >= 250 && color.g >= 250 && color.b >= 250;
}

function isOpaqueBlack(color) {
  return color.a >= 0.995 && color.r <= 5 && color.g <= 5 && color.b <= 5;
}

function mixWith(baseToken, percent, surfaceToken = "--c-surface") {
  return `color-mix(in srgb, ${varRef(baseToken)} ${alphaText(percent)}%, ${varRef(surfaceToken)})`;
}

function propHas(prop, words) {
  return words.some((word) => prop.includes(word));
}

function isBackgroundProp(prop) {
  return propHas(prop, [
    "-bg",
    "soft",
    "surface",
    "panel",
    "shell",
    "popover",
    "menu",
    "card",
    "chip",
    "badge",
    "bubble",
    "row",
    "option",
    "target",
    "source",
    "attachment",
    "preview",
    "well",
    "track",
    "page",
  ]);
}

function isForegroundProp(prop) {
  return propHas(prop, [
    "-fg",
    "text",
    "title",
    "copy",
    "label",
    "icon",
    "meta",
    "placeholder",
    "author",
    "heading",
    "value",
    "kicker",
    "strong",
  ]);
}

function isBorderProp(prop) {
  return propHas(prop, ["border", "line", "outline", "ring", "focus", "shadow"]);
}

function intentTokenFromProp(prop) {
  if (propHas(prop, ["danger", "delete", "remove", "error", "failed", "rejected", "recording"])) return "--c-error";
  if (propHas(prop, ["success", "done", "good", "online", "published", "delivery", "green", "accepted"]))
    return "--c-success";
  if (propHas(prop, ["warning", "waiting", "blocked", "pin", "note", "native", "orange"])) return "--c-warning";
  if (propHas(prop, ["skill", "violet", "purple", "artifact"])) return "--c-violet";
  if (propHas(prop, ["link", "blue", "drop", "running", "live", "transcribing", "primary", "accent"])) {
    return prop.includes("link") || prop.includes("rooms-blue") || prop.includes("kernel") ? "--c-link" : "--c-accent";
  }
  return null;
}

function statusTokenFromProp(prop, hsl) {
  const tokenFromName = intentTokenFromProp(prop);
  if (tokenFromName) return tokenFromName;
  if (hsl.s < 0.36) return null;
  if (hsl.h < 22 || hsl.h >= 340) return "--c-error";
  if (hsl.h < 82) return "--c-warning";
  if (hsl.h < 170) return "--c-success";
  if (hsl.h < 255) return "--c-link";
  if (hsl.h < 330) return "--c-violet";
  return "--c-error";
}

function neutralTokenForOpaque(prop, color, theme) {
  const y = luminance(color);
  if (isForegroundProp(prop)) {
    if (propHas(prop, ["faint", "placeholder", "chevron", "meta", "description", "soft"])) return "--c-faint";
    if (propHas(prop, ["muted", "secondary", "status", "helper", "count", "runtime", "effort"])) return "--c-muted";
    if (propHas(prop, ["strong", "title", "heading", "question", "active", "value"])) return "--c-text";
    return y < 0.24 || y > 0.78 ? "--c-text" : "--c-text-2";
  }
  if (isBorderProp(prop)) {
    return propHas(prop, ["strong", "focus", "active", "selected"]) ? "--c-border-strong" : "--c-border";
  }
  if (isBackgroundProp(prop)) {
    if (prop.includes("dark") || theme === "dark") {
      if (propHas(prop, ["hover", "active", "selected"])) return "--c-surface-hover";
      if (propHas(prop, ["muted", "sunken", "code"])) return "--c-surface-sunken";
      if (propHas(prop, ["raised", "popover", "menu", "dialog", "tooltip"])) return "--c-surface-raised";
      return "--c-surface";
    }
    if (y > 0.98) return "--c-surface";
    if (y > 0.92) return "--c-bg";
    if (y > 0.82) return "--c-surface-hover";
    if (y > 0.68) return "--c-surface-active";
    if (y < 0.04) return "--c-overlay-ink";
    if (y < 0.14) return "--c-text";
    return "--c-neutral-300";
  }
  if (y < 0.08) return "--c-overlay-ink";
  if (y > 0.94) return "--c-surface";
  return y < 0.45 ? "--c-text-2" : "--c-muted";
}

function semanticColorExpression(color, prop, theme) {
  if (isOpaqueBlack(color)) return varRef("--c-overlay-ink");
  if (isOpaqueWhite(color)) return varRef(isForegroundProp(prop) ? "--c-overlay-highlight" : "--c-surface");

  const hsl = rgbToHsl(color);
  const y = luminance(color);
  const isNeutral = isVisuallyNeutral(color, hsl);
  const intentToken = intentTokenFromProp(prop);
  if (color.a < 0.995) {
    if (color.a <= 0.005) return "transparent";
    if (
      prop.includes("shadow") &&
      !propHas(prop, [
        "focus",
        "active",
        "selected",
        "warning",
        "error",
        "danger",
        "success",
        "target",
        "hover",
        "drop",
      ])
    ) {
      return alphaFrom("--c-overlay-ink", color.a);
    }
    if (isNeutral) {
      return alphaFrom(intentToken ?? (y > 0.55 ? "--c-overlay-highlight" : "--c-overlay-ink"), color.a);
    }
    return alphaFrom(intentToken ?? statusTokenFromProp(prop, hsl) ?? "--c-accent", color.a);
  }

  if (isNeutral && !intentToken) return varRef(neutralTokenForOpaque(prop, color, theme));

  const baseToken = intentToken ?? statusTokenFromProp(prop, hsl) ?? "--c-accent";
  if (isForegroundProp(prop)) return varRef(baseToken);
  if (isBorderProp(prop))
    return mixWith(baseToken, propHas(prop, ["focus", "active", "selected"]) ? 42 : 32, "--c-border");
  if (isBackgroundProp(prop)) {
    if (
      hsl.l > 0.72 ||
      propHas(prop, ["soft", "faint", "subtle", "hover", "status", "badge", "chip", "warning", "note"])
    ) {
      const percent = hsl.l > 0.78 ? 10 : 16;
      return mixWith(baseToken, percent, "--c-surface");
    }
    if (hsl.l < 0.38 || propHas(prop, ["primary", "send", "active"])) return varRef(baseToken);
    return mixWith(baseToken, 12, "--c-surface");
  }
  return varRef(baseToken);
}

function semanticizeColors(value, decl) {
  let next = value.replace(RGB_COLOR_RE, (match, r, g, b, alpha) => {
    const color = {
      r: clamp(Number.parseFloat(r), 0, 255),
      g: clamp(Number.parseFloat(g), 0, 255),
      b: clamp(Number.parseFloat(b), 0, 255),
      a: alpha === undefined ? 1 : clamp(Number.parseFloat(alpha), 0, 1),
    };
    return semanticColorExpression(color, decl.prop, decl.theme);
  });
  next = next.replace(HEX_COLOR_RE, (match) => {
    const color = parseHexColor(match);
    return color ? semanticColorExpression(color, decl.prop, decl.theme) : match;
  });
  next = next.replace(NAMED_MONO_COLOR_RE, (match) => {
    return match.toLowerCase() === "white" ? varRef("--c-surface") : varRef("--c-overlay-ink");
  });
  return next;
}

function semanticizeFontSize(value, prop) {
  if (!prop.includes("font-size")) return value;
  const normalized = normalizeValue(value);
  if (FONT_SIZE_SNAPS.has(normalized)) return FONT_SIZE_SNAPS.get(normalized);
  if (/^var\(--fs-[^)]+\)$/.test(normalized)) return value;
  return value;
}

function isRadiusTokenProp(prop) {
  return prop.includes("radius") || /^--r-[\w-]+$/.test(prop);
}

function semanticizeRadius(value, prop) {
  if (!isRadiusTokenProp(prop) || SHAPE_RADIUS_PROPS.has(prop)) return value;
  return value.replace(/\b(?:5|6|7|8|9|10|12|14|15|16|22|24|28)px\b/g, (match) => RADIUS_SNAPS.get(match) ?? match);
}

function semanticizeDeclarationValue(decl) {
  let next = decl.value;
  const hasColorLiteral =
    /#[0-9a-fA-F]{3,8}\b/.test(next) ||
    /\brgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+/.test(next) ||
    /(?<![-\w])(?:black|white)(?![-\w])/i.test(next);
  if (isColorProp(decl.prop) || hasColorLiteral) {
    HEX_COLOR_RE.lastIndex = 0;
    RGB_COLOR_RE.lastIndex = 0;
    NAMED_MONO_COLOR_RE.lastIndex = 0;
    next = semanticizeColors(next, decl);
  }
  next = semanticizeFontSize(next, decl.prop);
  next = semanticizeRadius(next, decl.prop);
  return next;
}

function isFontSizeOnScale(item) {
  return /^var\(--fs-[^)]+\)$/.test(item.value.trim());
}

function isRadiusOnScale(item) {
  if (SHAPE_RADIUS_PROPS.has(item.prop)) return true;
  return /^(?:0|var\(--r-[^)]+\))(?:\s+(?:0|var\(--r-[^)]+\)))*$/.test(item.value.trim());
}

function buildReplacementMaps() {
  const generated = buildGeneratedTokenBlock(loadDesign());
  const generatedDecls = parseGeneratedDeclarations(generated);
  const colorValues = new Map();
  const fontValues = new Map();
  const radiusValues = new Map();

  for (const [prop, rawValue] of generatedDecls) {
    const resolved = normalizeValue(resolveWholeVar(rawValue, generatedDecls));
    if (/^#[0-9a-f]{3,8}$/.test(resolved) || /^rgba?\(\d/.test(resolved)) {
      if (!colorValues.has(resolved)) colorValues.set(resolved, new Set());
      colorValues.get(resolved).add(prop);
    }
    if (/^--fs-/.test(prop)) fontValues.set(normalizeValue(rawValue), prop);
    if (/^--r-/.test(prop)) radiusValues.set(normalizeValue(rawValue), prop);
  }

  const colors = new Map();
  for (const [value, props] of colorValues) {
    const prop = chooseCanonicalProp([...props], value);
    if (prop) colors.set(value, `var(${prop})`);
  }

  const fontSizes = new Map();
  for (const [value, prop] of fontValues) fontSizes.set(value, `var(${prop})`);

  const radii = new Map();
  for (const [value, prop] of radiusValues) radii.set(value, `var(${prop})`);

  return { colors, fontSizes, radii };
}

function classifyDeclaration(decl, maps) {
  const value = normalizeValue(decl.value);
  const semanticized = semanticizeDeclarationValue(decl);
  if (normalizeValue(semanticized) !== value) {
    return { kind: "safe", replacement: semanticized, reason: "semantic-token-expression" };
  }
  if (isColorProp(decl.prop) && maps.colors.has(value)) {
    return { kind: "safe", replacement: maps.colors.get(value), reason: "color-exact" };
  }
  if (decl.prop.includes("font-size") && maps.fontSizes.has(value)) {
    return { kind: "safe", replacement: maps.fontSizes.get(value), reason: "font-size-scale" };
  }
  if (isRadiusTokenProp(decl.prop) && maps.radii.has(value)) {
    return { kind: "safe", replacement: maps.radii.get(value), reason: "radius-scale" };
  }
  if (
    /gradient\(|color-mix\(|\binset\b|,\s*\d/.test(decl.value) ||
    (decl.value.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g) ?? []).length > 1
  ) {
    return { kind: "special", reason: "composite-value" };
  }
  return { kind: "manual", reason: "no-unique-token-match" };
}

function buildReport(css) {
  const ranges = generatedRanges(css);
  const declarations = parseDeclarations(css, ranges);
  const maps = buildReplacementMaps();
  const hexMatches = [];
  const rgbaMatches = [];
  const fontSizeTokens = [];
  const radiusTokens = [];
  const safeReplacements = [];
  const special = [];
  const manual = [];

  for (const decl of declarations) {
    const hex = decl.value.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    const rgba = (decl.value.match(/\brgba?\([^)]*\)/g) ?? []).filter((value) => /\brgba?\(\s*\d/.test(value));
    hexMatches.push(...hex.map((value) => ({ prop: decl.prop, value })));
    rgbaMatches.push(...rgba.map((value) => ({ prop: decl.prop, value })));

    if (decl.prop.includes("font-size")) {
      const item = { prop: decl.prop, value: decl.value };
      fontSizeTokens.push({ ...item, onScale: isFontSizeOnScale(item) });
    }
    if (isRadiusTokenProp(decl.prop)) {
      const item = { prop: decl.prop, value: decl.value };
      radiusTokens.push({ ...item, onScale: isRadiusOnScale(item) });
    }

    const classification = classifyDeclaration(decl, maps);
    const hasOffScaleFontSize = decl.prop.includes("font-size") && !isFontSizeOnScale(decl);
    const hasOffScaleRadius = isRadiusTokenProp(decl.prop) && !isRadiusOnScale(decl);
    if (classification.kind === "safe") {
      safeReplacements.push({
        prop: decl.prop,
        value: decl.value,
        replacement: classification.replacement,
        reason: classification.reason,
        start: decl.start,
        end: decl.end,
        indent: decl.indent,
      });
    } else if (hex.length || rgba.length || hasOffScaleFontSize || hasOffScaleRadius) {
      const item = { prop: decl.prop, value: decl.value, reason: classification.reason };
      if (classification.kind === "special") special.push(item);
      else manual.push(item);
    }
  }

  return {
    totals: {
      componentTokenDeclarations: declarations.length,
      uniqueComponentTokens: new Set(declarations.map((decl) => decl.prop)).size,
      hardcodedHex: hexMatches.length,
      uniqueHardcodedHex: new Set(hexMatches.map((item) => normalizeValue(item.value))).size,
      literalRgba: rgbaMatches.length,
      uniqueLiteralRgba: new Set(rgbaMatches.map((item) => normalizeValue(item.value))).size,
      fontSizeTokens: fontSizeTokens.length,
      offScaleFontSizeTokens: fontSizeTokens.filter((item) => !item.onScale).length,
      radiusTokens: radiusTokens.length,
      offScaleRadiusTokens: radiusTokens.filter((item) => !item.onScale).length,
      safeReplacementCount: safeReplacements.length,
      specialCount: special.length,
      manualCount: manual.length,
    },
    safeReplacements,
    special,
    manual,
    fontSizeTokens,
    radiusTokens,
  };
}

function applySafeReplacements(css, replacements) {
  let next = css;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    next =
      next.slice(0, replacement.start) +
      `${replacement.indent}${replacement.prop}: ${replacement.replacement};` +
      next.slice(replacement.end);
  }
  return next;
}

function printHuman(report) {
  const { totals } = report;
  console.log("OpenGrove token-internal audit");
  console.log("================================");
  console.log(`Component token declarations : ${totals.componentTokenDeclarations}`);
  console.log(`Unique component tokens       : ${totals.uniqueComponentTokens}`);
  console.log(`Hardcoded hex                 : ${totals.hardcodedHex} (${totals.uniqueHardcodedHex} unique)`);
  console.log(`Literal rgb/rgba              : ${totals.literalRgba} (${totals.uniqueLiteralRgba} unique)`);
  console.log(`Font-size tokens              : ${totals.fontSizeTokens} (${totals.offScaleFontSizeTokens} off scale)`);
  console.log(`Radius tokens                 : ${totals.radiusTokens} (${totals.offScaleRadiusTokens} off scale)`);
  console.log(`Safe exact replacements       : ${totals.safeReplacementCount}`);
  console.log(`Composite/manual candidates   : ${totals.specialCount + totals.manualCount}`);
  if (report.safeReplacements.length) {
    console.log("");
    console.log("Safe replacements:");
    for (const item of report.safeReplacements.slice(0, 80)) {
      console.log(`  ${item.prop}: ${item.value} -> ${item.replacement} (${item.reason})`);
    }
    if (report.safeReplacements.length > 80) {
      console.log(`  ... ${report.safeReplacements.length - 80} more`);
    }
  }
}

const css = readFileSync(tokensPath, "utf8");
const report = buildReport(css);

if (apply) {
  const next = applySafeReplacements(css, report.safeReplacements);
  if (next !== css) writeFileSync(tokensPath, next, "utf8");
  console.log(
    next === css
      ? "No safe token-internal replacements to apply."
      : `Applied ${report.safeReplacements.length} safe token-internal replacements in ${relative(projectRoot, tokensPath)}.`,
  );
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

if (check && report.totals.safeReplacementCount > 0) {
  console.error("Safe token-internal replacements remain. Run: npm run tokens:codemod");
  process.exit(1);
}

if (
  check &&
  (report.totals.hardcodedHex > 0 ||
    report.totals.literalRgba > 0 ||
    report.totals.offScaleFontSizeTokens > 0 ||
    report.totals.offScaleRadiusTokens > 0)
) {
  console.error("Component token literals remain in tokens.css. Run: npm run tokens:codemod and inspect the report.");
  process.exit(1);
}
