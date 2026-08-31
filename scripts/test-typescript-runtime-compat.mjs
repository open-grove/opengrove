import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-typescript-runtime-compat-"));
const nativeOutDir = join(tempDir, "native");
const legacyOutDir = join(tempDir, "legacy");
const nativeCompiler = join(projectRoot, "node_modules", "@typescript", "native", "bin", "tsc");
const legacyCompiler = join(projectRoot, "node_modules", "typescript", "bin", "tsc6");
const serverConfig = join(projectRoot, "tsconfig.json");
const protocolConfig = join(projectRoot, "packages", "agent-protocol", "tsconfig.json");
const protocolOutDir = join(projectRoot, "packages", "agent-protocol", "dist");

try {
  await rm(protocolOutDir, { recursive: true, force: true });
  await compile(legacyCompiler, protocolConfig, protocolOutDir);
  await Promise.all([
    compile(nativeCompiler, serverConfig, nativeOutDir),
    compile(legacyCompiler, serverConfig, legacyOutDir),
  ]);

  const nativeFiles = await listJavaScriptFiles(nativeOutDir);
  const legacyFiles = await listJavaScriptFiles(legacyOutDir);
  assert.deepEqual(nativeFiles, legacyFiles, "TS7 and TS6 emitted different JavaScript file sets");

  const mismatches = [];
  for (const file of nativeFiles) {
    const [nativeSource, legacySource] = await Promise.all([
      readFile(join(nativeOutDir, file)),
      readFile(join(legacyOutDir, file)),
    ]);
    if (!nativeSource.equals(legacySource)) mismatches.push(file);
  }
  assert.deepEqual(mismatches, [], `TS7 runtime output differs from TS6: ${mismatches.join(", ")}`);
  console.log(`typescript-runtime-compat ok (${nativeFiles.length} JavaScript files are byte-identical)`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function compile(compilerPath, configPath, outDir) {
  await execFileAsync(process.execPath, [compilerPath, "-p", configPath, "--outDir", outDir], { cwd: projectRoot });
}

async function listJavaScriptFiles(root) {
  const files = [];
  await visit(root);
  return files.sort();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(relative(root, path));
      }
    }
  }
}
