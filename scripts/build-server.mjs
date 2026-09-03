import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const compatibilityBuild = process.argv.includes("--compat");
const nativeCompiler = join(projectRoot, "node_modules", "@typescript", "native", "bin", "tsc");
const legacyCompiler = join(projectRoot, "node_modules", "typescript", "bin", "tsc6");

for (const packageName of ["protocol", "agent-protocol", "client"]) {
  if (packageName === "client") {
    await import("./generate-host-client.mjs");
  }
  await rm(join(projectRoot, "packages", packageName, "dist"), { recursive: true, force: true });
  await compile(legacyCompiler, ["-p", join(projectRoot, "packages", packageName, "tsconfig.json")]);
}

await rm(join(projectRoot, "dist"), { recursive: true, force: true });
await compile(compatibilityBuild ? legacyCompiler : nativeCompiler, ["-p", join(projectRoot, "tsconfig.json")]);
await import("./copy-workspace-runtimes.mjs");

async function compile(compiler, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [compiler, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`TypeScript compiler failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
      }
    });
  });
}
