import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const source = join(projectRoot, "packages", "agent-protocol", "dist");
const target = join(projectRoot, "dist", "agent-protocol");

if (!existsSync(source)) {
  throw new Error("packages/agent-protocol/dist is missing. Run npm run build:protocol first.");
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
