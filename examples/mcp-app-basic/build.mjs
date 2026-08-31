import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [resolve(root, "src/view.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  write: false,
  minify: true,
});
const template = await readFile(resolve(root, "src/index.html"), "utf8");
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script").replace(/[ \t]+(?=\r?$)/gmu, "");
const output = template.replace("<!-- OPENGROVE_MCP_APP_BUNDLE -->", () => `<script>${script}</script>`);
await mkdir(resolve(root, "ui"), { recursive: true });
await writeFile(resolve(root, "ui/index.html"), output, "utf8");
