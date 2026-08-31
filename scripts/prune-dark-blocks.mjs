// Systematically prune redundant dark-theme blocks: for each rule block, try
// removing it, rebuild, screenshot-compare. If 0 regressed -> the block was
// redundant (light-side tokens already handle dark), drop it. Else keep.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
const target = process.argv[2];
const url = "http://127.0.0.1:37401/ui/";
const backup = "/tmp/prune-backup.css";
if (!target) {
  console.error("Usage: node scripts/prune-dark-blocks.mjs <css-file>");
  process.exit(2);
}
copyFileSync(target, backup);

function splitBlocks(css) {
  // Returns top-level {text, isRule} blocks. Nested at-rules are preserved as
  // non-rule blocks so this destructive script never slices a @media body.
  const out = [];
  let chunkStart = 0;
  let blockStart = -1;
  let depth = 0;
  let stringQuote = "";
  let inComment = false;

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1] || "";

    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (stringQuote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === stringQuote) {
        stringQuote = "";
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        blockStart = chunkStart;
      }
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && blockStart >= 0) {
        const text = css.slice(blockStart, i + 1);
        const prelude = text.slice(0, text.indexOf("{")).trim();
        out.push({ text, isRule: !prelude.startsWith("@") });
        chunkStart = i + 1;
        blockStart = -1;
      }
    }
  }
  if (chunkStart < css.length) {
    out.push({ text: css.slice(chunkStart), isRule: false });
  }
  return out;
}
function build() {
  execSync("node scripts/build-web.mjs", { stdio: "ignore" });
}
function regressed() {
  // visual-regression.mjs exits non-zero when there's a diff; capture output
  // regardless instead of letting execSync throw.
  let out = "";
  try {
    out = execSync(`node scripts/visual-regression.mjs --url ${url}`, { encoding: "utf8" });
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const m = out.match(/(\d+) regressed/);
  return m ? Number(m[1]) : 99;
}

let css = readFileSync(target, "utf8");
let blocks = splitBlocks(css);
const ruleIdx = blocks.map((b, i) => (b.isRule ? i : -1)).filter((i) => i >= 0);
let dropped = 0,
  kept = 0;
for (const idx of ruleIdx) {
  if (!blocks[idx]) continue;
  // ONLY prune actual top-level dark-theme rules. Other blocks (layout, and
  // especially @media rules, which a fixed-width screenshot can't cover) must
  // not be touched, or we silently delete responsive/light styles.
  const t = blocks[idx].text;
  const isDark = /resolved-theme/.test(t);
  if (!isDark || t.includes("extension")) {
    kept++;
    continue;
  }
  const saved = blocks[idx].text;
  blocks[idx] = { text: "", isRule: true };
  writeFileSync(target, blocks.map((b) => b.text).join(""));
  build();
  if (regressed() === 0) {
    dropped++;
    const sel = saved.split("{")[0].trim().slice(0, 60).replace(/\s+/g, " ");
    console.log(`  DROP  ${sel}...`);
  } else {
    blocks[idx] = { text: saved, isRule: true };
    kept++;
  }
}
writeFileSync(target, blocks.map((b) => b.text).join(""));
build();
const final = regressed();
console.log(`\nDropped ${dropped} redundant blocks, kept ${kept}. Final regressed: ${final}`);
if (final !== 0) {
  console.log("UNEXPECTED final regression — restoring backup");
  copyFileSync(backup, target);
  build();
}
