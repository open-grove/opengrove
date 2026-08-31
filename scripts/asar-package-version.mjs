import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractFile, uncache } = require("@electron/asar");

export function readAsarPackageVersion(archivePath) {
  // @electron/asar caches archive headers by path. The updater replaces app.asar
  // in place, so release gates must discard the previous version's header.
  uncache(archivePath);
  const bytes = extractFile(archivePath, "package.json");
  return JSON.parse(bytes.toString("utf8")).version;
}
