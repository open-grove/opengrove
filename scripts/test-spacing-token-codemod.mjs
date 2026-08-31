import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rewriteSpacingCss,
  rewriteSpacingValue,
  runSpacingCodemod,
  spacingTokenMap,
} from "./spacing-token-codemod.mjs";

const tokenByPx = spacingTokenMap({
  0: "0px",
  hairline: "1px",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
});
assert.equal(tokenByPx.has(0), false, "zero remains a literal exception instead of becoming a spacing token");
assert.equal(
  tokenByPx.has(1),
  false,
  "the 1px hairline remains a literal exception instead of becoming a spacing token",
);

assert.throws(
  () => runSpacingCodemod({ apply: true }),
  /requires one or more explicit CSS files or directories/,
  "apply must require an explicit scope instead of rewriting the whole repository",
);
assert.throws(
  () =>
    runSpacingCodemod({
      paths: [fileURLToPath(new URL("../web/src/styles/tokens.css", import.meta.url))],
    }),
  /does not edit generated web\/src\/styles\/tokens\.css; change web\/src\/styles\/design\.md instead/,
  "an explicit generated token target must explain which source file to edit",
);

const source = `
.safe {
  padding: 4px;
  margin: 8px 12px 16px 20px;
  gap: 0 24px;
  inset: 1px 32px;
  padding-inline: 40px;
  padding-block: 8px /* keep the 36px axis note */ 12px !important;
}
.skip {
  padding: -8px;
  margin: 1rem;
  gap: calc(8px + 4px);
  inset: clamp(8px, 2vw, 40px);
  margin-inline: 8px auto;
  padding-block: 14px;
  padding-inline: 8px 14px;
  transform: translate(8px);
  border: 8px solid;
  --local-gap: 8px;
}
`;

const result = rewriteSpacingCss(source, { tokenByPx });
assert.equal(result.declarationsChanged, 6);
assert.equal(result.valuesChanged, 10);
assert.match(result.css, /padding: var\(--sp-1\)/);
assert.match(result.css, /margin: var\(--sp-2\) var\(--sp-3\) var\(--sp-4\) var\(--sp-5\)/);
assert.match(result.css, /gap: 0 var\(--sp-6\)/);
assert.match(result.css, /inset: 1px var\(--sp-8\)/);
assert.match(result.css, /padding-inline: var\(--sp-10\)/);
assert.match(result.css, /padding-block: var\(--sp-2\) \/\* keep the 36px axis note \*\/ var\(--sp-3\) !important/);
assert.match(result.css, /padding: -8px/);
assert.match(result.css, /margin: 1rem/);
assert.match(result.css, /gap: calc\(8px \+ 4px\)/);
assert.match(result.css, /inset: clamp\(8px, 2vw, 40px\)/);
assert.match(result.css, /margin-inline: 8px auto/);
assert.match(result.css, /padding-block: 14px/);
assert.match(result.css, /padding-inline: 8px 14px/);
assert.match(result.css, /transform: translate\(8px\)/);
assert.match(result.css, /border: 8px solid/);
assert.match(result.css, /--local-gap: 8px/);

assert.deepEqual(
  rewriteSpacingCss(result.css, { tokenByPx }),
  {
    css: result.css,
    declarationsChanged: 0,
    valuesChanged: 0,
    skipped: result.skipped,
  },
  "a second pass must be idempotent",
);

for (const [value, reason] of [
  ["-8px", "negative-length"],
  ["1rem", "non-px-length"],
  ["calc(8px + 4px)", "function-or-variable"],
  ["8px auto", "mixed-or-keyword-value"],
  ["14px", "unmapped-px"],
  ["8px 14px", "unmapped-px"],
]) {
  const skipped = rewriteSpacingValue(value, tokenByPx);
  assert.equal(skipped.changed, false, `${value} must be skipped`);
  assert.equal(skipped.reason, reason, `${value} must explain why it was skipped`);
}

const tempDir = mkdtempSync(join(tmpdir(), "opengrove-spacing-codemod-"));
try {
  const fixture = join(tempDir, "fixture.css");
  writeFileSync(fixture, ".fixture { padding: 8px 12px; }\n", "utf8");
  const dryRun = rewriteSpacingCss(readFileSync(fixture, "utf8"), { from: fixture, tokenByPx });
  assert.equal(dryRun.declarationsChanged, 1);
  assert.equal(readFileSync(fixture, "utf8"), ".fixture { padding: 8px 12px; }\n", "analysis must not write files");
  writeFileSync(fixture, dryRun.css, "utf8");
  assert.equal(
    readFileSync(fixture, "utf8"),
    ".fixture { padding: var(--sp-2) var(--sp-3); }\n",
    "apply output must preserve the declaration while replacing exact values",
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("spacing token codemod harness passed");
