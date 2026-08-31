import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { packageRoot } from "../package-root.js";

const runtimeRequire = createRequire(import.meta.url);

type PackageReleaseMetadata = {
  version?: unknown;
  clientReleaseNumber?: unknown;
};

export function readPackageVersion(): string | null {
  const version = readPackageReleaseMetadata()?.version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

// This number shares the monotonically increasing sequence used by WW's client releases.
export function readClientReleaseNumber(): number | null {
  const clientReleaseNumber = readPackageReleaseMetadata()?.clientReleaseNumber;
  return typeof clientReleaseNumber === "number" && Number.isInteger(clientReleaseNumber) && clientReleaseNumber > 0
    ? clientReleaseNumber
    : null;
}

export function readInstalledPackageVersion(packageName: string): string | null {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) return null;
  try {
    let currentDir = dirname(runtimeRequire.resolve(packageName));
    while (true) {
      try {
        const metadata = JSON.parse(readFileSync(resolve(currentDir, "package.json"), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (metadata.name === packageName) {
          return typeof metadata.version === "string" && metadata.version.trim() ? metadata.version.trim() : null;
        }
      } catch {
        // non-critical-fallback: Package entry points may live below the manifest, so keep walking upward.
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) return null;
      currentDir = parentDir;
    }
  } catch {
    return null;
  }
}

export function appStorePackageRequiresHostUpdate(
  minHostReleaseNumber: number | undefined,
  clientReleaseNumber = readClientReleaseNumber(),
): boolean {
  return (
    typeof minHostReleaseNumber === "number" &&
    Number.isInteger(minHostReleaseNumber) &&
    minHostReleaseNumber > 0 &&
    (clientReleaseNumber === null || clientReleaseNumber < minHostReleaseNumber)
  );
}

export function clientReleaseRequestHeader(): Record<string, string> {
  const clientReleaseNumber = readClientReleaseNumber();
  return clientReleaseNumber ? { "x-opengrove-client-release": String(clientReleaseNumber) } : {};
}

function readPackageReleaseMetadata(): PackageReleaseMetadata | null {
  try {
    return JSON.parse(readFileSync(resolve(packageRoot(), "package.json"), "utf8")) as PackageReleaseMetadata;
  } catch {
    return null;
  }
}
