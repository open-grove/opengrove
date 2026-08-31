import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCssTree, baselineFromReport, compareReportToBaseline } from "./css-audit-core.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "opengrove-css-audit-"));
const cssRoot = join(fixtureRoot, "web", "src");
const tokensFile = join(cssRoot, "styles", "tokens.css");

try {
  mkdirSync(join(cssRoot, "styles"), { recursive: true });
  mkdirSync(join(cssRoot, "components"), { recursive: true });
  writeCss(
    "styles/tokens.css",
    ":root { --c-surface: oklch(100% 0 0); --sp-2: 8px; --r-md: 10px; --motion-fast: 120ms; }\n",
  );
  writeCss("components/legacy.css", ".legacy { padding: 6px; color: #fff; }\n");

  const analyze = () => analyzeCssTree({ cssRoot, tokensFile });
  const initialReport = analyze();
  const baseline = baselineFromReport(initialReport);
  assert.deepEqual(compareReportToBaseline(initialReport, baseline), {
    regressions: [],
    improvements: [],
  });

  writeCss(
    "components/new-clean.module.css",
    ".card { padding: var(--sp-2); border-radius: var(--r-md); background: var(--c-surface); transition: color var(--motion-fast); }\n",
  );
  const cleanFileReport = analyze();
  assert.deepEqual(
    compareReportToBaseline(cleanFileReport, baseline).regressions,
    [],
    "a new token-driven component stylesheet must be allowed",
  );

  writeCss(
    "components/unit-blind-spots.module.css",
    [
      ".relative { padding: 1rem; margin: .5em; gap: 2%; inset: 1vh; }",
      ".viewport { padding: clamp(1px, 2dvw, 3rem); }",
      ".allowed { padding: 0; margin: 0px; gap: 1px; }",
      "",
    ].join("\n"),
  );
  const unitReport = analyze();
  assert.equal(
    unitReport.perFile.find((file) => file.rel === "components/unit-blind-spots.module.css")?.spacingLiteral,
    5,
    "all non-zero raw spacing units except an exact 1px hairline must be counted",
  );

  writeCss("components/new-clean-global.css", ".clean-global { padding: var(--sp-2); color: var(--c-surface); }\n");
  const newGlobalReport = analyze();
  assert.ok(
    compareReportToBaseline(newGlobalReport, baseline).regressions.some((item) =>
      item.includes("legacy global stylesheet added: components/new-clean-global.css"),
    ),
    "new component styles must be co-located CSS Modules instead of global stylesheets",
  );

  writeCss(
    "components/new-dirty.module.css",
    ".card { padding: 10px; color: oklch(50% 0.1 120); border-radius: 7px; font-size: 13px; transition: color 100ms; box-shadow: 0 2px 8px black; }\n",
  );
  const dirtyFileReport = analyze();
  const dirtyComparison = compareReportToBaseline(dirtyFileReport, baseline);
  for (const metric of [
    "rawColor",
    "fontSizeLiteral",
    "radiusLiteral",
    "spacingLiteral",
    "motionLiteral",
    "shadowLiteral",
  ]) {
    assert.ok(
      dirtyComparison.regressions.some((item) => item.includes(`new-dirty.module.css: ${metric}`)),
      `new raw ${metric} debt must be rejected`,
    );
  }

  writeCss("components/legacy.css", ".legacy { padding: var(--sp-2); color: var(--c-surface); }\n");
  writeCss("components/offset.css", ".offset { padding: 6px; color: #fff; }\n");
  const offsetReport = analyze();
  const offsetComparison = compareReportToBaseline(offsetReport, baseline);
  assert.ok(
    offsetComparison.improvements.some((item) => item.includes("legacy.css")),
    "historical cleanup must be reported so the baseline can be lowered",
  );
  assert.ok(
    offsetComparison.regressions.some((item) => item.includes("offset.css")),
    "cleanup in one file must not buy new debt in another file",
  );

  writeCss("components/owner-a.css", ".shared-selector { color: var(--c-surface); }\n");
  writeCss("components/owner-b.css", ".shared-selector { color: var(--c-surface); }\n");
  const duplicateReport = analyze();
  assert.ok(
    compareReportToBaseline(duplicateReport, baseline).regressions.some((item) =>
      item.includes('duplicate selector \".shared-selector\"'),
    ),
    "a new global selector owner must be rejected",
  );

  console.log("css audit contract harness ok");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function writeCss(relativePath, contents) {
  const path = join(cssRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}
