import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { isStoreAppPythonLauncher, relocatedStoreAppPythonFile } from "./store-app-layout-v2-python.js";

/**
 * Supports: OpenGrove <=0.6.5 Store App layouts.
 * Remove when: all supported upgrade sources already use layout v2 (OpenGrove >=0.6.6).
 * https://github.com/open-grove/opengrove/issues/102
 * Like Cherry Studio userDataRelocation, copy links themselves and rebase moved targets.
 * Programs and Workspaces move separately here, so relative links must also be remapped.
 */
export interface StoreAppPathRelocation {
  source: string;
  target: string;
}

export interface StoreAppRelocations {
  mappings: StoreAppPathRelocation[];
  legacyRoots: string[];
}

export function storeAppPathRelocations(paths: StoreAppPathRelocation[], legacyRoots: string[]): StoreAppRelocations {
  const mappings = paths
    .flatMap(({ source, target }) =>
      [...new Set([resolve(source), resolve(realpathSync.native(source))])].map((source) => ({
        source,
        target: resolve(target),
      })),
    )
    .sort((left, right) => right.source.length - left.source.length);
  return {
    mappings,
    legacyRoots: legacyRoots.flatMap((root) => {
      try {
        return [resolve(root), realpathSync.native(root)];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [resolve(root)];
      }
    }),
  };
}

function mappedPath(path: string, paths: StoreAppRelocations): string | undefined {
  for (const mapping of paths.mappings) {
    const child = relative(toNamespacedPath(mapping.source), toNamespacedPath(path));
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return join(mapping.target, child);
  }
  return undefined;
}

function mappedReferenceTarget(
  oldTarget: string,
  paths: StoreAppRelocations,
  kind: "link" | "path",
): string | undefined {
  let effectiveTarget = oldTarget;
  let target = mappedPath(oldTarget, paths);
  if (!target) {
    try {
      // Resolve aliases to a moved tree, but retain the spelling of external targets
      // (notably Homebrew's stable interpreter link). Never walk their contents.
      effectiveTarget = realpathSync.native(oldTarget);
      target = mappedPath(effectiveTarget, paths);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
      // Dangling and cyclic links are valid filesystem entries, copied without traversal.
    }
  }
  if (
    !target &&
    paths.legacyRoots.some((root) =>
      [oldTarget, effectiveTarget].some((value) => {
        const child = relative(toNamespacedPath(root), toNamespacedPath(value));
        return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
      }),
    )
  )
    throw new Error(`store_app_layout_unmapped_legacy_${kind}`);
  return target;
}

export function relocatedStoreAppLink(source: string, link: string, paths: StoreAppRelocations): string {
  const oldTarget = resolve(dirname(source), link);
  const target = mappedReferenceTarget(oldTarget, paths, "link");
  if (isAbsolute(link)) return target ?? link;
  const destination = mappedPath(source, paths);
  if (!destination) throw new Error("store_app_layout_relocation_path_invalid");
  return relative(toNamespacedPath(dirname(destination)), toNamespacedPath(target ?? oldTarget)) || ".";
}

/** Inspect entry types, links and generated launcher paths before copying either tree. */
export function inspectStoreAppRelocationTree(
  root: string,
  paths: StoreAppRelocations,
  excludedRelativePath?: string,
): void {
  visitTree(root, excludedRelativePath, (path, stat) => {
    if (stat.isSymbolicLink()) relocatedStoreAppLink(path, readlinkSync(path), paths);
    else if (stat.isFile() && isStoreAppPythonLauncher(path)) relocatedStoreAppFile(path, readFileSync(path), paths);
  });
}

export function relocatedStoreAppFile(source: string, content: Buffer, paths: StoreAppRelocations): Buffer {
  const target = mappedPath(source, paths);
  if (!target) throw new Error("store_app_layout_relocation_path_invalid");
  return relocatedStoreAppPythonFile(source, target, content, (path) =>
    isAbsolute(path) ? (mappedReferenceTarget(path, paths, "path") ?? path) : path,
  );
}

/** Only called on our fresh staging copy, never on a source or an unowned pre-existing target. */
export function relocateCopiedStoreAppTree(
  sourceRoot: string,
  stagingRoot: string,
  paths: StoreAppRelocations,
  excludedRelativePath?: string,
): void {
  visitTree(stagingRoot, excludedRelativePath, (path, stat) => {
    const source = join(sourceRoot, relative(stagingRoot, path));
    if (stat.isFile() && isStoreAppPythonLauncher(source)) {
      const content = readFileSync(path);
      const updated = relocatedStoreAppFile(source, content, paths);
      if (!updated.equals(content)) writeFileSync(path, updated);
    }
    if (!stat.isSymbolicLink()) return;
    const link = readlinkSync(path);
    const target = relocatedStoreAppLink(source, link, paths);
    if (target === link) return;
    let type: "junction" | "file" | undefined;
    if (process.platform === "win32") {
      try {
        type = statSync(source).isDirectory() ? "junction" : "file";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
        type = "file";
      }
    }
    unlinkSync(path);
    symlinkSync(target, path, type);
  });
}

function visitTree(
  root: string,
  excludedRelativePath: string | undefined,
  visit: (path: string, stat: Stats) => void,
): void {
  const excluded = excludedRelativePath ? resolve(root, excludedRelativePath) : undefined;
  const walk = (path: string): void => {
    if (path === excluded) return;
    const stat = lstatSync(path);
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error("store_app_layout_entry_type_invalid");
    visit(path, stat);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(resolve(root));
}
