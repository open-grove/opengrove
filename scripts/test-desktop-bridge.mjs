import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createSqliteStateStore } from "../dist/storage/sqlite-state-store.js";
import { defaultBridgeSettings } from "../dist/server/bridge-settings-store.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const entry = join(projectRoot, "dist", "server", "desktop-bridge-entry.js");

await runProtectedBridgeCase();
await runUnauthenticatedDevBridgeCase();
await runSessionAuthBridgeCase();
await runAutomaticStateRecoveryCase();
await runStoreLayoutMigrationActivityCase();

async function runProtectedBridgeCase() {
  const token = randomBytes(24).toString("base64url");
  await withDesktopBridge({
    name: "protected",
    token,
    cwdRelativeToTempRoot: true,
    cwdPackageVersion: "9.9.9",
    async verify(ready) {
      const healthWithoutToken = await fetch(`${ready.apiBase}/health`, { cache: "no-store" });
      assert.equal(healthWithoutToken.status, 200);
      const healthJson = await healthWithoutToken.json();
      assert.equal(healthJson.tokenRequired, true);
      assert.equal(healthJson.settings, undefined, "public health without token must not expose private settings");
      await verifyProbeMetadata(ready);

      const settingsWithoutToken = await fetch(`${ready.apiBase}/settings`, { cache: "no-store" });
      assert.equal(settingsWithoutToken.status, 401);

      const settingsWithToken = await fetch(`${ready.apiBase}/settings`, {
        cache: "no-store",
        headers: { "x-opengrove-token": token },
      });
      assert.equal(settingsWithToken.status, 200);
      const settingsJson = await settingsWithToken.json();
      assert.equal(settingsJson.ok, true);
      assert.equal(settingsJson.settings.settingsPath, ready.settingsPath);

      const diagnosticSummary = await fetch(`${ready.apiBase}/diagnostics/summary`, {
        headers: { "x-opengrove-token": token },
      });
      assert.equal(diagnosticSummary.status, 200);
      const diagnosticJson = await diagnosticSummary.json();
      assert.equal(diagnosticJson.window, "recent-100");
      assert.equal(typeof diagnosticJson.counts?.total, "number");
      assert.ok(Array.isArray(diagnosticJson.failures));
      assert.equal("input" in (diagnosticJson.failures[0] ?? {}), false, "diagnostic summary must not include prompts");
      assert.equal(JSON.stringify(diagnosticJson).includes('"sessionId"'), false);
      assert.equal(JSON.stringify(diagnosticJson).includes('"message"'), false);
      assert.equal(JSON.stringify(diagnosticJson).includes('"error"'), false);

      const malformedSettings = await fetch(`${ready.apiBase}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-opengrove-token": token },
        body: "{",
      });
      assert.equal(malformedSettings.status, 500);
      const malformedJson = await malformedSettings.json();
      assert.match(malformedJson.incidentId ?? "", /^OG-\d{8}-[A-F0-9]{6}$/);
      assert.equal(malformedSettings.headers.get("x-opengrove-trace-id"), malformedJson.traceId);
    },
  });
}

async function runUnauthenticatedDevBridgeCase() {
  await withDesktopBridge({
    name: "unauthenticated-dev",
    allowUnauthenticated: true,
    async verify(ready) {
      const health = await fetch(`${ready.apiBase}/health`, { cache: "no-store" });
      assert.equal(health.status, 200);
      const healthJson = await health.json();
      assert.equal(healthJson.tokenRequired, false);
      assert.equal(healthJson.settings, undefined, "health must remain a small liveness response");
      await verifyProbeMetadata(ready);

      const settings = await fetch(`${ready.apiBase}/settings`, { cache: "no-store" });
      assert.equal(settings.status, 200);
      const settingsJson = await settings.json();
      assert.equal(settingsJson.ok, true);
      assert.equal(settingsJson.settings.settingsPath, ready.settingsPath);
    },
  });
}

async function runSessionAuthBridgeCase() {
  const token = randomBytes(24).toString("base64url");
  await withDesktopBridge({
    name: "session-auth",
    token,
    webAuthMode: "session",
    async verify(ready) {
      const health = await fetch(`${ready.apiBase}/health`, { cache: "no-store" });
      assert.equal(health.status, 200);
      const healthJson = await health.json();
      assert.equal(healthJson.auth.mode, "session");
      assert.equal(healthJson.auth.authenticated, undefined);
      assert.equal(healthJson.settings, undefined, "session health without login must not expose private settings");
      assert.equal(healthJson.tokenRequired, false);
      const settingsWithoutDesktopToken = await fetch(`${ready.apiBase}/settings`, { cache: "no-store" });
      assert.equal(settingsWithoutDesktopToken.status, 503);
      const settingsWithDesktopToken = await fetch(`${ready.apiBase}/settings`, {
        cache: "no-store",
        headers: { "x-opengrove-token": token },
      });
      assert.equal(
        settingsWithDesktopToken.status,
        200,
        "the trusted desktop shell must retain local Bridge access in session mode",
      );
      await verifyProbeMetadata(ready);
    },
  });
}

async function runAutomaticStateRecoveryCase() {
  const token = randomBytes(24).toString("base64url");
  await withDesktopBridge({
    name: "automatic-state-recovery",
    token,
    prepare({ dataDir, statePath }) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ version: 9, savedAt: "2026-07-18T00:00:00.000Z" }), "utf8");
      const migrated = createSqliteStateStore(statePath);
      void migrated.close?.();
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 9,
          savedAt: "2026-07-18T01:00:00.000Z",
          memory: [
            {
              id: "desktop-recovered-history",
              scope: "workspace",
              kind: "test.history",
              text: "Recovered without asking the user to manage state files.",
              confidence: "asserted",
              source: { kind: "user" },
              tags: [],
              createdAt: "2026-07-18T01:00:00.000Z",
              updatedAt: "2026-07-18T01:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );
    },
    async verify(ready) {
      const memory = await fetch(`${ready.apiBase}/memory`, {
        headers: { "x-opengrove-token": token },
      });
      assert.equal(memory.status, 200);
      const body = await memory.json();
      assert.deepEqual(
        body.memory.map((item) => item.id),
        ["desktop-recovered-history"],
      );
      assert.equal(existsSync(join(ready.dataDir, "local-state.json")), false);
      assert.equal(existsSync(join(ready.dataDir, "local-state.before-legacy-recovery")), true);
    },
  });
}

async function runStoreLayoutMigrationActivityCase() {
  const token = randomBytes(24).toString("base64url");
  await withDesktopBridge({
    name: "store-layout-activity",
    token,
    prepare({ dataDir, settingsPath, legacyAppsDir }) {
      const appId = "desktop-activity-story-seed";
      const legacyProgramRoot = join(dataDir, "app-store", "programs", "a".repeat(64), "0.2.49-2f902d7c2cf6", "app");
      const legacyWorkspaceRoot = join(legacyAppsDir, appId, "workspace");
      mkdirSync(legacyProgramRoot, { recursive: true });
      mkdirSync(legacyWorkspaceRoot, { recursive: true });
      writeFileSync(join(legacyWorkspaceRoot, "story.md"), "user-owned\n", "utf8");
      writeFileSync(
        join(legacyProgramRoot, "opengrove.app.json"),
        JSON.stringify({ id: appId, title: "Story Seed", ui: { surface: "file-workbench", workspace: "workspace" } }),
        "utf8",
      );
      writeFileSync(join(legacyProgramRoot, "index.js"), "export default true;\n", "utf8");
      writeFileSync(
        join(legacyProgramRoot, ".opengrove-store-package.json"),
        JSON.stringify({ schemaVersion: 1, source: "registry", appId }),
        "utf8",
      );
      symlinkSync(
        legacyWorkspaceRoot,
        join(legacyProgramRoot, "workspace"),
        process.platform === "win32" ? "junction" : "dir",
      );
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        `${JSON.stringify({
          ...defaultBridgeSettings(),
          providerSetupVersion: 4,
          mountedApps: [{ id: appId, path: legacyProgramRoot, workspacePath: legacyWorkspaceRoot, enabled: true }],
        })}\n`,
        "utf8",
      );
    },
    async verify(ready, context) {
      const settingsResponse = await fetch(`${ready.apiBase}/settings`, {
        headers: { "x-opengrove-token": token },
      });
      const settings = await settingsResponse.json();
      assert.deepEqual(
        context.startupActivities,
        ["migrating_local_data"],
        `the desktop child must report Store migration activity before publishing ready\nsettings=${JSON.stringify(settings.settings?.mountedApps)}\nstdout=${context.stdout}\nstderr=${context.stderr}`,
      );
    },
  });
}

async function verifyProbeMetadata(ready) {
  const probe = await fetch(`${ready.url}/opengrove-probe`, { cache: "no-store" });
  assert.equal(probe.status, 200);
  const probeJson = await probe.json();
  assert.equal(probeJson.ok, true);
  assert.equal(probeJson.product, "OpenGrove");
  assert.equal(probeJson.authMode, ready.authMode);
  assert.equal(probeJson.pid, ready.pid);
  assert.equal(probeJson.build?.packageVersion, packageJson.version);
  assert.equal(probeJson.build?.clientReleaseNumber, packageJson.clientReleaseNumber);
  assert.match(probeJson.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(probeJson.build?.modules?.roomDelegation?.mtime ?? "", /^\d{4}-\d{2}-\d{2}T/);
}

async function withDesktopBridge(options) {
  const tempRoot = mkdtempSync(join(tmpdir(), `opengrove-desktop-bridge-${options.name}-`));
  const dataDir = join(tempRoot, "data");
  const logDir = join(tempRoot, "logs");
  const statePath = join(dataDir, "local-state.json");
  const settingsPath = join(dataDir, "bridge-settings.json");
  const programsDir = join(tempRoot, "programs");
  const workspacesDir = join(tempRoot, "workspaces");
  const legacyAppsDir = join(tempRoot, "apps");
  let child;
  try {
    if (options.cwdPackageVersion) {
      writeFileSync(
        join(tempRoot, "package.json"),
        `${JSON.stringify({ name: "unrelated-launch-project", version: options.cwdPackageVersion }, null, 2)}\n`,
        "utf8",
      );
    }
    await options.prepare?.({ dataDir, statePath, settingsPath, programsDir, workspacesDir, legacyAppsDir });
    child = fork(entry, [], {
      cwd: options.cwdRelativeToTempRoot ? tempRoot : projectRoot,
      env: {
        ...process.env,
        OPENGROVE_DATA_DIR: dataDir,
        OPENGROVE_LOG_DIR: logDir,
        OPENGROVE_DIAGNOSTICS_DIR: join(tempRoot, "diagnostics"),
        OPENGROVE_STATE_PATH: statePath,
        OPENGROVE_BRIDGE_SETTINGS_PATH: settingsPath,
        OPENGROVE_PROGRAMS_DIR: programsDir,
        OPENGROVE_WORKSPACES_DIR: workspacesDir,
        OPENGROVE_LEGACY_APPS_DIR: legacyAppsDir,
        ...(options.token ? { OPENGROVE_BRIDGE_TOKEN: options.token } : {}),
        ...(options.allowUnauthenticated ? { OPENGROVE_DESKTOP_BRIDGE_ALLOW_UNAUTHENTICATED: "1" } : {}),
        OPENGROVE_WEB_AUTH_MODE: options.webAuthMode ?? "",
        OPENGROVE_WW_BASE_URL: options.wwBaseUrl ?? "",
        OPENGROVE_BRIDGE_PORT: "0",
        OPENGROVE_BRIDGE_HOST: "127.0.0.1",
      },
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const startupActivities = [];
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("message", (message) => {
      if (message?.type === "opengrove.desktop.bridge.startup-activity") {
        startupActivities.push(message.activity);
      }
    });
    const ready = await waitForReady(child);
    assert.equal(ready.type, "opengrove.desktop.bridge.ready");
    assert.equal(ready.host, "127.0.0.1");
    assert.notEqual(ready.port, 37371, "desktop bridge should use a random port in the harness");
    assert.equal(ready.authMode, options.webAuthMode === "session" ? "session" : "bridge-token");
    assert.equal(ready.dataDir, dataDir);
    assert.equal(realpathSync(ready.statePath), realpathSync(join(dataDir, "local-state.sqlite")));
    assert.equal(ready.settingsPath, settingsPath);
    assert.ok(existsSync(dataDir), "desktop bridge should create data dir");
    assert.ok(existsSync(logDir), "desktop bridge should create log dir");

    await options.verify(ready, { startupActivities, stdout, stderr });
  } finally {
    if (child?.connected) {
      child.send({ type: "opengrove.desktop.bridge.shutdown" });
    }
    if (child) {
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_500)).then(() => child.kill("SIGKILL")),
      ]);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function waitForReady(target) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error("desktop_bridge_ready_timeout"));
    }, 30_000);
    target.on("message", (message) => {
      if (message?.type !== "opengrove.desktop.bridge.ready") return;
      clearTimeout(timeout);
      resolveReady(message);
    });
    target.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`desktop_bridge_exited:${code ?? signal ?? "unknown"}`));
    });
  });
}
