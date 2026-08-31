export function desktopAsarLookupPath(path) {
  return path.replace(/^[\\/]+/, "");
}

export function normalizeDesktopAsarPath(path) {
  return desktopAsarLookupPath(path).replaceAll("\\", "/");
}
