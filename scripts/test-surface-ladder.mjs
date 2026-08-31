#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const gatePath = join(scriptDir, "check-surface-ladder.mjs");
const sourceTokensPath = join(scriptDir, "..", "web", "src", "styles", "tokens.css");
const fixtureDir = mkdtempSync(join(tmpdir(), "opengrove-surface-ladder-"));
const fixturePath = join(fixtureDir, "collapsed-tokens.css");

try {
  const source = readFileSync(sourceTokensPath, "utf8");
  const lightSurfaceSunken = /^  --c-surface-sunken: oklch\([\d.]+% [\d.]+ [\d.]+\);$/m;
  const collapsed = "  --c-surface-sunken: oklch(99.500% 0.0029 264.54);";
  if (!lightSurfaceSunken.test(source)) {
    throw new Error("surface ladder fixture is stale: light --c-surface-sunken was not found");
  }

  writeFileSync(fixturePath, source.replace(lightSurfaceSunken, collapsed));
  const result = spawnSync(process.execPath, [gatePath, "--tokens", fixturePath], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.status === 0) {
    throw new Error("surface ladder accepted a deliberately collapsed surface pair");
  }
  if (!output.includes("FAIL light") || !output.includes("--c-surface → --c-surface-sunken")) {
    throw new Error(`surface ladder failed for the wrong reason:\n${output}`);
  }

  console.log("Surface ladder negative fixture: collapsed light surface pair rejected.");
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
