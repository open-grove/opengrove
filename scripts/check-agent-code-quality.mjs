import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoots = ["src", "web/src", "desktop", "packages"];
const retiredCompatibilityFields = [
  "kernelProviderBindings",
  "codexWireApi",
  "hermesGatewaySessionId",
  "hermesGatewaySessionUpdatedAt",
  "userLanguagePreference",
];
const retiredCompatibilityValues = new Set([
  "codex.native",
  "claude.native",
  "pi.native",
  "hermes.native",
  "legacy-command",
]);

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const problems = [];
  for (const sourceRoot of sourceRoots) {
    for (const path of sourceFiles(join(projectRoot, sourceRoot))) {
      const projectPath = relative(projectRoot, path);
      // Third-party generated sources are immutable here and are instead pinned,
      // regenerated, typechecked, linted, and contract-tested by the Host API gates.
      if (isGeneratedVendorSource(projectPath)) continue;
      const source = readFileSync(path, "utf8");
      problems.push(...analyzeSource(source, projectPath));
      if (isCompatibilityBoundary(projectPath)) {
        problems.push(...compatibilityMetadataProblems(source, projectPath));
      }
    }
  }
  for (const configPath of ["tsconfig.json", "web/tsconfig.json", "tsconfig.desktop.json"]) {
    problems.push(...unnecessaryConditionProblems(join(projectRoot, configPath)));
  }
  const uniqueProblems = [...new Set(problems)];
  if (uniqueProblems.length) {
    console.error(`Agent code-quality checks failed:\n${uniqueProblems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log("agent code-quality checks passed");
}

export function isGeneratedVendorSource(filePath) {
  return filePath.replaceAll(sep, "/").startsWith("packages/sdk/src/generated/");
}

export function analyzeSource(source, filePath) {
  const problems = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  visit(sourceFile, (node) => {
    if (filePath !== "src/server/response-stream.ts" && isDirectResponsePipe(node)) {
      problems.push(
        at(
          sourceFile,
          node,
          `${filePath}: response streams must use pipeResponseStream so downstream close destroys the source`,
        ),
      );
    }
    if (ts.isCatchClause(node) && !hasAuditableCatchComment(node, sourceFile) && !catchHandlesFailure(node)) {
      problems.push(
        at(
          sourceFile,
          node,
          `${filePath}: silent catch must return a domain result, rethrow, diagnose, or explain an auditable non-critical fallback`,
        ),
      );
    }
    const forwarder = singleUseForwarder(node, sourceFile);
    if (forwarder && !hasForwardingBoundaryComment(node, sourceFile)) {
      problems.push(
        at(
          sourceFile,
          node,
          `${filePath}: private single-use forwarder ${forwarder} must be inlined or marked with a forwarding-boundary reason`,
        ),
      );
    }
  });

  if (
    /catch(?:\s*\([^)]*\))?\s*\{\s*\}/u.test(source) &&
    !problems.some((problem) => problem.includes("silent catch"))
  ) {
    problems.push(`${filePath}: silent catch in embedded source must explain its auditable non-critical fallback`);
  }

  if (!isCompatibilityBoundary(filePath) && !isTestSource(filePath)) {
    for (const field of retiredCompatibilityFields) {
      if (new RegExp(`\\b${field}\\b`).test(source)) {
        problems.push(
          `${filePath}: retired compatibility field ${field} is only allowed at a migration/compat boundary`,
        );
      }
    }
    visit(sourceFile, (node) => {
      if (ts.isStringLiteralLike(node) && retiredCompatibilityValues.has(node.text)) {
        problems.push(
          at(
            sourceFile,
            node,
            `${filePath}: retired compatibility value ${node.text} is only allowed at a migration/compat boundary`,
          ),
        );
      }
      if (isDirectUiKindRead(node)) {
        problems.push(
          at(sourceFile, node, `${filePath}: legacy ui.kind must be read through a migration/compat boundary`),
        );
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const legacyName = compatibilityName(node.right);
        if (legacyName) {
          problems.push(
            at(
              sourceFile,
              node,
              `${filePath}: nullish fallback to ${legacyName} must be replaced by boundary migration`,
            ),
          );
        }
      }
    });
  }
  return problems;
}

export function compatibilityMetadataProblems(source, filePath) {
  const problems = [];
  const supports = /Supports:\s*([^\r\n]+)/i.exec(source)?.[1];
  if (!supports) {
    problems.push(`${filePath}: compatibility code must state the supported source version or upstream evidence`);
  } else if (!/\b\d+\.\d+\.\d+\b/u.test(supports)) {
    problems.push(`${filePath}: compatibility support must name an exact source version`);
  }
  const removal = /Remove when:\s*([^\r\n]+)/i.exec(source)?.[1];
  if (!removal) {
    problems.push(`${filePath}: compatibility code must state a removal condition`);
  } else if (!/\b\d+\.\d+\.\d+\b/u.test(removal)) {
    problems.push(`${filePath}: compatibility removal must name a target version`);
  }
  return problems;
}

export function unnecessaryConditionProblems(configPath, options = {}) {
  const analysisRoot = resolve(options.root ?? dirname(configPath));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    return [`${relative(projectRoot, configPath)}: cannot read TypeScript config for unnecessary-condition analysis`];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const problems = [];
  for (const sourceFile of program.getSourceFiles()) {
    const absolutePath = resolve(sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile ||
      !isInside(analysisRoot, absolutePath) ||
      absolutePath.includes(`${sep}node_modules${sep}`)
    )
      continue;
    const filePath = relative(analysisRoot, absolutePath);
    if (isCompatibilityBoundary(filePath) || isTestSource(filePath)) continue;
    visit(sourceFile, (node) => {
      const condition = conditionExpression(node);
      if (!condition) return;
      const allowsRuntimeBoundary = /runtime-boundary:\s*\S+/i.test(
        sourceFile.text.slice(node.getFullStart(), condition.getStart()),
      );
      visit(condition, (candidate) => {
        if (allowsRuntimeBoundary) return;
        const guarded = alwaysPresentObjectGuard(candidate, checker);
        if (guarded) {
          problems.push(
            at(
              sourceFile,
              candidate,
              `${filePath}: unnecessary defensive condition ${guarded}; the type already guarantees an object`,
            ),
          );
          return;
        }
        const comparison = unnecessaryNullishComparison(candidate, checker, sourceFile);
        if (comparison) {
          problems.push(
            at(
              sourceFile,
              candidate,
              `${filePath}: unnecessary nullish comparison ${comparison}; fix the type or remove the check`,
            ),
          );
        }
      });
    });
  }
  return problems;
}

function conditionExpression(node) {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression;
  if (ts.isConditionalExpression(node)) return node.condition;
  return undefined;
}

function isDirectResponsePipe(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "pipe"
  )
    return false;
  const destination = node.arguments[0];
  return ts.isIdentifier(destination) && ["res", "response"].includes(destination.text);
}

function alwaysPresentObjectGuard(node, checker) {
  if (!ts.isPrefixUnaryExpression(node) || node.operator !== ts.SyntaxKind.ExclamationToken) return undefined;
  const expression = unwrapParentheses(node.operand);
  const type = checker.getTypeAtLocation(expression);
  return !typeCanBeNullish(type) && typeIsObject(type, checker) ? `!${expression.getText()}` : undefined;
}

function unnecessaryNullishComparison(node, checker, sourceFile) {
  if (
    !ts.isBinaryExpression(node) ||
    ![
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind)
  )
    return undefined;
  const expression = isNullishExpression(node.left)
    ? node.right
    : isNullishExpression(node.right)
      ? node.left
      : undefined;
  if (!expression || typeCanBeNullish(checker.getTypeAtLocation(expression))) return undefined;
  return node.getText(sourceFile);
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isNullishExpression(node) {
  const expression = unwrapParentheses(node);
  return (
    expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expression) && expression.text === "undefined")
  );
}

function typeCanBeNullish(type) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
  return type.isUnion() && type.types.some(typeCanBeNullish);
}

function typeIsObject(type, checker) {
  if (type.isUnion()) return type.types.every((member) => typeIsObject(member, checker));
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? typeIsObject(constraint, checker) : false;
  }
  return Boolean(type.flags & ts.TypeFlags.Object);
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function singleUseForwarder(node, sourceFile) {
  let name;
  let parameters;
  let body;
  let method = false;
  if (ts.isFunctionDeclaration(node) && node.name && !hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
    name = node.name.text;
    parameters = node.parameters;
    body = node.body;
  } else if (
    ts.isMethodDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    hasModifier(node, ts.SyntaxKind.PrivateKeyword)
  ) {
    name = node.name.text;
    parameters = node.parameters;
    body = node.body;
    method = true;
  }
  if (!name || !body || body.statements.length !== 1) return undefined;
  const referenceScope = method && node.parent ? node.parent : sourceFile;
  if (forwarderReferenceCount(referenceScope, node, name, method) !== 1) return undefined;
  const parameterNames = parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
  );
  if (parameterNames.some((parameter) => !parameter)) return undefined;
  let expression = body.statements[0];
  if (ts.isReturnStatement(expression)) expression = expression.expression;
  else if (ts.isExpressionStatement(expression)) expression = expression.expression;
  if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
  if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== parameterNames.length)
    return undefined;
  return expression.arguments.every(
    (argument, index) => ts.isIdentifier(argument) && argument.text === parameterNames[index],
  )
    ? name
    : undefined;
}

function forwarderReferenceCount(scope, declaration, name, method) {
  let count = 0;
  visit(scope, (node) => {
    if (node === declaration) return;
    if (!method && ts.isIdentifier(node) && node.text === name && isValueReference(node)) {
      count += 1;
      return;
    }
    if (
      method &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === name &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      count += 1;
    }
  });
  return count;
}

function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  return true;
}

function hasAuditableCatchComment(node, sourceFile) {
  const text = node.block.getFullText(sourceFile);
  const comments = text.match(/\/\/[^\n]+|\/\*[\s\S]*?\*\//g) ?? [];
  return comments.some((comment) => {
    if (/\bnon-critical-fallback:\s*\S+/iu.test(comment)) return true;
    const explanation = comment.replace(/^\/\/?\*?|\*\/$/g, "").trim();
    return (
      explanation.length >= 20 &&
      /(?:already|authoritative|best[- ]effort|broken|cache|cannot|cleanup|continue|fallback|fail(?:s|ure)?|harmless|ignore|isolat|must never|non-critical|optional|partial|preserv|probe|race|retry|safe(?:ly)?|stale|status|unavailable|unsupported|bounded|可忽略|失败|降级|重试|缓存|安全|不影响)/iu.test(
        explanation,
      )
    );
  });
}

function catchHandlesFailure(node) {
  let handled = false;
  const catchName =
    node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
      ? node.variableDeclaration.name.text
      : undefined;
  visit(node.block, (child) => {
    if (ts.isThrowStatement(child) || ts.isReturnStatement(child)) handled = true;
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const targetName = assignmentTargetName(child.left);
      if (/(?:error|failure|failed|status|diagnostic)/i.test(targetName)) handled = true;
    }
    if (!ts.isCallExpression(child)) return;
    if (catchName && callUsesIdentifier(child, catchName)) handled = true;
    const callName = callExpressionName(child.expression);
    if (
      /(?:^|\.)(?:appendDiagnostic|applyFallback|bestEffort|diagnostic|dispatchFailure|emitDiagnostic|fail|fallback|handleError|logError|notifyFailure|recordDiagnostic|reject|reportError|resetAfterFailure|resolve|sendError|setError|showError|toastError|warn)$/i.test(
        callName,
      )
    ) {
      handled = true;
    }
    if (/^console\.(?:error|warn)$/i.test(callName)) handled = true;
  });
  return handled;
}

function callUsesIdentifier(node, name) {
  let found = false;
  for (const argument of node.arguments) {
    visit(argument, (child) => {
      if (ts.isIdentifier(child) && child.text === name) found = true;
    });
  }
  return found;
}

function callExpressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression))
    return `${callExpressionName(expression.expression)}.${expression.name.text}`;
  return "";
}

function assignmentTargetName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return "";
}

function isDirectUiKindRead(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "kind") return false;
  const expression = node.expression;
  return (
    (ts.isIdentifier(expression) && expression.text === "ui") ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === "ui")
  );
}

function compatibilityName(node) {
  if (ts.isIdentifier(node)) {
    return /^(?:legacy|old)[A-Z_]/.test(node.text) || retiredCompatibilityFields.includes(node.text)
      ? node.text
      : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    return /^(?:legacy|old)[A-Z_]/.test(name) || retiredCompatibilityFields.includes(name) ? name : undefined;
  }
  return undefined;
}

function hasForwardingBoundaryComment(node, sourceFile) {
  if (node.getFullStart() >= node.getStart()) return false;
  const comment = sourceFile.text.slice(node.getFullStart(), node.getStart());
  const reason = /forwarding-boundary:\s*([^\r\n*]+)/i.exec(comment)?.[1]?.trim();
  return Boolean(reason && reason.length >= 12 && /\s/u.test(reason));
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function at(sourceFile, node, message) {
  return `${message} (line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1})`;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function isCompatibilityBoundary(filePath) {
  const normalized = filePath.split(sep).join("/");
  return (
    normalized.includes("/migrations/") || normalized.includes("/compat/") || /\.compat\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function isTestSource(filePath) {
  const normalized = filePath.split(sep).join("/");
  return normalized.includes("/tests/") || normalized.startsWith("src/tests/");
}

function sourceFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      (root.endsWith(`${sep}src`) && entry.name === "tests")
    )
      continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}
