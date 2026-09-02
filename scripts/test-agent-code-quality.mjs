import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSource,
  compatibilityMetadataProblems,
  isGeneratedVendorSource,
  unnecessaryConditionProblems,
} from "./check-agent-code-quality.mjs";

assert.equal(isGeneratedVendorSource("packages/client/src/generated/hey-api/client/client.gen.ts"), true);
assert.equal(isGeneratedVendorSource("packages/client/src/generated/client.ts"), false);

assert.match(analyzeSource("try { run(); } catch {}", "src/example.ts")[0] ?? "", /silent catch/);
assert.match(analyzeSource("const generated = `try { run(); } catch {}`;", "src/example.ts")[0] ?? "", /silent catch/);
assert.deepEqual(
  analyzeSource(
    "try { run(); } catch { // non-critical-fallback: Cache refresh is optional and the next request retries.\n}",
    "src/example.ts",
  ),
  [],
);
assert.match(
  analyzeSource(
    "try { run(); } catch { /* This comment is long but proves absolutely nothing. */ }",
    "src/example.ts",
  )[0] ?? "",
  /silent catch/,
);
assert.match(analyzeSource('try { run(); } catch { resolvePath("x"); }', "src/example.ts")[0] ?? "", /silent catch/);
assert.match(
  analyzeSource("try { run(); } catch { handleNothingImportant(); }", "src/example.ts")[0] ?? "",
  /silent catch/,
);
assert.match(
  analyzeSource("try { run(); } catch (error) { void error; handleNothingImportant(); }", "src/example.ts")[0] ?? "",
  /silent catch/,
);
assert.match(analyzeSource("try { run(); } catch { cached = undefined; }", "src/example.ts")[0] ?? "", /silent catch/);
assert.deepEqual(analyzeSource("try { run(); } catch { return undefined; }", "src/example.ts"), []);
assert.deepEqual(analyzeSource("try { run(); } catch (error) { console.warn(error); }", "src/example.ts"), []);
assert.match(
  analyzeSource("source.pipe(response);", "src/server/routes/example.ts")[0] ?? "",
  /must use pipeResponseStream/,
);
assert.match(
  analyzeSource("source.pipe(res);", "src/server/routes/example.ts")[0] ?? "",
  /must use pipeResponseStream/,
);
assert.deepEqual(analyzeSource("source.pipe(response);", "src/server/response-stream.ts"), []);
assert.match(
  analyzeSource("function forward(value: string) { return target(value); }\nforward('x');", "src/example.ts")[0] ?? "",
  /single-use forwarder/,
);
assert.match(
  analyzeSource(
    "function forward(value: string) { return target(value); }\nconst metadata = { forward: true };\nforward('x');",
    "src/example.ts",
  )[0] ?? "",
  /single-use forwarder/,
);
assert.deepEqual(
  analyzeSource(
    "// forwarding-boundary: names the protocol conversion seam.\nfunction forward(value: string) { return target(value); }\nforward('x');",
    "src/example.ts",
  ),
  [],
);
assert.match(
  analyzeSource(
    "// forwarding-boundary: x\nfunction forward(value: string) { return target(value); }\nforward('x');",
    "src/example.ts",
  )[0] ?? "",
  /single-use forwarder/,
);
assert.match(
  analyzeSource("const value = settings.kernelProviderBindings;", "src/example.ts")[0] ?? "",
  /compatibility field/,
);
assert.deepEqual(
  analyzeSource("const value = settings.kernelProviderBindings;", "src/server/migrations/example.ts"),
  [],
);
assert.match(analyzeSource("const value = current ?? legacyValue;", "src/example.ts")[0] ?? "", /boundary migration/);
assert.match(analyzeSource("const value = manifest.ui.kind;", "src/example.ts")[0] ?? "", /legacy ui\.kind/);
assert.match(analyzeSource("const type = 'codex.native';", "src/example.ts")[0] ?? "", /compatibility value/);
assert.equal(compatibilityMetadataProblems("export const migrate = 1;", "src/server/migrations/example.ts").length, 2);
assert.match(
  compatibilityMetadataProblems(
    `
/**
 * Issue: https://github.com/open-grove/opengrove/issues/1
 * Supports: old local state.
 * Remove when: old users are gone.
 */
`,
    "src/server/migrations/example.ts",
  ).join("\n"),
  /exact source version.*target version/s,
);
assert.deepEqual(
  compatibilityMetadataProblems(
    `
/**
 * Supports: OpenGrove <=1.0.0 state.
 * Remove when: OpenGrove 2.0.0 requires direct upgrades from >=1.0.0.
 */
`,
    "src/server/migrations/example.ts",
  ),
  [],
);

const typedFixtureRoot = mkdtempSync(join(tmpdir(), "opengrove-agent-check-"));
try {
  const configPath = join(typedFixtureRoot, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }));
  writeFileSync(
    join(typedFixtureRoot, "example.ts"),
    `
    interface State { app: { run(): void } }
    export function run(state: State) {
      if (!state.app) return;
      state.app.run();
    }
  `,
  );
  assert.match(
    unnecessaryConditionProblems(configPath, { root: typedFixtureRoot })[0] ?? "",
    /unnecessary defensive condition/,
  );
  writeFileSync(
    join(typedFixtureRoot, "example.ts"),
    `
    interface State { app?: { run(): void } }
    export function run(state: State) {
      if (!state.app) return;
      state.app.run();
    }
  `,
  );
  assert.deepEqual(unnecessaryConditionProblems(configPath, { root: typedFixtureRoot }), []);
} finally {
  rmSync(typedFixtureRoot, { recursive: true, force: true });
}

console.log("agent code-quality checker tests passed");
