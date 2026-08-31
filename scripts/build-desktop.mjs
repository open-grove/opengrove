import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const outDir = join(projectRoot, "desktop-dist");
const sourcemap = process.env.OPENGROVE_DESKTOP_SOURCEMAP === "1";

await rm(outDir, { recursive: true, force: true });

await Promise.all([buildDesktopEntry("main"), buildDesktopEntry("preload")]);

async function buildDesktopEntry(name) {
  await build({
    entryPoints: [join(projectRoot, "desktop", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: join(outDir, `${name}.cjs`),
    external: ["electron"],
    minify: true,
    sourcemap,
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
  });
}
