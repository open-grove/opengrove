import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageRules = [
  { name: "protocol", externalImports: new Set(["zod"]) },
  { name: "client", externalImports: new Set(["#protocol"]) },
  { name: "sdk", externalImports: new Set() },
];
const errors = [];

if (existsSync(join(projectRoot, "packages", "client", "src", "generated", "hey-api"))) {
  errors.push("packages/client must not contain the external Hey API SDK");
}

for (const rule of packageRules) {
  const sourceRoot = join(projectRoot, "packages", rule.name, "src");
  if (!existsSync(sourceRoot)) {
    errors.push(`packages/${rule.name}/src must exist`);
    continue;
  }
  for (const file of typescriptFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (
        rule.name === "client" &&
        specifier &&
        (specifier.includes("hey-api") ||
          specifier === "@opengrove/sdk" ||
          specifier.startsWith("@opengrove/sdk/") ||
          relativeImportTargetsPackage(file, specifier, "sdk"))
      ) {
        errors.push(`packages/client must not depend on the external SDK in ${file.slice(projectRoot.length + 1)}`);
        continue;
      }
      if (
        rule.name === "sdk" &&
        specifier &&
        (specifier === "@opengrove/client" ||
          specifier.startsWith("@opengrove/client/") ||
          specifier === "@opengrove/protocol" ||
          specifier.startsWith("@opengrove/protocol/") ||
          relativeImportTargetsPackage(file, specifier, "client") ||
          relativeImportTargetsPackage(file, specifier, "protocol"))
      ) {
        errors.push(
          `packages/sdk must remain independent from OpenGrove runtime packages in ${file.slice(projectRoot.length + 1)}`,
        );
        continue;
      }
      if (!specifier || specifier.startsWith(".") || rule.externalImports.has(specifier)) continue;
      errors.push(
        `packages/${rule.name} has a forbidden import in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
      );
    }
  }
}

const webForbiddenImports = new Set([
  "#protocol/compiled",
  "#protocol/compiler",
  "@opengrove/protocol/compiled",
  "@opengrove/protocol/compiler",
]);
for (const file of typescriptFiles(join(projectRoot, "web", "src"))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (specifier && webForbiddenImports.has(specifier)) {
      errors.push(
        `Web runtime has a forbidden Protocol build import in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
      );
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Client package boundaries passed.");

function relativeImportTargetsPackage(file, specifier, packageName) {
  if (!specifier.startsWith(".")) return false;
  const target = relative(projectRoot, resolve(dirname(file), specifier)).replaceAll("\\", "/");
  return target === `packages/${packageName}` || target.startsWith(`packages/${packageName}/`);
}

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
