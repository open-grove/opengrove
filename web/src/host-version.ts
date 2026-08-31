import { getJson } from "./bridge-client";
import { readDesktopApi } from "./desktop-api";

export interface HostVersion {
  available: boolean;
  packageVersion: string | null;
  clientReleaseNumber: number | null;
  source: "desktop" | "bridge";
  startedAt?: string;
}

type HostVersionProbe = {
  ok?: unknown;
  startedAt?: unknown;
  build?: {
    packageVersion?: unknown;
    clientReleaseNumber?: unknown;
  };
};

export async function getHostVersion(): Promise<HostVersion> {
  const desktop = readDesktopApi();
  if (desktop) {
    const provided = await desktop.getHostVersion?.();
    return {
      available: true,
      packageVersion: normalizedPackageVersion(provided?.packageVersion ?? desktop.versions?.app),
      clientReleaseNumber: normalizedReleaseNumber(
        provided?.clientReleaseNumber ?? desktop.versions?.clientReleaseNumber,
      ),
      source: "desktop",
    };
  }

  const probe = await getJson<HostVersionProbe>("/opengrove-probe");
  return {
    available: probe.ok === true,
    packageVersion: normalizedPackageVersion(probe.build?.packageVersion),
    clientReleaseNumber: normalizedReleaseNumber(probe.build?.clientReleaseNumber),
    source: "bridge",
    ...(typeof probe.startedAt === "string" && probe.startedAt.trim() ? { startedAt: probe.startedAt.trim() } : {}),
  };
}

function normalizedPackageVersion(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedReleaseNumber(value: unknown): number | null {
  return isPositiveReleaseNumber(value) ? value : null;
}

function isPositiveReleaseNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
