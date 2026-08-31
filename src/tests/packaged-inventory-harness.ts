import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appEnvName } from "../identity.js";
import { startLocalBridgeServer } from "../server/local-bridge.js";

interface InventoryResponse {
  ok?: boolean;
  error?: string;
  mountedApps?: {
    summary?: unknown;
    commandUsages?: unknown;
    items?: Array<{
      kind?: string;
      name?: string;
      title?: string;
    }>;
  };
  extensions?: unknown;
}

interface HealthResponse {
  ok?: boolean;
  kernel?: unknown;
  settings?: unknown;
  runtimeControls?: unknown;
  runtimeControlsByKernel?: unknown;
}

interface EventsResponse {
  ok?: boolean;
  cursor: string;
  events: Array<{ type?: string }>;
  longPollSupported?: boolean;
  resetRequired?: boolean;
}

const root = mkdtempSync(join(tmpdir(), "opengrove-packaged-inventory-"));
const installRoot = join(root, "OpenGrove.app", "Contents", "Resources");
const dataRoot = join(root, "user-data", "data");
const mountedAppRoot = join(root, "apps", "review-desk");
const previousCwd = process.cwd();
const dataDirEnv = appEnvName("DATA_DIR");
const previousDataDir = process.env[dataDirEnv];
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousWebAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
let server: Server | undefined;

try {
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(mountedAppRoot, "ui"), { recursive: true });
  writeFileSync(join(mountedAppRoot, "ui", "index.html"), "<!doctype html><title>Review Desk</title>\n", "utf8");
  writeFileSync(
    join(mountedAppRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "review-desk",
        title: "Review Desk",
        ui: { kind: "mcp-app", entry: "ui/index.html", tools: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(dataRoot, "bridge-settings.json"),
    `${JSON.stringify(
      {
        kernel: "claude-code",
        mountedApps: [{ id: "review-desk", path: mountedAppRoot, title: "Review Desk", enabled: true }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.env[dataDirEnv] = dataRoot;
  process.env.OPENGROVE_WW_BASE_URL = "";
  process.env.OPENGROVE_WEB_AUTH_MODE = "";
  process.chdir(installRoot);
  chmodSync(installRoot, 0o555);

  server = startLocalBridgeServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(dataRoot, "local-state.json"),
  });
  if (!server.listening) await once(server, "listening");

  const address = server.address() as AddressInfo;
  const healthResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  const healthText = await healthResponse.text();
  assert.ok(
    Buffer.byteLength(healthText) < 8_000,
    `health heartbeat must stay below its 8 KB wire budget, got ${Buffer.byteLength(healthText)} bytes`,
  );
  const health = JSON.parse(healthText) as HealthResponse;
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ok, true);
  assert.equal("settings" in health, false, "health must not duplicate the settings response");
  assert.equal("runtimeControls" in health, false, "health must not duplicate runtime controls");
  assert.equal("runtimeControlsByKernel" in health, false, "health must not duplicate per-kernel runtime controls");
  assert.equal("kernel" in health, false, "public health must not disclose the selected kernel");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/inventory`);
  const inventoryText = await response.text();
  assert.ok(
    Buffer.byteLength(inventoryText) < 256_000,
    `packaged inventory must stay below its 256 KB wire budget, got ${Buffer.byteLength(inventoryText)} bytes`,
  );
  const inventory = JSON.parse(inventoryText) as InventoryResponse;
  assert.equal(response.status, 200, `packaged inventory should succeed: ${inventory.error ?? "unknown error"}`);
  assert.equal(inventory.ok, true);
  assert.equal("knowledge" in inventory, false);
  assert.equal("knowledgeFolders" in inventory, false);
  assert.equal("knowledgeLedgers" in inventory, false);
  assert.equal("memory" in inventory, false);
  assert.equal("extensions" in inventory, false, "startup inventory must not impersonate the full extensions response");
  assert.equal("summary" in (inventory.mountedApps ?? {}), false);
  assert.equal("commandUsages" in (inventory.mountedApps ?? {}), false);
  assert.equal(
    existsSync(join(dataRoot, "opengrove-vault")),
    false,
    "inventory must not initialize the retired Knowledge Vault",
  );
  assert.equal(
    existsSync(join(installRoot, "data")),
    false,
    "packaged inventory must not create data below the read-only installation root",
  );
  assert.ok(
    inventory.mountedApps?.items?.some(
      (item) => item.kind === "app" && item.name === "review-desk" && item.title === "Review Desk",
    ),
    "packaged inventory should expose enabled mounted apps",
  );

  const eventsUrl = `http://127.0.0.1:${address.port}/api/events`;
  const eventSnapshot = (await (await fetch(`${eventsUrl}?limit=200`)).json()) as EventsResponse;
  assert.equal(eventSnapshot.longPollSupported, true);
  const longPollStartedAt = Date.now();
  const longPollPromise = fetch(
    `${eventsUrl}?limit=200&cursor=${encodeURIComponent(eventSnapshot.cursor)}&waitMs=2000`,
  ).then(async (eventResponse) => {
    assert.equal(eventResponse.status, 200);
    return (await eventResponse.json()) as EventsResponse;
  });
  await delay(75);
  const computerStateResponse = await fetch(`http://127.0.0.1:${address.port}/api/computer-state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snapshot: { app: "test-harness", observation: "wake the event long poll" },
      recordArtifact: true,
    }),
  });
  assert.equal(computerStateResponse.status, 200);
  const eventDelta = await longPollPromise;
  const longPollElapsedMs = Date.now() - longPollStartedAt;
  assert.equal(eventDelta.ok, true);
  assert.equal(eventDelta.longPollSupported, true);
  assert.equal(eventDelta.resetRequired, false);
  assert.ok(eventDelta.events.length > 0, "event long poll must include the event that woke it");
  assert.ok(longPollElapsedMs >= 50, `event long poll returned too early (${longPollElapsedMs} ms)`);
  assert.ok(longPollElapsedMs < 1_000, `event long poll did not wake promptly (${longPollElapsedMs} ms)`);

  console.log("packaged-inventory-harness ok");
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  process.chdir(previousCwd);
  chmodSync(installRoot, 0o755);
  if (previousDataDir === undefined) {
    delete process.env[dataDirEnv];
  } else {
    process.env[dataDirEnv] = previousDataDir;
  }
  if (previousWwBaseUrl === undefined) {
    delete process.env.OPENGROVE_WW_BASE_URL;
  } else {
    process.env.OPENGROVE_WW_BASE_URL = previousWwBaseUrl;
  }
  if (previousWebAuthMode === undefined) {
    delete process.env.OPENGROVE_WEB_AUTH_MODE;
  } else {
    process.env.OPENGROVE_WEB_AUTH_MODE = previousWebAuthMode;
  }
  rmSync(root, { recursive: true, force: true });
}

process.exit(0);
