import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpenGroveServer } from "../server/create-server.js";

const root = await mkdtemp(join(tmpdir(), "opengrove-web-bootstrap-"));
const previousAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousMcpAppSandboxOrigin = process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
const previousHome = process.env.HOME;

try {
  // Keep the harness independent from a developer machine's configured
  // OpenClaw home. Otherwise its optional async provider refresh can recreate
  // files below this temporary root while the harness is removing it.
  process.env.HOME = root;
  process.env.OPENGROVE_WEB_AUTH_MODE = "session";
  process.env.OPENGROVE_WW_BASE_URL = "https://ww.example.test";
  process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN = "https://mcp-apps.example.test";
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    runtimeEnvironment: "web-single",
    statePath: join(root, "state.json"),
  });
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`);
    assert.equal(response.status, 200);
    const bootstrap = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(bootstrap.environment, {
      preset: "web-single",
      profile: "local",
      tenancy: "single-principal",
      execution: "local-process",
      workspace: "host-local",
      stateStore: "sqlite",
      blobStore: "filesystem",
      auth: "session",
    });
    assert.deepEqual(bootstrap.auth, { mode: "session", tokenRequired: false });
    assert.match(String(bootstrap.hostId), /^[0-9a-f]{16}$/u);
    assert.deepEqual(bootstrap.mcpApps, { sandboxOrigin: "https://mcp-apps.example.test" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
} finally {
  if (previousAuthMode === undefined) delete process.env.OPENGROVE_WEB_AUTH_MODE;
  else process.env.OPENGROVE_WEB_AUTH_MODE = previousAuthMode;
  if (previousWwBaseUrl === undefined) delete process.env.OPENGROVE_WW_BASE_URL;
  else process.env.OPENGROVE_WW_BASE_URL = previousWwBaseUrl;
  if (previousMcpAppSandboxOrigin === undefined) delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
  else process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN = previousMcpAppSandboxOrigin;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

console.log("Client bootstrap harness passed.");
