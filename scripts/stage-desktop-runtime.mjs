import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const nodeModulesRoot = join(projectRoot, "node_modules");
const anthropicRoot = join(nodeModulesRoot, "@anthropic-ai");
const minEngineBytes = 50_000_000;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  printHelp();
  process.exit(0);
}

const targets = parseTargets(args);
const rootPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const sdkVersion = resolveSdkVersion(rootPackage);
const staged = [];

if (!existsSync(join(anthropicRoot, "claude-agent-sdk", "package.json"))) {
  throw new Error("Missing @anthropic-ai/claude-agent-sdk. Run npm ci before staging desktop runtime packages.");
}
verifyAnthropicLicense(join(anthropicRoot, "claude-agent-sdk", "LICENSE.md"));

for (const target of targets) {
  staged.push(stageTarget(target, sdkVersion));
}

const manifestPath = join(projectRoot, ".opengrove", "desktop-runtime-stage.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      stagedAt: new Date().toISOString(),
      sdkVersion,
      targets: staged,
    },
    null,
    2,
  )}\n`,
);

console.log(`stage-desktop-runtime: staged ${staged.length} target(s)`);
for (const item of staged) {
  console.log(`- ${item.target}: ${item.packageName} (${Math.round(item.bytes / 1024 / 1024)} MB)`);
}

function parseTargets(values) {
  const explicit = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--target") {
      explicit.push(readRequired(values, ++index, value));
    } else if (value.startsWith("--target=")) {
      explicit.push(value.slice("--target=".length));
    } else if (value === "--platform") {
      const platform = readRequired(values, ++index, value);
      const arch = readOption(values, "--arch") ?? process.arch;
      explicit.push(`${platform}-${arch}`);
    } else if (value === "--arch") {
      index += 1;
    } else {
      throw new Error(`Unknown stage-desktop-runtime option: ${value}`);
    }
  }
  const normalized = (explicit.length ? explicit : ["current"]).flatMap(expandTargetAlias).map(normalizeTarget);
  return uniqueTargets(normalized);
}

function expandTargetAlias(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "current") return [`${process.platform}-${process.arch}`];
  if (normalized === "mac" || normalized === "macos" || normalized === "darwin" || normalized === "mac-universal") {
    return ["darwin-arm64", "darwin-x64"];
  }
  if (normalized === "linux") return ["linux-x64", "linux-arm64"];
  if (normalized === "windows" || normalized === "win" || normalized === "win32") return ["win32-x64"];
  if (normalized === "all") return ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
  return [value];
}

function normalizeTarget(value) {
  const match = /^(darwin|mac|macos|win32|windows|win|linux)[-_](x64|arm64)$/.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Invalid desktop runtime target "${value}". Expected darwin-arm64, darwin-x64, win32-x64, linux-x64, or linux-arm64.`,
    );
  }
  const platform =
    match[1] === "mac" || match[1] === "macos"
      ? "darwin"
      : match[1] === "windows" || match[1] === "win"
        ? "win32"
        : match[1];
  const arch = match[2];
  return { platform, arch, target: `${platform}-${arch}` };
}

function uniqueTargets(values) {
  const seen = new Set();
  return values.filter((target) => {
    if (seen.has(target.target)) return false;
    seen.add(target.target);
    return true;
  });
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readOption(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

function resolveSdkVersion(packageJson) {
  const declared = String(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"] || "").trim();
  if (/^\d+\.\d+\.\d+/.test(declared)) return declared;
  const installed = JSON.parse(readFileSync(join(anthropicRoot, "claude-agent-sdk", "package.json"), "utf8"));
  if (typeof installed.version === "string" && installed.version) return installed.version;
  throw new Error("Could not resolve @anthropic-ai/claude-agent-sdk version.");
}

function stageTarget(target, version) {
  const packageName = nativeSdkPackageName(target);
  const destination = join(anthropicRoot, packageName);
  if (!existsSync(destination)) {
    fetchPackage(packageName, version, destination);
  }
  const binaryPath = join(destination, target.platform === "win32" ? "claude.exe" : "claude");
  if (!existsSync(binaryPath)) {
    throw new Error(`Staged native Claude engine is missing: ${binaryPath}`);
  }
  verifyAnthropicLicense(join(destination, "LICENSE.md"));
  if (target.platform !== "win32") chmodSync(binaryPath, statSync(binaryPath).mode | 0o755);
  const bytes = statSync(binaryPath).size;
  if (bytes < minEngineBytes) {
    throw new Error(`Staged native Claude engine is unexpectedly small (${bytes} bytes): ${binaryPath}`);
  }
  return {
    target: target.target,
    packageName,
    binaryPath,
    bytes,
  };
}

function verifyAnthropicLicense(path) {
  if (!existsSync(path)) {
    throw new Error(`Staged Anthropic runtime is missing its license: ${path}`);
  }
  const license = readFileSync(path, "utf8");
  if (!license.includes("Anthropic PBC") || !license.includes("All rights reserved")) {
    throw new Error(`Staged Anthropic runtime has an unexpected license: ${path}`);
  }
}

function nativeSdkPackageName(target) {
  if (target.platform === "darwin") return `claude-agent-sdk-darwin-${target.arch}`;
  if (target.platform === "win32") return `claude-agent-sdk-win32-${target.arch}`;
  if (target.platform === "linux") return `claude-agent-sdk-linux-${target.arch}`;
  throw new Error(`Unsupported platform: ${target.platform}`);
}

function fetchPackage(packageName, version, destination) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-runtime-"));
  try {
    console.log(`Fetching @anthropic-ai/${packageName}@${version}`);
    const invocation = nodePackageManagerInvocation("npm", [
      "pack",
      `@anthropic-ai/${packageName}@${version}`,
      "--pack-destination",
      tempRoot,
    ]);
    execFileSync(invocation.command, invocation.args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tarball = readdirSync(tempRoot).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack did not produce a tarball for ${packageName}`);
    execFileSync("tar", ["-xzf", join(tempRoot, tarball), "-C", tempRoot], { stdio: "inherit" });
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(tempRoot, "package"), destination, { recursive: true });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function printHelp() {
  console.log(`Usage: node scripts/stage-desktop-runtime.mjs [--target TARGET ...]

Targets:
  current        Current process platform/arch
  mac            darwin-arm64 + darwin-x64
  linux          linux-x64 + linux-arm64
  windows        win32-x64
  all            mac + linux + win32-x64
  darwin-arm64   Specific platform/arch pair
  darwin-x64
  linux-x64
  linux-arm64
  win32-x64
`);
}
