import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, opendirSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalPortableRelativePath, portablePathCollisionKey } from "../app-builder/portable-path.js";
import type { AppReleaseBuildBudget } from "./app-release-build-budget.js";
import { compareUtf8Bytes } from "./utf8-byte-order.js";

const MAX_BUILD_OUTPUT_ENTRIES = 25_000;
const MAX_BUILD_OUTPUT_FILES = 5_000;
const MAX_BUILD_OUTPUT_DEPTH = 64;
const MAX_BUILD_OUTPUT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BUILD_OUTPUT_TOTAL_BYTES = 256 * 1024 * 1024;

interface PlannedBuildOutputDirectory {
  path: string;
  mode: number;
}

interface PlannedBuildOutputFile {
  path: string;
  mode: number;
  size: number;
  sha256: string;
  source: FileFingerprint;
}

interface FileFingerprint {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface AppReleaseBuildOutputPlan {
  outputs: string[];
  directories: PlannedBuildOutputDirectory[];
  files: PlannedBuildOutputFile[];
  entryCount: number;
  totalBytes: number;
}

export function planAppReleaseBuildOutputs(input: {
  appRoot: string;
  outputs: string[];
  budget: AppReleaseBuildBudget;
}): AppReleaseBuildOutputPlan {
  const appRoot = resolve(input.appRoot);
  const directories: PlannedBuildOutputDirectory[] = [];
  const files: PlannedBuildOutputFile[] = [];
  const portablePaths = new Map<string, string>();
  let entryCount = 0;
  let totalBytes = 0;

  const visit = (path: string, relativePath: string): void => {
    input.budget.checkpoint();
    const depth = relativePath.split("/").length;
    if (depth > MAX_BUILD_OUTPUT_DEPTH) {
      throw new Error(`app_release_local_build_output_depth_exceeded:${relativePath}`);
    }
    entryCount += 1;
    if (entryCount > MAX_BUILD_OUTPUT_ENTRIES) {
      throw new Error("app_release_local_build_output_entry_count_exceeded");
    }
    assertPortableOutputPath(relativePath, portablePaths);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`app_release_local_build_output_symlink:${relativePath}`);
    }
    if (stat.isFile()) {
      if (stat.size > MAX_BUILD_OUTPUT_FILE_BYTES) {
        throw new Error(`app_release_local_build_output_file_too_large:${relativePath}`);
      }
      if (files.length >= MAX_BUILD_OUTPUT_FILES) {
        throw new Error("app_release_local_build_output_file_count_exceeded");
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_BUILD_OUTPUT_TOTAL_BYTES) {
        throw new Error("app_release_local_build_output_too_large");
      }
      files.push({
        path: relativePath,
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: sha256File(path, relativePath, stat, input.budget),
        source: fileFingerprint(stat),
      });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`app_release_local_build_output_entry_type:${relativePath}`);
    }
    directories.push({ path: relativePath, mode: stat.mode & 0o777 });
    const directory = opendirSync(path);
    const names: string[] = [];
    try {
      for (;;) {
        input.budget.checkpoint();
        const entry = directory.readSync();
        if (!entry) break;
        // Reserve the entry before retaining its name. This makes the entry
        // budget an actual memory bound even for one enormous directory.
        entryCount += 1;
        if (entryCount > MAX_BUILD_OUTPUT_ENTRIES) {
          throw new Error("app_release_local_build_output_entry_count_exceeded");
        }
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    names.sort(compareUtf8Bytes);
    for (const name of names) {
      visitReserved(join(path, name), `${relativePath}/${name}`);
    }
  };

  const visitReserved = (path: string, relativePath: string): void => {
    entryCount -= 1;
    visit(path, relativePath);
  };

  for (const output of input.outputs) {
    input.budget.checkpoint();
    const outputPath = resolveInside(appRoot, output);
    try {
      visit(outputPath, output);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new Error(`app_release_local_build_output_missing:${output}`);
      }
      throw error;
    }
  }
  directories.sort(
    (left, right) => pathDepth(left.path) - pathDepth(right.path) || compareUtf8Bytes(left.path, right.path),
  );
  files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  input.budget.checkpoint();
  return {
    outputs: [...input.outputs],
    directories,
    files,
    entryCount,
    totalBytes,
  };
}

export function appReleaseBuildOutputPlanForOutput(
  plan: AppReleaseBuildOutputPlan,
  output: string,
): AppReleaseBuildOutputPlan {
  const prefix = `${output}/`;
  const directories = plan.directories.filter((item) => item.path === output || item.path.startsWith(prefix));
  const files = plan.files.filter((item) => item.path === output || item.path.startsWith(prefix));
  return {
    outputs: [output],
    directories,
    files,
    entryCount: directories.length + files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
}

export function copyAppReleaseBuildOutputPlan(input: {
  sourceRoot: string;
  targetRoot: string;
  plan: AppReleaseBuildOutputPlan;
  budget: AppReleaseBuildBudget;
}): void {
  const sourceRoot = resolve(input.sourceRoot);
  const targetRoot = resolve(input.targetRoot);
  for (const directory of input.plan.directories) {
    input.budget.checkpoint();
    const target = resolveInside(targetRoot, directory.path);
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  for (const file of input.plan.files) {
    input.budget.checkpoint();
    const source = resolveInside(sourceRoot, file.path);
    const before = lstatSync(source);
    if (!before.isFile() || !sameFileFingerprint(file.source, before)) {
      throw new Error(`app_release_local_build_output_changed:${file.path}`);
    }
    const target = resolveInside(targetRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, file.mode);
    const after = lstatSync(source);
    if (!after.isFile() || !sameFileFingerprint(file.source, after)) {
      throw new Error(`app_release_local_build_output_changed:${file.path}`);
    }
    input.budget.checkpoint();
  }
  for (const directory of [...input.plan.directories].reverse()) {
    input.budget.checkpoint();
    chmodSync(resolveInside(targetRoot, directory.path), directory.mode);
  }
}

export function sameAppReleaseBuildOutputPlan(
  expected: AppReleaseBuildOutputPlan,
  actual: AppReleaseBuildOutputPlan,
): boolean {
  return JSON.stringify(stableOutputPlan(expected)) === JSON.stringify(stableOutputPlan(actual));
}

function assertPortableOutputPath(path: string, paths: Map<string, string>): void {
  const canonical = canonicalPortableRelativePath(path);
  if (!canonical || path.includes("\\") || canonical !== path) {
    throw new Error(`app_release_local_build_output_path_collision:${path}`);
  }
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const spelling = segments.slice(0, index + 1).join("/");
    const key = portablePathCollisionKey(spelling);
    const existing = paths.get(key);
    if (existing && existing !== spelling) {
      throw new Error(`app_release_local_build_output_path_collision:${path}`);
    }
    paths.set(key, spelling);
  }
}

function sha256File(path: string, relativePath: string, expected: Stats, budget: AppReleaseBuildBudget): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      budget.checkpoint();
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (!after.isFile() || !sameFileFingerprint(fileFingerprint(expected), after)) {
    throw new Error(`app_release_local_build_output_changed:${relativePath}`);
  }
  return hash.digest("hex");
}

function stableOutputPlan(plan: AppReleaseBuildOutputPlan): unknown {
  return {
    outputs: plan.outputs,
    directories: plan.directories.map(({ path, mode }) => ({ path, mode })),
    files: plan.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })),
    entryCount: plan.entryCount,
    totalBytes: plan.totalBytes,
  };
}

function fileFingerprint(stat: Stats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileFingerprint(expected: FileFingerprint, actual: Stats): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs
  );
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function resolveInside(root: string, value: string): string {
  const target = resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || resolve(root, pathFromRoot) !== target) {
    throw new Error(`app_release_local_build_path_invalid:${value}`);
  }
  return target;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
