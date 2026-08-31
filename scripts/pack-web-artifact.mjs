import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const scriptPath = fileURLToPath(import.meta.url);
const webPackageTargets = {
  backend: {
    artifactFileName: (version) => `opengrove-${version}.tgz`,
    build: packBackend,
  },
  frontend: {
    artifactFileName: (version) => `opengrove-web-${version}.tar.gz`,
    build: packWeb,
  },
};

export function artifactFileName(target, version) {
  return resolveTarget(target).artifactFileName(version);
}

export function parsePackArguments(argv, root = projectRoot) {
  const [target, ...options] = argv;
  resolveTarget(target);

  let outputDir = resolve(root, "release/web");
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--output-dir") {
      const value = options[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-dir requires a directory");
      outputDir = resolve(root, value);
      index += 1;
      continue;
    }
    if (option.startsWith("--output-dir=")) {
      const value = option.slice("--output-dir=".length);
      if (!value) throw new Error("--output-dir requires a directory");
      outputDir = resolve(root, value);
      continue;
    }
    throw new Error(`Unknown Web package option: ${option}`);
  }

  assertSafeOutputDir(root, outputDir);
  return { target, outputDir };
}

export async function validateWebBuild(root, expectedVersion) {
  const webDist = join(root, "web-dist");
  const indexPath = join(webDist, "index.html");
  const versionPath = join(webDist, "version.json");
  const assetsPath = join(webDist, "assets");
  await Promise.all([
    requireFile(indexPath, "web-dist/index.html"),
    requireFile(versionPath, "web-dist/version.json"),
    access(assetsPath, constants.R_OK),
  ]);
  const assets = await readdir(assetsPath);
  if (assets.length === 0) throw new Error("web-dist/assets must not be empty");

  const metadata = parseJson(await readFile(versionPath, "utf8"), "web-dist/version.json");
  validateWebMetadata(metadata, expectedVersion, "web-dist/version.json");
  return { buildId: metadata.buildId, packageVersion: metadata.packageVersion };
}

async function main() {
  const { target, outputDir } = parsePackArguments(process.argv.slice(2));
  const packageJson = parseJson(await readFile(join(projectRoot, "package.json"), "utf8"), "package.json");
  if (packageJson.name !== "opengrove" || typeof packageJson.version !== "string") {
    throw new Error("package.json must contain the OpenGrove package name and version");
  }

  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(join(outputDir, ".web-package-"));
  let operationError;
  try {
    const artifactPath = await resolveTarget(target).build(stagingDir, packageJson.version);
    const destination = join(outputDir, artifactFileName(target, packageJson.version));
    await replaceFile(artifactPath, destination);
    const [bytes, digest] = await Promise.all([
      stat(destination).then((info) => info.size),
      readFile(destination).then((contents) => createHash("sha256").update(contents).digest("hex")),
    ]);
    console.log(`Created ${destination}`);
    console.log(`Size: ${bytes} bytes`);
    console.log(`SHA256: ${digest}`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      removeTemporaryTree(stagingDir);
    } catch (cleanupError) {
      if (!operationError) throw cleanupError;
      console.warn(`Could not remove temporary Web package directory ${stagingDir}: ${errorMessage(cleanupError)}`);
    }
  }
}

async function packBackend(stagingDir, version) {
  console.log("Building OpenGrove Backend and embedded Web assets...");
  runNodePackageManager("npm", ["run", "build"]);
  const webMetadata = await validateWebBuild(projectRoot, version);
  console.log(`Embedded Web build: ${webMetadata.buildId}`);
  runNodePackageManager("npm", ["pack", "--ignore-scripts", "--pack-destination", stagingDir]);
  const artifactPath = join(stagingDir, artifactFileName("backend", version));
  await validateBackendArtifact(artifactPath, version);
  return artifactPath;
}

async function packWeb(stagingDir, version) {
  console.log("Building OpenGrove Web assets...");
  runNodePackageManager("npm", ["run", "build:web"]);
  const metadata = await validateWebBuild(projectRoot, version);
  console.log(`Web build: ${metadata.buildId}`);
  const artifactPath = join(stagingDir, artifactFileName("frontend", version));
  run("tar", ["-C", join(projectRoot, "web-dist"), "-czf", artifactPath, "."]);
  await validateFrontendArtifact(artifactPath, version);
  return artifactPath;
}

async function validateBackendArtifact(artifactPath, expectedVersion) {
  await requireFile(artifactPath, artifactFileName("backend", expectedVersion));
  const entries = new Set(run("tar", ["-tzf", artifactPath], { capture: true }).split(/\r?\n/u));
  for (const required of [
    "package/package.json",
    "package/dist/cli.js",
    "package/web-dist/index.html",
    "package/web-dist/version.json",
  ]) {
    if (!entries.has(required)) throw new Error(`Backend package is missing ${required}`);
  }

  const metadata = parseJson(
    run("tar", ["-xOzf", artifactPath, "package/package.json"], { capture: true }),
    "package/package.json",
  );
  if (metadata.name !== "opengrove" || metadata.version !== expectedVersion) {
    throw new Error(`Backend package identity must be opengrove@${expectedVersion}`);
  }
}

export async function validateFrontendArtifact(artifactPath, expectedVersion) {
  await requireFile(artifactPath, artifactFileName("frontend", expectedVersion));
  const archiveEntries = run("tar", ["-tzf", artifactPath], { capture: true }).split(/\r?\n/u).filter(Boolean);
  const normalizedEntries = new Set(archiveEntries.map(normalizeArchiveEntry));
  for (const required of ["index.html", "version.json"]) {
    if (!normalizedEntries.has(required)) throw new Error(`Frontend package is missing ${required}`);
  }
  if (![...normalizedEntries].some((entry) => entry.startsWith("assets/") && entry !== "assets/")) {
    throw new Error("Frontend package must contain built assets");
  }

  const versionEntry = archiveEntries.find((entry) => normalizeArchiveEntry(entry) === "version.json");
  const metadata = parseJson(run("tar", ["-xOzf", artifactPath, versionEntry], { capture: true }), "version.json");
  validateWebMetadata(metadata, expectedVersion, "Frontend package version.json");
}

async function requireFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`${label} must be a non-empty file`);
}

export async function replaceFile(
  source,
  destination,
  { move = rename, remove = rm, inspect = stat, warn = console.warn } = {},
) {
  try {
    await move(source, destination);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    const destinationInfo = await inspect(destination).catch((inspectError) => {
      if (inspectError?.code === "ENOENT") return undefined;
      throw inspectError;
    });
    if (!destinationInfo?.isFile()) throw error;

    const backupPath = join(dirname(destination), `.${basename(destination)}.previous-${randomUUID()}`);
    let previousArtifactMoved = false;
    try {
      await move(destination, backupPath);
      previousArtifactMoved = true;
      await move(source, destination);
    } catch (replacementError) {
      if (!previousArtifactMoved) throw replacementError;
      try {
        await move(backupPath, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [replacementError, restoreError],
          `Could not replace ${destination}; the previous artifact remains at ${backupPath}`,
        );
      }
      throw replacementError;
    }

    try {
      await remove(backupPath, { force: true });
    } catch (cleanupError) {
      warn(`Previous Web package backup remains at ${backupPath}: ${errorMessage(cleanupError)}`);
    }
  }
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
  return capture ? result.stdout.trim() : "";
}

function runNodePackageManager(manager, args) {
  const invocation = nodePackageManagerInvocation(manager, args);
  return run(invocation.command, invocation.args);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
}

function assertSafeOutputDir(root, outputDir) {
  for (const generatedDirName of ["dist", "web-dist", "desktop-dist"]) {
    const generatedDir = resolve(root, generatedDirName);
    const relation = relative(generatedDir, outputDir);
    const insideGeneratedDir =
      relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
    if (insideGeneratedDir) {
      throw new Error(`Web package output directory must not be inside ${generatedDirName}/`);
    }
  }
}

function validateWebMetadata(metadata, expectedVersion, label) {
  if (metadata.packageVersion !== expectedVersion) {
    throw new Error(`${label} packageVersion is ${metadata.packageVersion ?? "missing"}; expected ${expectedVersion}`);
  }
  if (typeof metadata.buildId !== "string" || metadata.buildId.length === 0) {
    throw new Error(`${label} must contain a buildId`);
  }
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/^\.\//u, "");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveTarget(target) {
  const definition = webPackageTargets[target];
  if (!definition) throw new Error("Web package target must be backend or frontend");
  return definition;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
