import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readDesktopReleasePackageIdentity(path) {
  const packagePath = resolve(path);
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read desktop release package identity from ${packagePath}: ${errorMessage(error)}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageJson?.version ?? "")) {
    throw new Error(`desktop release package identity has an invalid version: ${packagePath}`);
  }
  if (!Number.isSafeInteger(packageJson.clientReleaseNumber) || packageJson.clientReleaseNumber <= 0) {
    throw new Error(`desktop release package identity has an invalid clientReleaseNumber: ${packagePath}`);
  }
  return {
    version: packageJson.version,
    clientReleaseNumber: packageJson.clientReleaseNumber,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
