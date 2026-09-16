import { release, version } from "node:os";

export function readClientActivitySystemInfo(system = { release, version }): {
  operatingSystemRelease?: string;
  operatingSystemVersion?: string;
} {
  return {
    operatingSystemRelease: optionalSystemDetail(system.release(), 128),
    operatingSystemVersion: optionalSystemDetail(system.version(), 256),
  };
}

function optionalSystemDetail(value: string, maxLength: number): string | undefined {
  const normalized = value.trim();
  // Localized OS names are valid; keep each optional detail bounded and on one line.
  return normalized.length > 0 &&
    normalized.length <= maxLength &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)
    ? normalized
    : undefined;
}
