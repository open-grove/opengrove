#!/usr/bin/env node
// CSS design-contract audit.
//
// New component CSS is welcome when it consumes the shared design contract.
// Historical exceptions are recorded per file and may only move downward:
//
//   node scripts/audit-css.mjs            # human-readable summary
//   node scripts/audit-css.mjs --json     # full machine-readable report
//   node scripts/audit-css.mjs --baseline # lock in verified debt reductions
//   node scripts/audit-css.mjs --check    # enforce the per-file ratchet
//   node scripts/audit-css.mjs --divergent
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_VERSION,
  DEBT_METRICS,
  analyzeCssTree,
  baselineFromReport,
  compareReportToBaseline,
} from "./css-audit-core.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const cssRoot = join(projectRoot, "web", "src");
const tokensFile = join(cssRoot, "styles", "tokens.css");
const baselinePath = join(scriptDir, "audit-css-baseline.json");
const args = new Set(process.argv.slice(2));
const report = analyzeCssTree({
  cssRoot,
  tokensFile,
});

if (args.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (args.has("--divergent")) {
  console.log(`Divergent declarations: ${report.divergentDeclarations.length}`);
  console.log("(same selector + responsive context + property, different values)\n");
  for (const item of report.divergentDeclarations) {
    const context = item.context ? ` [${item.context}]` : "";
    console.log(`  ${item.selector} { ${item.property} }${context}`);
    console.log(`    ${item.values.join("  |  ")}`);
    console.log(`    ${item.files.join(", ")}`);
  }
  process.exit(0);
}

if (args.has("--baseline")) {
  if (existsSync(baselinePath)) {
    const existing = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (existing.version === BASELINE_VERSION) {
      const comparison = compareReportToBaseline(report, existing);
      if (comparison.regressions.length) {
        console.error("Refusing to raise the CSS debt baseline:");
        for (const item of comparison.regressions) console.error(`  ${item}`);
        process.exit(1);
      }
    }
  }
  const nextBaseline = baselineFromReport(report);
  writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf8");
  console.log(`Baseline written to ${relative(projectRoot, baselinePath)}.`);
  process.exit(0);
}

if (args.has("--check")) {
  if (!existsSync(baselinePath)) {
    console.error("No baseline found. Run: node scripts/audit-css.mjs --baseline");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const comparison = compareReportToBaseline(report, baseline);
  if (comparison.regressions.length) {
    console.error("CSS design debt increased:");
    for (const item of comparison.regressions) console.error(`  ${item}`);
  }
  if (comparison.improvements.length) {
    console.error("CSS design debt decreased; lock in the improvement with `node scripts/audit-css.mjs --baseline`:");
    for (const item of comparison.improvements) console.error(`  ${item}`);
  }
  if (comparison.regressions.length || comparison.improvements.length) process.exit(1);
  console.log("CSS design contract and per-file debt baseline are satisfied.");
  process.exit(0);
}

const fmt = (value) => String(value).padStart(6);
console.log("OpenGrove CSS design audit");
console.log("==========================");
console.log(`CSS files             : ${fmt(report.totals.files)}   (informational; modular files are welcome)`);
console.log(`Total lines           : ${fmt(report.totals.lines)}   (informational)`);
for (const metric of DEBT_METRICS) {
  console.log(`${metric.padEnd(22)}: ${fmt(report.totals[metric])}`);
}
console.log(`Duplicate selectors   : ${fmt(report.totals.duplicateSelectors)}`);
console.log(`Patch-layer files     : ${fmt(report.totals.patchLayerFiles)}`);
console.log(`Legacy global CSS     : ${fmt(report.totals.legacyGlobalFiles)}`);
console.log("");

const highestDebtFiles = report.perFile
  .map((file) => ({
    rel: file.rel,
    debt: DEBT_METRICS.reduce((sum, metric) => sum + file[metric], 0),
  }))
  .filter((file) => file.debt > 0)
  .sort((left, right) => right.debt - left.debt || left.rel.localeCompare(right.rel))
  .slice(0, 12);
console.log("Highest historical-debt files:");
for (const file of highestDebtFiles) {
  console.log(`  ${fmt(file.debt)}  ${file.rel}`);
}
