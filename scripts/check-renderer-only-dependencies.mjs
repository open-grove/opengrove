import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const rendererOnlyDependencies = [
  "@base-ui/react",
  "@dicebear/core",
  "@dicebear/styles",
  "@milkdown/crepe",
  "@milkdown/kit",
  "@rc-component/qrcode",
  "@vidstack/react",
  "avvvatars-react",
  "react-markdown",
  "remark-gfm",
];

const projectRoot = resolve(import.meta.dirname, "..");

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const problems = [];
  for (const dependency of rendererOnlyDependencies) {
    if (packageJson.dependencies?.[dependency]) {
      problems.push(`${dependency} must not be a production dependency`);
    }
    if (!packageJson.devDependencies?.[dependency]) {
      problems.push(`${dependency} must remain available to the Vite renderer as a devDependency`);
    }
  }

  const sourceRoots = ["src", "desktop", "packages", "scripts"];
  for (const sourceRoot of sourceRoots) {
    for (const path of sourceFiles(join(projectRoot, sourceRoot))) {
      const source = readFileSync(path, "utf8");
      for (const dependency of rendererOnlyDependencies) {
        if (importsPackage(source, dependency)) {
          problems.push(`${relative(projectRoot, path)} imports renderer-only package ${dependency}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(`Renderer-only dependency boundary failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`renderer-only dependency boundary: ${rendererOnlyDependencies.join(", ")} are web-only devDependencies`);
}

export function importsPackage(source, packageName) {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*|import\\s*|require\\s*\\(\\s*)["']${escapedPackageName}(?:/[^"']*)?["']`,
  ).test(source);
}

function sourceFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}
