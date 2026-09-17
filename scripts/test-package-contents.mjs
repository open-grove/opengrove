import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "opengrove-package-contents-"));
try {
  const npm = process.platform === "win32" ? process.execPath : "npm";
  const prefix =
    process.platform === "win32"
      ? [process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
      : [];
  const [archive] = JSON.parse(
    execFileSync(npm, [...prefix, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const files = new Set(archive.files.map((entry) => entry.path));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const required = [
    "package.json",
    "dist/cli.js",
    "dist/localization/locale-registry.js",
    "dist/client/index.js",
    "dist/server/routes/bridge-registry.js",
    ...Object.values(pkg.imports).map((entry) => entry.default.replace(/^\.\//u, "")),
  ];
  for (const path of readdirSync("src/skills/bundled", { recursive: true }).filter((path) => /\.md$/u.test(path)))
    required.push(`src/skills/bundled/${path.replaceAll("\\", "/")}`);
  for (const path of required) assert.ok(files.has(path), `Published archive is missing ${path}`);
  assert.ok(
    ![...files].some((path) => /(?:^|\/)(?:\.env|auth\.json)$/u.test(path)),
    "Published archive must exclude credentials",
  );
  console.log(`Offline package contents verified (${required.length} required files; no dependency installation)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
