import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-host-version-"));
const entryPath = join(tempDir, "host-version-entry.ts");
const bundlePath = join(tempDir, "host-version-entry.cjs");
const hostVersionModulePath = join(projectRoot, "web/src/host-version.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import { getHostVersion } from ${JSON.stringify(hostVersionModulePath)};

    export async function runHostVersionHarness() {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => null },
      });

      globalThis.openGroveDesktop = {
        versions: { app: "0.5.19", clientReleaseNumber: 10023 },
        getHostVersion: async () => ({ packageVersion: "0.5.20", clientReleaseNumber: 10024 }),
      };
      const desktop = await getHostVersion();
      assert.deepEqual(desktop, {
        available: true,
        packageVersion: "0.5.20",
        clientReleaseNumber: 10024,
        source: "desktop",
      });
      delete globalThis.openGroveDesktop;
      let requestedPath = "";
      globalThis.fetch = async (path) => {
        requestedPath = String(path);
        return new Response(JSON.stringify({
          ok: true,
          startedAt: "2026-07-24T00:00:00.000Z",
          build: { packageVersion: "0.5.20", clientReleaseNumber: 10024 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const bridge = await getHostVersion();
      assert.equal(requestedPath, "/opengrove-probe");
      assert.deepEqual(bridge, {
        available: true,
        packageVersion: "0.5.20",
        clientReleaseNumber: 10024,
        source: "bridge",
        startedAt: "2026-07-24T00:00:00.000Z",
      });
    }
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await require(bundlePath).runHostVersionHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("host-version harness ok");
