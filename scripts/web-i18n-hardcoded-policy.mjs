import { relative } from "node:path";

export function isGuardedWebSourceFile(sourceRoot, path) {
  const rel = relative(sourceRoot, path);
  if (!rel || rel.startsWith("..")) return false;
  return path.endsWith(".tsx") || /(?:^|[/\\])[^/\\]*model[^/\\]*\.ts$/i.test(path);
}

export function normalizeRepositoryPath(path) {
  return path.replaceAll("\\", "/");
}
