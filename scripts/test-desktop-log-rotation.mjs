import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-bounded-log-"));
const bundlePath = join(tempDir, "bounded-log.mjs");
const logPath = join(tempDir, "desktop-main.log");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop/bounded-log.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const { appendBoundedLog } = await import(pathToFileURL(bundlePath).href);
  await writeFile(logPath, "12345678", "utf8");

  appendBoundedLog(logPath, "abcd", { maxBytes: 10, retainedFiles: 2 });
  assert.equal(await readFile(logPath, "utf8"), "abcd");
  assert.equal(await readFile(`${logPath}.1`, "utf8"), "12345678");

  appendBoundedLog(logPath, "efgh", { maxBytes: 10, retainedFiles: 2 });
  appendBoundedLog(logPath, "ijkl", { maxBytes: 10, retainedFiles: 2 });
  assert.equal(await readFile(logPath, "utf8"), "ijkl");
  assert.equal(await readFile(`${logPath}.1`, "utf8"), "abcdefgh");
  assert.equal(await readFile(`${logPath}.2`, "utf8"), "12345678");

  await writeFile(logPath, "012345678901234567890123456789", "utf8");
  appendBoundedLog(logPath, "z", { maxBytes: 10, retainedFiles: 2 });
  assert.equal(await readFile(`${logPath}.1`, "utf8"), "0123456789", "an old oversized log keeps only its recent tail");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop log rotation ok");
