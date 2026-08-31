const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001f]/u;

/**
 * Canonical relative spelling accepted by contracts that must behave the same
 * on macOS, Linux, and Windows. Dot and duplicate-separator aliases collapse;
 * names that Windows rewrites or reserves are rejected instead of being given
 * a second meaning on another platform.
 */
export function canonicalPortableRelativePath(value: string): string | undefined {
  if (!value || value.includes("\0")) return undefined;
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/u.test(portable)) return undefined;
  const segments: string[] = [];
  for (const rawSegment of portable.split("/")) {
    if (!rawSegment || rawSegment === ".") continue;
    if (rawSegment === "..") return undefined;
    const segment = rawSegment.normalize("NFC");
    if (
      !segment ||
      /[. ]$/u.test(segment) ||
      WINDOWS_RESERVED_BASENAME.test(segment) ||
      WINDOWS_FORBIDDEN_PATH_CHARACTERS.test(segment)
    ) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments.join("/") || ".";
}

export function portablePathCollisionKey(value: string): string {
  const canonical = canonicalPortableRelativePath(value);
  if (!canonical) return "\0invalid";
  return canonical.toLowerCase();
}

export function portablePathsOverlap(first: string, second: string): boolean {
  const left = portablePathCollisionKey(first);
  const right = portablePathCollisionKey(second);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
