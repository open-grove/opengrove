import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-startup-"));
const port = await availablePort();
const configuredStatePath = join(tempDir, "state.json");
const child = spawn(process.execPath, ["dist/cli.js", "web", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    OPENGROVE_DATA_DIR: tempDir,
    OPENGROVE_STATE_PATH: configuredStatePath,
    OPENGROVE_BRIDGE_SETTINGS_PATH: join(tempDir, "settings.json"),
    OPENGROVE_WW_BASE_URL: "https://ww.example.test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForListening(child, port);
  const [bootstrapResponse, uiResponse, sessionResponse, webVersionResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/bootstrap`),
    fetch(`http://127.0.0.1:${port}/ui/`),
    fetch(`http://127.0.0.1:${port}/api/auth/session`),
    fetch(`http://127.0.0.1:${port}/version.json`),
  ]);
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(uiResponse.status, 200);
  assert.equal(sessionResponse.status, 200);
  assert.equal(webVersionResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  const session = await sessionResponse.json();
  const webVersion = await webVersionResponse.json();
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.equal(bootstrap.environment.preset, "web-single");
  assert.equal(bootstrap.auth.mode, "session");
  assert.equal(session.status, "unauthenticated");
  assert.equal(webVersion.packageVersion, packageJson.version);
  assert.match(
    await uiResponse.text(),
    new RegExp(`<meta name="opengrove-package-version" content="${packageJson.version}"`),
  );
  assert.equal(
    existsSync(join(tempDir, "state.sqlite")),
    true,
    "web startup must create SQLite state at the OPENGROVE_STATE_PATH-derived location",
  );
  assert.equal(
    existsSync(join(tempDir, "local-state.sqlite")),
    false,
    "OPENGROVE_STATE_PATH must take precedence over the DATA_DIR default",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Web single startup harness passed.");

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

function waitForListening(child, port) {
  return new Promise((resolveListen, rejectListen) => {
    const timeout = setTimeout(() => rejectListen(new Error("web-single startup timed out")), 15_000);
    const onData = (chunk) => {
      if (!String(chunk).includes(`http://127.0.0.1:${port}`)) return;
      clearTimeout(timeout);
      resolveListen();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectListen(new Error(`web-single exited before listening (${code})`));
    });
  });
}
