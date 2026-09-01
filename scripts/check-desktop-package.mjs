import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPossibleDesktopPackageSecret } from "./desktop-package-secret-scan.mjs";
import yaml from "js-yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const requiredPaths = [
  "desktop-dist/main.cjs",
  "desktop-dist/preload.cjs",
  "dist/protocol/index.js",
  "dist/client/index.js",
  "dist/agent-protocol/index.js",
  "dist/agent-protocol/locale-registry.js",
  "dist/server/desktop-bridge-entry.js",
  "web-dist/index.html",
  "web-dist/version.json",
  "src/skills/bundled/opengrove-app-builder/SKILL.md",
  "electron-builder.yml",
  "build/app-update.yml",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
  "node_modules/yaml/dist/doc/directives.js",
];

const forbiddenNamePattern =
  /(^|[\\/])(\.env(?:\..*)?|data|node_modules|docs[\\/]reference[\\/]kernel-integration-references)([\\/]|$)/;
const excludedPackageInputPattern = /(^|[\\/])dist[\\/](?:examples|tests)(?:[\\/]|$)|\.map$/;
const errors = [];
for (const path of requiredPaths) {
  if (!existsSync(join(projectRoot, path))) {
    errors.push(`missing required desktop package input: ${path}`);
  }
}

const webIndexPath = join(projectRoot, "web-dist", "index.html");
if (existsSync(webIndexPath)) {
  const webIndex = readFileSync(webIndexPath, "utf8");
  const entryMatch = /<script[^>]+type="module"[^>]+src="([^"]+)"|<script[^>]+src="([^"]+)"[^>]+type="module"/u.exec(
    webIndex,
  );
  const entryUrl = entryMatch?.[1] ?? entryMatch?.[2] ?? "";
  const entryPath = entryUrl.replace(/^\/ui\//u, "").replace(/[?#].*$/u, "");
  if (!entryPath || !existsSync(join(projectRoot, "web-dist", entryPath))) {
    errors.push(`web-dist/index.html must reference an existing Vite module entry; received ${entryUrl || "none"}`);
  }
}

const electronBuilderConfig = readFileSync(join(projectRoot, "electron-builder.yml"), "utf8");
const parsedElectronBuilderConfig = yaml.load(electronBuilderConfig);
const configuredProtocolSchemes =
  parsedElectronBuilderConfig?.protocols?.flatMap((entry) => entry?.schemes ?? []) ?? [];
if (!configuredProtocolSchemes.includes("opengrove")) {
  errors.push("electron-builder.yml must register the opengrove desktop URL scheme");
}
if (packageJson.imports?.["#agent-protocol"]?.default !== "./dist/agent-protocol/index.js") {
  errors.push("the desktop runtime must resolve #agent-protocol from the bundled dist tree");
}
if (packageJson.imports?.["#protocol"]?.default !== "./dist/protocol/index.js") {
  errors.push("the desktop runtime must resolve #protocol from the bundled dist tree");
}
if (packageJson.imports?.["#client"]?.default !== "./dist/client/index.js") {
  errors.push("the desktop runtime must resolve #client from the bundled dist tree");
}
if (packageJson.imports?.["#agent-protocol/locale-registry"]?.default !== "./dist/agent-protocol/locale-registry.js") {
  errors.push("the desktop runtime must resolve #agent-protocol/locale-registry from the bundled dist tree");
}
if (/src\/apps\/bundled|src\\apps\\bundled/.test(electronBuilderConfig)) {
  errors.push(
    "electron-builder.yml must not ship src/apps/bundled; default Apps are installed from App Store after login",
  );
}
if (/!\*\*\/\*token\*/.test(electronBuilderConfig)) {
  errors.push(
    "electron-builder.yml must not use a broad *token* exclusion; it can remove required compiled runtime modules",
  );
}
if (/!node_modules\/\*\*\/docs?\/\*\*/.test(electronBuilderConfig)) {
  errors.push(
    "electron-builder.yml must not exclude generic node_modules doc/docs directories; packages such as yaml store runtime modules there",
  );
}
if (!/from:\s*build\/app-update\.yml[\s\S]*to:\s*app-update\.yml/.test(electronBuilderConfig)) {
  errors.push("electron-builder.yml must package build/app-update.yml as an extra resource");
}
for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
  if (!parsedElectronBuilderConfig?.files?.includes(path)) {
    errors.push(`electron-builder.yml must package ${path}`);
  }
}
const expectedElectronFuses = {
  runAsNode: true,
  enableCookieEncryption: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
};
for (const [name, expected] of Object.entries(expectedElectronFuses)) {
  if (parsedElectronBuilderConfig?.electronFuses?.[name] !== expected) {
    errors.push(`electron-builder.yml must set electronFuses.${name}=${expected}`);
  }
}

const releaseBuilderConfig = require(join(projectRoot, "electron-builder.release.cjs"));
if (releaseBuilderConfig.extraMetadata?.opengroveOfficialRelease !== true) {
  errors.push("official desktop release config must set opengroveOfficialRelease=true");
}
if (releaseBuilderConfig.npmRebuild !== false) {
  errors.push("parallel desktop release builds require npmRebuild=false");
}
checkPackagedNativeAddons();

for (const path of ["desktop-dist", "web-dist", "dist", "electron-builder.yml"]) {
  const fullPath = join(projectRoot, path);
  if (existsSync(fullPath)) {
    scan(fullPath);
  }
}

scan(join(projectRoot, "src/skills/bundled"));

if (errors.length) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

function scan(path) {
  const relativePath = relative(projectRoot, path);
  if (excludedPackageInputPattern.test(relativePath)) return;
  if (forbiddenNamePattern.test(relativePath)) {
    errors.push(`forbidden desktop package path: ${relativePath}`);
    return;
  }
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const child of readdirSync(path)) {
      scan(join(path, child));
    }
    return;
  }
  if (!stats.isFile() || stats.size > 1_000_000) return;
  const content = readFileSync(path, "utf8");
  if (containsPossibleDesktopPackageSecret(content)) {
    errors.push(`possible secret in desktop package input: ${relativePath}`);
  }
}

function checkPackagedNativeAddons() {
  const lockPath = join(projectRoot, "package-lock.json");
  if (!existsSync(lockPath)) {
    errors.push("parallel desktop release builds require package-lock.json for native addon checks");
    return;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!packagePath.startsWith("node_modules/") || metadata?.dev === true) continue;
    const packageRoot = join(projectRoot, packagePath);
    if (!existsSync(packageRoot)) continue;
    const nativeAddon = findNativeAddon(packageRoot);
    if (nativeAddon) {
      errors.push(
        `packaged native Node addon requires per-architecture dependency staging before parallel release builds: ${relative(projectRoot, nativeAddon)}`,
      );
    }
  }
}

function findNativeAddon(path) {
  const stats = statSync(path);
  if (stats.isFile()) return path.endsWith(".node") ? path : undefined;
  if (!stats.isDirectory()) return undefined;
  for (const child of readdirSync(path)) {
    if (child === "node_modules") continue;
    const match = findNativeAddon(join(path, child));
    if (match) return match;
  }
  return undefined;
}
