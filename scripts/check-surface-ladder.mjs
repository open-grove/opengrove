#!/usr/bin/env node
/**
 * Surface ladder gate.
 *
 * design.md says a container may drop its hairline only when the tonal step
 * against its neighbour carries the separation on its own. That promise is a
 * number, so it can be checked: every pair of surfaces that actually touch in
 * the product must differ by at least MIN_DELTA_L in OKLab lightness, in every
 * theme.
 *
 * Without this gate a future token edit can silently collapse a borderless
 * surface into its parent. The negative fixture proves that the gate rejects
 * that failure instead of merely reporting the current palette.
 *
 * Usage: node scripts/check-surface-ladder.mjs [--json] [--tokens <path>]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultTokensPath = join(scriptDir, "..", "web", "src", "styles", "tokens.css");

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

const tokensPath = resolvePath(optionValue("--tokens") ?? defaultTokensPath);

/** Below this, two surfaces read as one. Kept in sync with design.md Layering. */
const MIN_DELTA_L = 0.015;

/**
 * Surface pairs that meet on screen. `base` means both sides are composited over
 * it first — that is how a translucent fill is judged against another fill.
 * Adding a container that drops its border means adding its pair here.
 */
const PAIRS = [
  {
    where: "every paper panel on the frame seam (main / sidebar / settings shell)",
    parent: "--c-bg",
    child: "--c-surface",
  },
  // Sidebars and the settings shell are paper too, so they all ride on the pair
  // above. There is deliberately no ".settings-list on the shell" pair:
  // paper on paper has no step left, so that edge is a hairline (see settings.css).
  {
    where: "recessed blocks (App Store rows, thread quotes) on a paper panel",
    parent: "--c-surface",
    child: "--c-surface-sunken",
  },
  { where: ".og-card / .contacts-activity-card on a paper panel", parent: "--c-surface", child: "--c-fill" },
  { where: ".opengrove-composer over the message stream", parent: "--c-bg", child: "--c-fill" },
  { where: ".rooms-search inside the paper sidebar", parent: "--c-surface", child: "--c-fill" },
  { where: "settings toggle track on a settings row", parent: "--c-surface", child: "--c-surface-active" },
  { where: ".app-store-app-card hover step", base: "--c-surface", parent: "--c-fill", child: "--c-fill-strong" },
  { where: "sidebar row hover step", base: "--c-surface", parent: "--og-section-hover", child: "--og-section-active" },
];

// ===== CSS variable maps =====

function blocksFor(css, selector) {
  const blocks = [];
  let index = 0;
  while (true) {
    const start = css.indexOf(`${selector} {`, index);
    if (start === -1) break;
    const open = css.indexOf("{", start);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    blocks.push(css.slice(open + 1, cursor - 1));
    index = cursor;
  }
  return blocks;
}

function declarationsInto(map, block) {
  // Top-level declarations only: nested blocks (media queries, child rules) are
  // skipped so a nested override never leaks into the theme map.
  let depth = 0;
  let buffer = "";
  for (const char of block) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ";" && depth === 0) {
      const match = buffer.match(/(--[\w-]+)\s*:\s*([\s\S]+)/);
      if (match) map.set(match[1], match[2].trim());
      buffer = "";
      continue;
    }
    if (depth === 0) buffer += char;
  }
}

function themeMaps() {
  const css = readFileSync(tokensPath, "utf8");
  const light = new Map();
  for (const block of blocksFor(css, ":root")) declarationsInto(light, block);
  const dark = new Map(light);
  for (const block of blocksFor(css, '[data-resolved-theme="dark"]')) declarationsInto(dark, block);
  return { light, dark };
}

// ===== colour maths (sRGB ↔ OKLab, matching how browsers composite) =====

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function oklchToSrgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  return linear.map((channel) => Math.min(1, Math.max(0, linearToSrgb(channel))));
}

function srgbToOklabL(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  const lms = [
    Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b),
  ];
  return 0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2];
}

/** Source-over on gamma-encoded sRGB — the default CSS compositing space. */
function composite(source, backdrop) {
  if (source.alpha >= 1) return { rgb: source.rgb, alpha: 1 };
  const rgb = source.rgb.map((channel, index) => source.alpha * channel + (1 - source.alpha) * backdrop.rgb[index]);
  return { rgb, alpha: 1 };
}

// ===== value resolution =====

function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let buffer = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

function resolve(value, map, trail = []) {
  const text = value.trim();

  const varMatch = text.match(/^var\(\s*(--[\w-]+)\s*(?:,([\s\S]+))?\)$/);
  if (varMatch) {
    const name = varMatch[1];
    if (trail.includes(name)) throw new Error(`circular token reference: ${trail.join(" → ")} → ${name}`);
    const next = map.get(name) ?? varMatch[2];
    if (next === undefined) throw new Error(`unknown token ${name}`);
    return resolve(next, map, [...trail, name]);
  }

  // oklch(from <colour> l c h / <alpha>) — the repo's translucent-ink pattern.
  const relative = text.match(/^oklch\(\s*from\s+([\s\S]+?)\s+l\s+c\s+h\s*\/\s*([\d.]+)\s*\)$/);
  if (relative) {
    const base = resolve(relative[1], map, trail);
    return { rgb: base.rgb, alpha: Number(relative[2]) };
  }

  const absolute = text.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/);
  if (absolute) {
    return {
      rgb: oklchToSrgb(Number(absolute[1]) / 100, Number(absolute[2]), Number(absolute[3])),
      alpha: absolute[4] === undefined ? 1 : Number(absolute[4]),
    };
  }

  const mix = text.match(/^color-mix\(\s*in\s+srgb\s*,([\s\S]+)\)$/);
  if (mix) {
    const [firstRaw, secondRaw] = splitArgs(mix[1]);
    const percent = firstRaw.match(/([\d.]+)%\s*$/);
    if (!percent) throw new Error(`color-mix without a percentage: ${text}`);
    const weight = Number(percent[1]) / 100;
    const first = resolve(firstRaw.slice(0, percent.index).trim(), map, trail);
    const second = resolve(secondRaw.replace(/[\d.]+%\s*$/, "").trim(), map, trail);
    return {
      rgb: first.rgb.map((channel, index) => weight * channel + (1 - weight) * second.rgb[index]),
      alpha: weight * first.alpha + (1 - weight) * second.alpha,
    };
  }

  const hex = text.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return { rgb: [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((channel) => channel / 255), alpha: 1 };
  }

  if (text === "transparent") return { rgb: [0, 0, 0], alpha: 0 };

  throw new Error(`cannot resolve colour value: ${text}`);
}

function lightnessOn(tokenName, baseName, map) {
  const colour = resolve(`var(${tokenName})`, map);
  if (colour.alpha >= 1) return srgbToOklabL(colour.rgb);
  if (!baseName) throw new Error(`${tokenName} is translucent — the pair needs a parent to composite over`);
  const backdrop = resolve(`var(${baseName})`, map);
  return srgbToOklabL(composite(colour, backdrop).rgb);
}

// ===== the check =====

const maps = themeMaps();
const rows = [];
const failures = [];

for (const pair of PAIRS) {
  for (const theme of ["light", "dark"]) {
    const map = maps[theme];
    let parentL;
    let childL;
    try {
      parentL = lightnessOn(pair.parent, pair.base, map);
      childL = lightnessOn(pair.child, pair.base ?? pair.parent, map);
    } catch (error) {
      failures.push({ ...pair, theme, error: error.message });
      continue;
    }
    const delta = Math.abs(parentL - childL);
    const row = { ...pair, theme, parentL, childL, delta, ok: delta >= MIN_DELTA_L };
    rows.push(row);
    if (!row.ok) failures.push(row);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ minDeltaL: MIN_DELTA_L, rows, failures }, null, 2));
} else {
  for (const row of rows) {
    const mark = row.ok ? "ok  " : "FAIL";
    const delta = row.delta.toFixed(4);
    console.log(`${mark} ${row.theme.padEnd(5)} Δ${delta}  ${row.parent} → ${row.child}  (${row.where})`);
  }
  for (const failure of failures) {
    if (!failure.error) continue;
    console.log(`FAIL ${failure.theme.padEnd(5)} ${failure.parent} → ${failure.child}: ${failure.error}`);
  }
}

if (failures.length) {
  console.error(
    `\nSurface ladder: ${failures.length} pair(s) below Δ${MIN_DELTA_L} OKLab L.\n` +
      "Either widen the tonal step in web/src/styles/design.md, or give the inner\n" +
      "container a fill instead of relying on an invisible step (see design.md Layering).",
  );
  process.exit(1);
}

console.log(`\nSurface ladder: ${rows.length} pair(s) at or above Δ${MIN_DELTA_L} OKLab L.`);
