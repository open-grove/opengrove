import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

for (const packageName of ["protocol", "agent-protocol", "client"]) {
  const source = join(projectRoot, "packages", packageName, "dist");
  const target = join(projectRoot, "dist", packageName);
  if (!existsSync(source)) {
    throw new Error(`packages/${packageName}/dist is missing. Run npm run build:server first.`);
  }
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
