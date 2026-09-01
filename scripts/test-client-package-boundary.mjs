import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageRules = [
  { name: "protocol", externalImports: new Set(["zod"]) },
  { name: "client", externalImports: new Set(["#protocol"]) },
];
const errors = [];

for (const rule of packageRules) {
  const sourceRoot = join(projectRoot, "packages", rule.name, "src");
  for (const file of typescriptFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith(".") || rule.externalImports.has(specifier)) continue;
      errors.push(
        `packages/${rule.name} has a forbidden import in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
      );
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Client package boundaries passed.");

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
