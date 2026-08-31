import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const scanRoots = ["src", "web/src", "desktop"].map((path) => join(projectRoot, path));
const allowedRoots = [join(projectRoot, "src", "localization"), join(projectRoot, "web", "src", "locales")];
const forbiddenLocaleSyntax = [
  /(?:===|!==|==|!=)\s*["'](?:en|zh-CN)["']|["'](?:en|zh-CN)["']\s*(?:===|!==|==|!=)/g,
  /\bcase\s+["'](?:en|zh-CN)["']\s*:/g,
  /\.startsWith\(\s*["'](?:zh|en)(?:[-_]["']|["'])/g,
  /\{\s*(?:en|["']en["'])\s*:[\s\S]{0,500}?["']zh-CN["']\s*:[\s\S]{0,500}?\}\s*\[[^\]]+\]/g,
];
const violations = [];

for (const root of scanRoots) {
  for (const path of filesUnder(root)) {
    if (![".ts", ".tsx"].includes(extname(path))) continue;
    if (allowedRoots.some((allowed) => isPathInside(path, allowed))) continue;
    const projectPath = relative(projectRoot, path);
    const segments = projectPath.split(/[\\/]/);
    if (segments.includes("tests") || /(?:^|[\\/])[^\\/]*test[^\\/]*\.(?:ts|tsx)$/.test(projectPath)) continue;
    const source = readFileSync(path, "utf8");
    for (const pattern of forbiddenLocaleSyntax) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        if (isCommentOnlyLine(source, line)) continue;
        violations.push(`${projectPath}:${line}: ${singleLine(match[0])}`);
      }
    }
  }
}

const forbiddenWebImport = /from\s+["'][^"']*src\/localization\/locale-registry(?:\.[^"']+)?["']/;
for (const path of filesUnder(join(projectRoot, "web", "src"))) {
  if (![".ts", ".tsx"].includes(extname(path))) continue;
  const source = readFileSync(path, "utf8");
  const match = source.match(forbiddenWebImport);
  if (match) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(
      `${relative(projectRoot, path)}:${line}: browser code must import the protocol locale-registry subpath`,
    );
  }
}

const coreBarrelPath = join(projectRoot, "src", "core.ts");
const coreBarrelSource = readFileSync(coreBarrelPath, "utf8");
const localizationBarrelExport = coreBarrelSource.match(
  /export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["'][^"']*localization\//,
);
if (localizationBarrelExport) {
  const line = coreBarrelSource.slice(0, localizationBarrelExport.index).split("\n").length;
  violations.push(`src/core.ts:${line}: core barrel must not re-export the localization implementation`);
}

if (violations.length) {
  console.error("Business code must select locale data through the shared registry/catalogs:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("locale architecture guard ok (no business-level en/zh-CN comparisons)");
}

function isPathInside(path, root) {
  const child = relative(root, path);
  return child === "" || Boolean(child && !child.startsWith("..") && !isAbsolute(child));
}

function isCommentOnlyLine(source, lineNumber) {
  const line = source.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
  return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("*/");
}

function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function* filesUnder(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      yield* filesUnder(path);
    } else {
      yield path;
    }
  }
}
