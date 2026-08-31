import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type AppBuildContractScaffoldErrorCode =
  | "app_release_build_contract_repair_conflict"
  | "app_release_build_contract_repair_failed";

export class AppBuildContractScaffoldError extends Error {
  constructor(readonly code: AppBuildContractScaffoldErrorCode) {
    super(code);
    this.name = "AppBuildContractScaffoldError";
  }
}

// Platform-owned static build contract for Apps that do not declare their own
// build yet. Existing source, output, and ignore files are never overwritten.
export function ensureAppBuildContract(target: string): void {
  try {
    const contractPath = join(target, ".opengrove-build.json");
    const contractEntry = entryKind(contractPath);
    if (contractEntry === "file") return;
    if (contractEntry !== "missing") throw repairConflict();
    assertPlatformBuildCanBeScaffolded(target);
    installPlatformBuildScaffold(target);
  } catch (error) {
    if (error instanceof AppBuildContractScaffoldError) throw error;
    throw new AppBuildContractScaffoldError("app_release_build_contract_repair_failed");
  }
}

export function defaultAppGitignore(): string {
  return [
    ".DS_Store",
    "__pycache__/",
    "*.py[cod]",
    ".venv/",
    "venv/",
    "node_modules/",
    ".env",
    ".env.*",
    "*.log",
    "workspace/*",
    "!workspace/runs/",
    "!workspace/runs/.gitkeep",
    "",
  ].join("\n");
}

function assertPlatformBuildCanBeScaffolded(target: string): void {
  const topLevelNames = readdirSync(target);
  if (
    topLevelNames.some(
      (name) =>
        name === "package.json" || name === "tsconfig.json" || /^(?:vite|webpack|rollup|rspack)\.config\./.test(name),
    )
  ) {
    throw repairConflict();
  }

  const buildPath = join(target, "build.mjs");
  const buildEntry = entryKind(buildPath);
  if (
    buildEntry !== "missing" &&
    (buildEntry !== "file" || readFileSync(buildPath, "utf8") !== platformBuildScript())
  ) {
    throw repairConflict();
  }

  for (const directory of ["web", "ui"] as const) {
    const directoryPath = join(target, directory);
    const directoryEntry = entryKind(directoryPath);
    if (directoryEntry !== "missing" && directoryEntry !== "directory") {
      throw repairConflict();
    }
    if (directoryEntry === "directory" && readdirSync(directoryPath).some((name) => name !== ".gitkeep")) {
      throw repairConflict();
    }
    const placeholderEntry = entryKind(join(directoryPath, ".gitkeep"));
    if (placeholderEntry !== "missing" && placeholderEntry !== "file") {
      throw repairConflict();
    }
  }

  const ignoreEntry = entryKind(join(target, ".gitignore"));
  if (ignoreEntry !== "missing" && ignoreEntry !== "file") throw repairConflict();
}

function installPlatformBuildScaffold(target: string): void {
  const stagingRoot = mkdtempSync(join(dirname(target), `.${basename(target)}-build-contract-`));
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const desiredFiles = new Map<string, string>([
    ["web/.gitkeep", ""],
    ["ui/.gitkeep", ""],
    ["build.mjs", platformBuildScript()],
    [".gitignore", defaultAppGitignore()],
    [
      ".opengrove-build.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workingDirectory: ".",
          inputs: ["web", "build.mjs"],
          outputs: ["ui"],
          commands: [["node", "build.mjs"]],
        },
        null,
        2,
      )}\n`,
    ],
  ]);

  try {
    for (const [relativePath, contents] of desiredFiles) {
      const stagedPath = join(stagingRoot, relativePath);
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(stagedPath, contents, "utf8");
    }
    for (const directory of ["web", "ui"]) {
      const directoryPath = join(target, directory);
      if (entryKind(directoryPath) === "missing") {
        mkdirSync(directoryPath);
        createdDirectories.push(directoryPath);
      }
    }
    for (const relativePath of desiredFiles.keys()) {
      const destination = join(target, relativePath);
      if (entryKind(destination) !== "missing") continue;
      // A hard link is an atomic create-if-absent operation on the same volume;
      // unlike rename it cannot overwrite a path created after preflight.
      linkSync(join(stagingRoot, relativePath), destination);
      createdFiles.push(destination);
    }
  } catch (error) {
    for (const filePath of createdFiles.reverse()) {
      try {
        unlinkSync(filePath);
      } catch {
        // Preserve the original failure; a later retry still fails closed.
      }
    }
    for (const directoryPath of createdDirectories.reverse()) {
      try {
        rmdirSync(directoryPath);
      } catch {
        // non-critical-fallback: preserve concurrently created content; the original failure remains authoritative.
      }
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function entryKind(path: string): "missing" | "file" | "directory" | "other" {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return "other";
    if (entry.isFile()) return "file";
    if (entry.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function repairConflict(): AppBuildContractScaffoldError {
  return new AppBuildContractScaffoldError("app_release_build_contract_repair_conflict");
}

function platformBuildScript(): string {
  return [
    'import { cpSync, mkdirSync, rmSync } from "node:fs";',
    "",
    'rmSync("ui", { recursive: true, force: true });',
    'mkdirSync("ui", { recursive: true });',
    'cpSync("web", "ui", { recursive: true });',
    "",
  ].join("\n");
}
