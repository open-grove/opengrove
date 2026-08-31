import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { isGuardedWebSourceFile, normalizeRepositoryPath } from "./web-i18n-hardcoded-policy.mjs";

// This is a ratchet for likely user-visible literals, not a proof that every
// runtime string is localized. It covers TSX text/visible attributes/child
// expressions and conventional display fields/functions in *model.ts files.
// Dynamic strings assembled outside those UI-shaped contexts still require
// code review and pseudo-locale QA.
const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(projectRoot, "web/src");
const baselinePath = resolve(projectRoot, "scripts/web-i18n-hardcoded-baseline.json");
const writeBaseline = process.argv.includes("--write-baseline");
const visibleAttributes = new Set(["alt", "aria-label", "placeholder", "title"]);
const visibleModelProperties = new Set([
  "description",
  "detail",
  "label",
  "lastActive",
  "message",
  "name",
  "sourceLabel",
  "subtitle",
  "summary",
  "text",
  "title",
]);
const visibleModelFunctionName =
  /(description|detail|display|format|label|message|name|preview|status|summary|text|title)/i;

const files = await collectFiles(sourceRoot);
const findings = [];
for (const file of files) {
  const sourceText = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  visit(sourceFile, sourceFile, file);
}

const current = [...new Set(findings)].sort();
if (writeBaseline) {
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`wrote ${current.length} web i18n hardcoded baseline entries`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const baselineSet = new Set(baseline);
const currentSet = new Set(current);
const added = current.filter((entry) => !baselineSet.has(entry));
const removed = baseline.filter((entry) => !currentSet.has(entry));
if (added.length || removed.length) {
  if (added.length) {
    console.error("New user-visible TSX literals must use translation keys:");
    for (const entry of added) console.error(`  + ${entry}`);
  }
  if (removed.length) {
    console.error("Hardcoded baseline entries were removed; refresh the baseline to record the cleanup:");
    for (const entry of removed) console.error(`  - ${entry}`);
  }
  process.exit(1);
}

console.log(`web i18n hardcoded guard ok (${current.length} baseline entries)`);

async function collectFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collectFiles(path)));
    else if (entry.isFile() && isGuardedSourceFile(path)) output.push(path);
  }
  return output.sort();
}

function visit(sourceFile, node, file) {
  if (ts.isJsxText(node)) {
    record(file, "text", node.text);
  } else if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.text)) {
    const initializer = node.initializer;
    if (initializer && ts.isStringLiteral(initializer)) {
      record(file, `attr:${node.name.text}`, initializer.text);
    } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
      recordRenderedExpression(initializer.expression, file, `attr:${node.name.text}:expr`);
    }
  } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
    recordRenderedExpression(node.expression, file, "expr");
  } else if (
    !file.endsWith(".tsx") &&
    ts.isPropertyAssignment(node) &&
    visibleModelProperties.has(propertyName(node.name))
  ) {
    recordRenderedExpression(node.initializer, file, "model");
  } else if (!file.endsWith(".tsx") && ts.isReturnStatement(node) && node.expression && visibleModelReturn(node)) {
    recordRenderedExpression(node.expression, file, "model");
  }
  ts.forEachChild(node, (child) => visit(sourceFile, child, file));
}

function isGuardedSourceFile(path) {
  return isGuardedWebSourceFile(sourceRoot, path);
}

function visibleModelReturn(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) {
      return visibleModelFunctionName.test(functionName(current));
    }
    current = current.parent;
  }
  return false;
}

function recordRenderedExpression(node, file, kind) {
  if (ts.isStringLiteralLike(node)) {
    record(file, kind, node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    record(file, kind, templateStaticText(node));
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    recordRenderedExpression(node.expression, file, kind);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    recordRenderedExpression(node.whenTrue, file, kind);
    recordRenderedExpression(node.whenFalse, file, kind);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      recordRenderedExpression(node.right, file, kind);
      return;
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      recordRenderedExpression(node.left, file, kind);
      recordRenderedExpression(node.right, file, kind);
    }
  }
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : "";
}

function functionName(node) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) return node.name.text;
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : "";
}

function templateStaticText(node) {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("{value}");
}

function record(file, kind, value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || !/[A-Za-z\u3400-\u9fff]/u.test(normalized)) return;
  findings.push(`${normalizeRepositoryPath(relative(projectRoot, file))}|${kind}|${normalized}`);
}
