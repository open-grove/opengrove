import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webSourcePath = join(projectRoot, "web", "src");

assert.deepEqual(
  findFixedGlobalScrollbarDimensions([
    {
      path: "fixture.css",
      source: [
        "*::-webkit-scrollbar { width: 8px; }",
        ":where(*)::-webkit-scrollbar { height: 8px; }",
        ".panel::-webkit-scrollbar-thumb { width: 8px; }",
      ].join("\n"),
    },
  ]),
  ["fixture.css: *::-webkit-scrollbar { width: 8px }", "fixture.css: :where(*)::-webkit-scrollbar { height: 8px }"],
  "the guard must catch global scrollbar dimensions regardless of selector spelling",
);

assert.deepEqual(
  findFixedGlobalScrollbarDimensions(listCssFiles(webSourcePath)),
  [],
  "fixed ::-webkit-scrollbar dimensions convert macOS overlay scrollbars into always-visible classic scrollbars",
);

console.log("web-scrollbar-overlay-harness ok");

function listCssFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCssFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push({ path, source: readFileSync(path, "utf8") });
    }
  }

  return files;
}

function findFixedGlobalScrollbarDimensions(files) {
  const dimensions = [];

  for (const file of files) {
    const root = postcss.parse(file.source, { from: file.path });

    root.walkRules((rule) => {
      if (!rule.selectors?.some((selector) => /::-webkit-scrollbar(?![-\w])/.test(selector))) return;

      for (const declaration of rule.nodes ?? []) {
        if (declaration.type !== "decl") continue;
        if (declaration.prop !== "width" && declaration.prop !== "height") continue;
        const displayPath = file.path === "fixture.css" ? file.path : relative(projectRoot, file.path);
        dimensions.push(`${displayPath}: ${rule.selector} { ${declaration.prop}: ${declaration.value} }`);
      }
    });
  }

  return dimensions;
}
