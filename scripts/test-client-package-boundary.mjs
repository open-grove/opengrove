import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageRules = [
  { name: "protocol", externalImports: new Set(["zod"]) },
  { name: "client", externalImports: new Set(["#protocol"]) },
  { name: "sdk", externalImports: new Set() },
];
const runtimeRules = [
  { name: "Web runtime", sourceRoot: join(projectRoot, "web", "src") },
  { name: "Server and CLI runtime", sourceRoot: join(projectRoot, "src") },
  { name: "Desktop runtime", sourceRoot: join(projectRoot, "desktop") },
];
const errors = [];

const importScannerFixtures = [
  ['import sdk from "@opengrove/sdk";', "@opengrove/sdk"],
  ["import '@hey-api/client-fetch';", "@hey-api/client-fetch"],
  ["void import(`@opengrove/sdk`);", "@opengrove/sdk"],
];
for (const [source, expected] of importScannerFixtures) {
  if (!moduleSpecifiers(source).includes(expected)) {
    errors.push(`client boundary import scanner must recognize ${expected}`);
  }
}

if (existsSync(join(projectRoot, "packages", "client", "src", "generated", "hey-api"))) {
  errors.push("packages/client must not contain the external Hey API SDK");
}

for (const [file, specifier, allowed] of [
  ["src/server/remote-agents/client.ts", "@agent-router/sdk", true],
  ["src/tests/remote-agent.test.ts", "@agent-router/sdk", true],
  ["src/rooms/channel-store.ts", "@agent-router/sdk", false],
  ["web/src/app.tsx", "@agent-router/sdk", false],
  ["src/server/remote-agents/client.ts", "matrix-js-sdk", false],
  ["src/server/remote-agents/client.ts", "@a2a-js/sdk/client", false],
]) {
  if (communicationImportAllowed(join(projectRoot, file), specifier) !== allowed) {
    errors.push(`communication boundary scanner failed for ${file}: ${specifier}`);
  }
}

for (const rule of packageRules) {
  const sourceRoot = join(projectRoot, "packages", rule.name, "src");
  if (!existsSync(sourceRoot)) {
    errors.push(`packages/${rule.name}/src must exist`);
    continue;
  }
  for (const file of moduleSourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (rule.name === "client" && (isExternalSdkImport(file, specifier) || specifier.includes("hey-api"))) {
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
for (const rule of runtimeRules) {
  for (const file of moduleSourceFiles(rule.sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (isExternalSdkImport(file, specifier)) {
        errors.push(
          `${rule.name} must not depend on the external SDK in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
        );
      }
      if (!communicationImportAllowed(file, specifier)) {
        errors.push(`Communication SDK imports belong only to the server remote-agents adapter: ${file}: ${specifier}`);
      }
      if (rule.name === "Web runtime" && webForbiddenImports.has(specifier)) {
        errors.push(
          `Web runtime has a forbidden Protocol build import in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
        );
      }
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Client package boundaries passed.");

function communicationImportAllowed(file, specifier) {
  const path = relative(projectRoot, file).replaceAll("\\", "/");
  if (path.startsWith("src/tests/")) return true;
  if (specifier === "@agent-router/sdk" || specifier.startsWith("@agent-router/sdk/")) {
    return path.startsWith("src/server/remote-agents/");
  }
  return !["matrix-js-sdk", "@a2a-js/sdk"].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function moduleSpecifiers(source) {
  return Array.from(
    source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/gu),
    (match) => match[2],
  ).filter(Boolean);
}

function isExternalSdkImport(file, specifier) {
  return (
    specifier === "@opengrove/sdk" ||
    specifier.startsWith("@opengrove/sdk/") ||
    specifier === "@hey-api" ||
    specifier.startsWith("@hey-api/") ||
    relativeImportTargetsPackage(file, specifier, "sdk")
  );
}

function relativeImportTargetsPackage(file, specifier, packageName) {
  if (!specifier.startsWith(".")) return false;
  const target = relative(projectRoot, resolve(dirname(file), specifier)).replaceAll("\\", "/");
  return target === `packages/${packageName}` || target.startsWith(`packages/${packageName}/`);
}

function moduleSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleSourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) ? [path] : [];
  });
}
