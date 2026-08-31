import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

// Minifies compiled Node outputs that ship inside app.asar. This is a
// source-hardening step: tsc can otherwise emit readable JavaScript, so we
// minify to strip comments, collapse whitespace, and rename local identifiers.
// It is NOT encryption; it only raises the effort required to read or copy the code.
//
// ESM format and import specifiers are preserved so module resolution keeps working.
// Source maps are removed from the shipped output so minified code cannot be trivially
// mapped back to original sources.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const targets = [
  {
    label: "server dist",
    dir: join(projectRoot, "dist"),
  },
  {
    label: "agent protocol dist",
    dir: join(projectRoot, "packages", "agent-protocol", "dist"),
  },
];

const stats = { minified: 0, mapsRemoved: 0, bytesBefore: 0, bytesAfter: 0 };

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

for (const target of targets) {
  try {
    for await (const file of walk(target.dir)) {
      if (file.endsWith(".js.map")) {
        await rm(file, { force: true });
        stats.mapsRemoved += 1;
        continue;
      }
      if (!file.endsWith(".js")) {
        continue;
      }
      const source = await readFile(file, "utf8");
      stats.bytesBefore += source.length;
      const result = await transform(source, {
        minify: true,
        format: "esm",
        platform: "node",
        legalComments: "none",
        // Drop any inline sourcemap comment; maps are deleted above regardless.
        sourcemap: false,
      });
      await writeFile(file, result.code, "utf8");
      stats.bytesAfter += result.code.length;
      stats.minified += 1;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    console.warn(`minify-dist: skipped missing ${target.label} (${relative(projectRoot, target.dir)})`);
  }
}

const pct = stats.bytesBefore ? Math.round((1 - stats.bytesAfter / stats.bytesBefore) * 100) : 0;
console.log(
  `minify-dist: ${stats.minified} files minified, ${stats.mapsRemoved} source maps removed, ` +
    `${(stats.bytesBefore / 1024 / 1024).toFixed(1)}MB -> ${(stats.bytesAfter / 1024 / 1024).toFixed(1)}MB (${pct}% smaller)`,
);
