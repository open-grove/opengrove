import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./design-tokens.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const frontmatter = ["---", "version: 1", "name: OpenGrove", "---", "# Design"].join("\r\n");

assert.equal(
  parseFrontmatter(frontmatter),
  ["version: 1", "name: OpenGrove"].join("\r\n"),
  "design frontmatter parsing must accept Windows CRLF line endings",
);

const tokenSource = readFileSync(join(projectRoot, "web/src/styles/tokens.css"), "utf8");
assert.equal(escapeRegExp("a.b[c]"), "a\\.b\\[c\\]", "design-token assertions must escape regular-expression syntax");
for (const [token, value] of Object.entries({
  "--overlay-surface-compact-min-width": "140px",
  "--overlay-surface-compact-max-width": "200px",
  "--overlay-surface-content-min-width": "160px",
  "--overlay-surface-content-max-width": "260px",
  "--overlay-surface-regular-min-width": "232px",
  "--overlay-surface-regular-max-width": "280px",
  "--overlay-surface-wide-min-width": "280px",
  "--overlay-surface-wide-max-width": "320px",
  "--overlay-surface-picker-min-width": "320px",
  "--overlay-surface-picker-max-width": "360px",
})) {
  assert.match(
    tokenSource,
    new RegExp(`${escapeRegExp(token)}: ${escapeRegExp(value)};`),
    `${token} must be generated from the shared overlay surface width contract`,
  );
}
const definedFontWeights = new Set([...tokenSource.matchAll(/(--fw-[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
const usedFontWeights = new Set(
  collectFiles(join(projectRoot, "web/src"), ".css")
    .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/var\((--fw-[a-z0-9-]+)\)/gi)])
    .map((match) => match[1]),
);
assert.deepEqual(
  [...usedFontWeights].filter((token) => !definedFontWeights.has(token)),
  [],
  "every referenced font-weight token must be defined in tokens.css",
);

console.log("design-tokens frontmatter harness ok");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFiles(root, extension) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(path, extension);
    return extname(entry.name) === extension ? [path] : [];
  });
}
