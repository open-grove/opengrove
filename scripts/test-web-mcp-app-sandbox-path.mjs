import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-mcp-app-sandbox-path-"));
const bundlePath = join(tempDir, "mcp-app-sandbox-url.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "web/src/components/apps/mcp-app-sandbox-url.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const { resolveMcpAppSandboxUrl } = await import(pathToFileURL(bundlePath).href);

  assert.equal(
    resolveMcpAppSandboxUrl({
      bridgeBootstrapUrl: "https://agent.example.com/proxy/demo/api/bootstrap",
      sandboxOrigin: "https://mcp.agent.example.com",
    }),
    "https://mcp.agent.example.com/proxy/demo/mcp-app-sandbox",
  );

  assert.equal(
    resolveMcpAppSandboxUrl({
      bridgeBootstrapUrl: "http://127.0.0.1:5173/api/bootstrap",
    }),
    "http://mcp-app.localhost:5173/mcp-app-sandbox",
  );

  assert.equal(
    resolveMcpAppSandboxUrl({
      bridgeBootstrapUrl: "opengrove-desktop://ui/api/bootstrap",
    }),
    "opengrove-desktop://mcp-app/mcp-app-sandbox",
    "Desktop MCP Apps must use a stable isolated custom origin instead of the dynamic Bridge port",
  );

  console.log("web-mcp-app-sandbox-path-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
