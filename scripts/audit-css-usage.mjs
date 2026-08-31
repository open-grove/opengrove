#!/usr/bin/env node
// Cross-references CSS class selectors against class names referenced in the
// web components, so the refactor can tell apart "live" classes (never rename
// or delete during migration) from likely-dead selectors (safe to remove).
//
// Because class names are sometimes built dynamically (clsx, template strings,
// `data-*` driven selectors), this scanner extracts every quoted token that
// looks like a class fragment, not just static className="..." literals. That
// errs toward marking selectors LIVE, which is the safe direction: false
// "dead" reports are dangerous, false "live" reports merely keep dead code.
//
//   node scripts/audit-css-usage.mjs           # summary
//   node scripts/audit-css-usage.mjs --dead    # list likely-dead selectors
//   node scripts/audit-css-usage.mjs --json
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const webSrc = join(projectRoot, "web", "src");
const stylesRoot = join(webSrc, "styles");

const args = new Set(process.argv.slice(2));
const showDead = args.has("--dead");
const asJson = args.has("--json");

function listFiles(root, exts) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// --- 1. Collect all class names defined in CSS ---
const cssFiles = listFiles(stylesRoot, [".css"]);
const definedClasses = new Map(); // class -> Set<file>
const classInSelector = /\.([a-zA-Z_][\w-]*)/g;

for (const file of cssFiles) {
  const rel = relative(stylesRoot, file);
  const css = stripComments(readFileSync(file, "utf8"));
  // Only look at the selector portion (before each "{").
  for (const block of css.split("}")) {
    const selectorPart = block.split("{")[0] ?? "";
    let m;
    while ((m = classInSelector.exec(selectorPart)) !== null) {
      const cls = m[1];
      if (!definedClasses.has(cls)) definedClasses.set(cls, new Set());
      definedClasses.get(cls).add(rel);
    }
  }
}

// --- 2. Collect every class-like token referenced anywhere in components ---
// We gather all string literals and split on whitespace, capturing kebab/snake
// identifiers. This intentionally over-collects (covers clsx args, template
// fragments, conditional class strings).
const codeFiles = listFiles(webSrc, [".tsx", ".ts"]).filter((f) => !f.endsWith(".d.ts"));
const referenced = new Set();
const tokenLike = /[a-zA-Z_][\w-]*/g;

for (const file of codeFiles) {
  const src = readFileSync(file, "utf8");
  // All single/double/backtick quoted strings.
  const strings = src.match(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g) ?? [];
  for (const lit of strings) {
    const inner = lit.slice(1, -1);
    // Split on whitespace and template-expression boundaries.
    for (const piece of inner.split(/[\s${}()]+/)) {
      let m;
      while ((m = tokenLike.exec(piece)) !== null) {
        referenced.add(m[0]);
      }
    }
  }
}

// --- 3. Diff ---
const live = [];
const dead = [];
for (const [cls, files] of definedClasses) {
  if (referenced.has(cls)) {
    live.push(cls);
  } else {
    dead.push({ cls, files: [...files].sort() });
  }
}
dead.sort((a, b) => a.cls.localeCompare(b.cls));

const summary = {
  definedClasses: definedClasses.size,
  referencedTokens: referenced.size,
  liveClasses: live.length,
  likelyDeadClasses: dead.length,
};

if (asJson) {
  console.log(JSON.stringify({ summary, dead }, null, 2));
  process.exit(0);
}

console.log("OpenGrove CSS usage audit");
console.log("=========================");
console.log(`Classes defined in CSS    : ${summary.definedClasses}`);
console.log(`Class-like tokens in code : ${summary.referencedTokens}`);
console.log(`Live (referenced) classes : ${summary.liveClasses}`);
console.log(`Likely-dead classes       : ${summary.likelyDeadClasses}`);
console.log("");
console.log("NOTE: 'likely-dead' is a candidate list only. The scanner cannot");
console.log("see classes assembled from non-literal pieces. Verify each before");
console.log("deleting (grep the kebab stem, check data-* state selectors).");

if (showDead) {
  console.log("");
  console.log("Likely-dead selectors:");
  for (const d of dead) {
    console.log(`  .${d.cls}  [${d.files.join(", ")}]`);
  }
}
