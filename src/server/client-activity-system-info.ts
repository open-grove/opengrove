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
  // Unusual OS metadata must not invalidate the entire daily activity report.
  return normalized.length <= maxLength && /^[\x20-\x7e]+$/.test(normalized) ? normalized : undefined;
}
