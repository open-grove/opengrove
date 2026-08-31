import { resolve } from "node:path";
import { build } from "vite";

await Promise.all([
  build({ configFile: resolve(import.meta.dirname, "..", "vite.config.ts") }),
  import("./build-desktop.mjs"),
]);
