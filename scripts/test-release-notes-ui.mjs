import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-release-notes-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const outputPath = join(tempDir, "bundle.cjs");
const componentPath = join(projectRoot, "web", "src", "components", "shared", "release-notes-markdown.tsx");

try {
  await writeFile(
    entryPath,
    `import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseNotesMarkdown } from ${JSON.stringify(componentPath)};

const html = renderToStaticMarkup(
	createElement(ReleaseNotesMarkdown, { markdown: ${JSON.stringify(`### Easier rooms

- **Faster** messages
- [Release details](https://example.test/release)

| Surface | Result |
| --- | --- |
| Rooms | Clearer |

<script>globalThis.compromised = true</script>`)} }),
);
assert.ok(html.includes("<h3>Easier rooms</h3>"));
assert.ok(html.includes("<ul>"));
assert.ok(html.includes("<strong>Faster</strong>"));
assert.ok(html.includes('target="_blank"'));
assert.ok(html.includes("<table>"));
assert.ok(!html.includes("<script>"));
console.log("release notes UI tests passed");
`,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    outfile: outputPath,
    nodePaths: [join(projectRoot, "node_modules")],
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    logLevel: "silent",
  });
  await import(`${new URL(`file://${outputPath}`).href}?source=${(await readFile(outputPath)).byteLength}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
