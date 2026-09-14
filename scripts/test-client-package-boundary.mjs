import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

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
  ['const sdk = "@agent-router/sdk"; await import(sdk);', "@agent-router/sdk"],
  [
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("@agent-router/sdk");',
    "@agent-router/sdk",
  ],
  ['export { AgentRouterClient } from "@agent-router/sdk";', "@agent-router/sdk"],
  ['const prefix = "@agent-router/"; const sdk = prefix + "sdk"; await import(sdk);', "@agent-router/sdk"],
];
for (const [source, expected] of importScannerFixtures) {
  if (!moduleSpecifiers(source).includes(expected)) {
    errors.push(`client boundary import scanner must recognize ${expected}`);
  }
}

if (existsSync(join(projectRoot, "packages", "client", "src", "generated", "hey-api"))) {
  errors.push("packages/client must not contain the external Hey API SDK");
}

for (const [file, specifier, allowed, kind] of [
  ["src/server/remote-agents/client.ts", "@agent-router/sdk", true],
  ["src/tests/remote-agent-room.test.ts", "@agent-router/sdk", true],
  ["src/rooms/channel-store.ts", "@agent-router/sdk", false],
  ["web/src/app.tsx", "@agent-router/sdk", false],
  ["src/server/remote-agents/client.ts", "matrix-js-sdk", false],
  ["src/server/remote-agents/client.ts", "@a2a-js/sdk/client", false],
  ["src/server/remote-agents/client.ts", "@agent-router/sdk", false, "export"],
]) {
  if (communicationImportAllowed(join(projectRoot, file), specifier, kind) !== allowed) {
    errors.push(`communication boundary scanner failed for ${file}: ${specifier}`);
  }
}

assertScannerContract();

for (const rule of packageRules) {
  const sourceRoot = join(projectRoot, "packages", rule.name, "src");
  if (!existsSync(sourceRoot)) {
    errors.push(`packages/${rule.name}/src must exist`);
    continue;
  }
  for (const file of moduleSourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const { specifier } of moduleImports(source, file)) {
      if (specifier === undefined) {
        errors.push(`Module loads must use statically resolvable specifiers: ${file}`);
        continue;
      }
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
    for (const { specifier, kind } of moduleImports(source, file)) {
      if (specifier === undefined) {
        if (!relative(projectRoot, file).replaceAll("\\", "/").startsWith("src/tests/")) {
          errors.push(`Module loads must use statically resolvable specifiers: ${file}`);
        }
        continue;
      }
      if (isExternalSdkImport(file, specifier)) {
        errors.push(
          `${rule.name} must not depend on the external SDK in ${file.slice(projectRoot.length + 1)}: ${specifier}`,
        );
      }
      if (!communicationImportAllowed(file, specifier, kind)) {
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

function communicationImportAllowed(file, specifier, kind = "import") {
  const path = relative(projectRoot, file).replaceAll("\\", "/");
  if (path.startsWith("src/tests/")) return true;
  if (specifier === "@agent-router/sdk" || specifier.startsWith("@agent-router/sdk/")) {
    return kind !== "export" && path.startsWith("src/server/remote-agents/");
  }
  return !["matrix-js-sdk", "@a2a-js/sdk"].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function moduleSpecifiers(source) {
  return moduleImports(source).flatMap(({ specifier }) => (specifier === undefined ? [] : [specifier]));
}

/** Source lint: inspect syntax and constant module names without executing application code. */
function moduleImports(source, file = "fixture.tsx") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  const requireFactories = new Set();
  const moduleNamespaces = new Set();
  const importedBindings = new Map();
  const loads = new Set(["require"]);
  const imports = [];
  visit(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      constants.set(node.name.text, node.initializer);
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause?.name) importedBindings.set(clause.name.text, specifier);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      importedBindings.set(bindings.name.text, specifier);
      if (["module", "node:module"].includes(specifier)) moduleNamespaces.add(bindings.name.text);
    } else if (bindings) {
      for (const element of bindings.elements) {
        importedBindings.set(element.name.text, specifier);
        if (
          ["module", "node:module"].includes(specifier) &&
          (element.propertyName ?? element.name).text === "createRequire"
        ) {
          requireFactories.add(element.name.text);
        }
      }
    }
  });
  const isRequireFactory = (node) =>
    ts.isIdentifier(node)
      ? requireFactories.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        moduleNamespaces.has(node.expression.text) &&
        node.name.text === "createRequire";
  for (const [name, value] of constants) {
    if (ts.isCallExpression(value) && isRequireFactory(value.expression)) loads.add(name);
  }
  function constantString(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return constantString(node.expression, seen);
    }
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      return constantString(constants.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantString(node.left, seen);
      const right = constantString(node.right, seen);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  }
  visit(tree, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const kind = ts.isExportDeclaration(node) ? "export" : "import";
      if (node.moduleSpecifier) imports.push({ specifier: constantString(node.moduleSpecifier), kind });
      else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const specifier = importedBindings.get((element.propertyName ?? element.name).text);
          if (specifier) imports.push({ specifier, kind });
        }
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imports.push({ specifier: constantString(node.argument.literal), kind: "import" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      imports.push({ specifier: constantString(node.moduleReference.expression), kind: "import" });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && loads.has(callee.text)) ||
        (ts.isCallExpression(callee) && isRequireFactory(callee.expression))
      ) {
        imports.push({ specifier: constantString(node.arguments[0]), kind: "import" });
      }
    }
  });
  return imports;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function assertScannerContract() {
  if (
    moduleImports("await import(runtimePackage)")[0]?.specifier !== undefined ||
    moduleImports("await import(runtimePackage)").length !== 1
  ) {
    errors.push("unresolved dynamic imports must be reported");
  }
  if (moduleSpecifiers('// import sdk from "@agent-router/sdk";').length !== 0) {
    errors.push("import-like comments must not become dependencies");
  }
  const exports = moduleImports('import { AgentRouterClient as Client } from "@agent-router/sdk"; export { Client };');
  if (!exports.some((entry) => entry.kind === "export" && entry.specifier === "@agent-router/sdk")) {
    errors.push("an imported SDK binding must not escape through a local re-export");
  }
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
