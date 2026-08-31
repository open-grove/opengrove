import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const tempRoot = await mkdtemp(join(tmpdir(), "opengrove-packed-runtime-"));
const installRoot = join(tempRoot, "runtime");

try {
  // The caller builds first; skipping lifecycle scripts keeps this probe focused
  // on the exact files already staged for release.
  await execFileAsync("npm", ["pack", "--ignore-scripts", "--pack-destination", tempRoot], {
    cwd: projectRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  const archives = (await readdir(tempRoot)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one OpenGrove archive");

  await execFileAsync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--prefix",
      installRoot,
      join(tempRoot, archives[0]),
    ],
    { cwd: tempRoot, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
  );
  const registryUrl = pathToFileURL(
    join(installRoot, "node_modules", "opengrove", "dist", "localization", "locale-registry.js"),
  ).href;
  const probePath = join(tempRoot, "probe.mjs");
  await writeFile(probePath, `import ${JSON.stringify(registryUrl)};\n`, "utf8");
  await execFileAsync(process.execPath, [probePath], { cwd: tempRoot, timeout: 30_000 });

  console.log("packed-runtime ok (Host Locale Registry resolves outside the monorepo)");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
