import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startOpenGroveServer } from "../server/create-server.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";
import type { BridgeKernelId } from "../server/bridge-types.js";

interface ApiResponse {
  ok: boolean;
  result?: {
    records?: Array<Record<string, unknown>>;
    warnings?: string[];
  };
  extensions?: {
    items: Array<Record<string, unknown>>;
    deployments: Array<Record<string, unknown>>;
    summary: Record<string, unknown>;
  };
  mountedApps?: {
    items?: Array<{
      kind?: string;
      name?: string;
      title?: string;
    }>;
  };
  [key: string]: unknown;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opengrove-extension-server-"));
  const workspaceRoot = join(tmp, "workspace");
  const dataRoot = join(tmp, "data");
  const sourceSkillRoot = join(tmp, "source-skills", "server-smoke");
  const mountedAppRoot = join(tmp, "mounted-apps", "server-app");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(sourceSkillRoot, { recursive: true });
  mkdirSync(join(mountedAppRoot, "bin"), { recursive: true });

  const kernelPathOverrides = Object.fromEntries(
    BRIDGE_KERNEL_IDS.map((kernelId) => [
      kernelId,
      {
        configHome: join(tmp, "kernels", kernelId),
        binaryPath: "/bin/echo",
      },
    ]),
  );
  const codexHome = kernelPathOverrides.codex!.configHome;
  const claudeHome = kernelPathOverrides["claude-code"]!.configHome;
  const opencodeHome = kernelPathOverrides.opencode!.configHome;

  writeFileSync(
    join(dataRoot, "bridge-settings.json"),
    `${JSON.stringify(
      {
        kernel: "claude-code",
        workspaceRoot,
        kernelPathOverrides,
        settingsSchemaVersion: 1,
        modelProviderBindings: [],
        customProviders: [],
        mountedApps: [{ id: "server-app", path: mountedAppRoot, enabled: true }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const appCli = join(mountedAppRoot, "bin", "app-business-cli");
  writeFileSync(appCli, "#!/bin/sh\necho app-business-cli\n", "utf8");
  chmodSync(appCli, 0o755);
  writeFileSync(
    join(mountedAppRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "server-app",
        title: "Server App",
        capabilities: {
          cli: [
            {
              id: "app-business-cli",
              title: "App Business CLI",
              command: "./bin/app-business-cli",
              doctor: ["doctor"],
              smoke: ["smoke"],
              env: ["APP_BUSINESS_TOKEN"],
              artifacts: ["workspace/runs/**"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(sourceSkillRoot, "SKILL.md"),
    [
      "---",
      "name: server-smoke",
      "title: Server Smoke",
      "description: Server-level extension manager smoke skill.",
      "allowed-tools:",
      "  - Bash",
      "shell:",
      "  - echo",
      "---",
      "# Server Smoke",
      "",
      "Verifies extension publication across every supported kernel.",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      "[mcp_servers.server_linear]",
      'command = "npx"',
      'args = ["-y", "server-linear-mcp"]',
      "",
      "[mcp_servers.server_linear.env]",
      'SERVER_LINEAR_TOKEN = "test-token"',
      "",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo server-hook" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const pluginRoot = join(opencodeHome, "plugins", "server-plugin");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "server-plugin",
        title: "Server Plugin",
        description: "Server-level extension manager plugin smoke test.",
        command: "node",
        args: ["server.js"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
  const previousWebAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
  process.env.OPENGROVE_WW_BASE_URL = "";
  process.env.OPENGROVE_WEB_AUTH_MODE = "";

  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(dataRoot, "state.json"),
  });

  try {
    await once(server, "listening");
    const baseUrl = serverUrl(server);
    console.log(`extension-manager-server-harness: started ${baseUrl}`);

    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.ok, true, "server health endpoint should respond");
    console.log("extension-manager-server-harness: health ok");

    const initialExtensions = await getJson(`${baseUrl}/extensions`);
    assert.equal(initialExtensions.ok, true, "extensions endpoint should respond");
    const cliDeployments =
      initialExtensions.extensions?.deployments.filter((deployment) => deployment.kind === "cli") ?? [];
    assert.ok(
      cliDeployments.some(
        (deployment) =>
          deployment.itemId === "cli.server-app.app-business-cli" &&
          deployment.command === appCli &&
          record(deployment.metadata).appId === "server-app",
      ),
      "extensions inventory should expose business CLIs declared by mounted apps",
    );
    assert.equal(
      cliDeployments.some((deployment) => Boolean(deployment.kernelId)),
      false,
      "kernel launcher commands should stay in kernel settings, not extension CLI inventory",
    );
    assertExtensionSurface(initialExtensions);
    console.log("extension-manager-server-harness: initial inventory ok");

    await assertMcpLifecycle(baseUrl, codexHome);
    console.log("extension-manager-server-harness: mcp lifecycle ok");

    await assertHookLifecycle(baseUrl, claudeHome);
    console.log("extension-manager-server-harness: hook lifecycle ok");

    await assertPluginLifecycle(baseUrl, pluginRoot);
    console.log("extension-manager-server-harness: plugin lifecycle ok");

    await assertReadonlyToolLifecycle(baseUrl);
    console.log("extension-manager-server-harness: tool readonly lifecycle ok");

    const imported = await postJson(`${baseUrl}/extensions/skills/import`, {
      sourcePath: sourceSkillRoot,
      replace: true,
    });
    assert.equal(imported.ok, true, "skill import should succeed through HTTP API");
    console.log("extension-manager-server-harness: import ok");

    const published = await postJson(`${baseUrl}/extensions/skills/publish`, {
      librarySkillId: "server-smoke",
      targetKernelIds: BRIDGE_KERNEL_IDS,
      scope: "user",
      replace: true,
    });
    assert.equal(published.ok, true, "skill publish should succeed through HTTP API");
    assert.equal(
      published.result?.records?.length,
      BRIDGE_KERNEL_IDS.length,
      "publish should return one record for every supported kernel",
    );
    console.log("extension-manager-server-harness: publish all kernels ok");

    const afterPublish = await getJson(`${baseUrl}/extensions`);
    assertKernelCoverage(afterPublish, "enabled");
    assertPublishedFilesExist(afterPublish);
    console.log("extension-manager-server-harness: publish scan ok");

    const deploymentIds = kernelSkillDeployments(afterPublish).map((deployment) => String(deployment.id));
    const disabled = await postJson(`${baseUrl}/extensions/deployments/disable`, {
      deploymentIds,
    });
    assert.equal(disabled.ok, true, "disable should succeed through HTTP API");
    assertKernelCoverage(await getJson(`${baseUrl}/extensions`), "disabled");
    console.log("extension-manager-server-harness: disable all kernels ok");

    const enabled = await postJson(`${baseUrl}/extensions/deployments/enable`, {
      deploymentIds,
    });
    assert.equal(enabled.ok, true, "enable should succeed through HTTP API");
    assertKernelCoverage(await getJson(`${baseUrl}/extensions`), "enabled");
    console.log("extension-manager-server-harness: enable all kernels ok");

    const inventory = await getJson(`${baseUrl}/inventory`);
    assert.equal(inventory.ok, true, "inventory endpoint should respond");
    assert.equal("extensions" in inventory, false, "inventory must not embed the full extensions response");
    assert.ok(
      inventory.mountedApps?.items?.some(
        (item) => item.kind === "app" && item.name === "server-app" && item.title === "Server App",
      ),
      "inventory should include the lightweight mounted app summary",
    );
    console.log("extension-manager-server-harness: inventory ok");

    const unpublished = await postJson(`${baseUrl}/extensions/skills/unpublish`, {
      deploymentIds,
    });
    assert.equal(unpublished.ok, true, "unpublish should succeed through HTTP API");
    const remainingKernelDeployments = kernelSkillDeployments(await getJson(`${baseUrl}/extensions`));
    assert.equal(remainingKernelDeployments.length, 0, "kernel skill deployments should be removed after unpublish");
    console.log("extension-manager-server-harness: unpublish ok");
  } finally {
    await closeServer(server);
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
    rmSync(tmp, { recursive: true, force: true });
  }
}

function assertKernelCoverage(response: ApiResponse, status: "enabled" | "disabled"): void {
  const deployments = kernelSkillDeployments(response);
  const kernels = new Set(deployments.map((deployment) => deployment.kernelId));
  for (const kernelId of BRIDGE_KERNEL_IDS) {
    assert.ok(kernels.has(kernelId), `server-smoke should be deployed for ${kernelId}`);
  }
  assert.equal(kernels.size, BRIDGE_KERNEL_IDS.length, "server-smoke should cover every supported kernel");
  assert.ok(
    deployments.every((deployment) => deployment.status === status),
    `all server-smoke kernel deployments should be ${status}`,
  );
}

function assertPublishedFilesExist(response: ApiResponse): void {
  for (const deployment of kernelSkillDeployments(response)) {
    const targetPath = stringValue(deployment.targetPath);
    assert.ok(targetPath, `deployment for ${String(deployment.kernelId)} should include targetPath`);
    assert.ok(
      existsSync(join(targetPath, "SKILL.md")),
      `published skill file should exist for ${String(deployment.kernelId)}`,
    );
  }
}

function assertExtensionSurface(response: ApiResponse): void {
  assert.ok(
    requireDeployment(response, "mcp", "codex", "mcp.server_linear"),
    "MCP server should be scanned from codex config.toml",
  );
  assert.ok(
    requireDeployment(response, "hook", "claude-code", "hook.pretooluse-bash-echo-server-hook"),
    "Claude hook should be scanned from settings.json",
  );
  assert.ok(
    requireDeployment(response, "plugin", "opencode", "plugin.server-plugin"),
    "Plugin manifest should be scanned from opencode plugin directory",
  );
  const toolDeployment = requireDeployment(response, "tool", undefined, "tool.room.ledger.read");
  assert.equal(toolDeployment.readonly, true, "OpenGrove tool deployments should be read-only");
  assert.equal(toolDeployment.managedByOpenGrove, true, "OpenGrove tools should be marked as managed");
}

async function assertMcpLifecycle(baseUrl: string, codexHome: string): Promise<void> {
  const deployment = requireDeployment(await getJson(`${baseUrl}/extensions`), "mcp", "codex", "mcp.server_linear");
  const disabled = await postJson(`${baseUrl}/extensions/deployments/disable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(disabled.ok, true, "MCP disable should succeed");
  assert.equal(
    requireDeployment(await getJson(`${baseUrl}/extensions`), "mcp", "codex", "mcp.server_linear").status,
    "disabled",
  );
  assert.ok(!fileText(join(codexHome, "config.toml")).includes("[mcp_servers.server_linear]"));

  const enabled = await postJson(`${baseUrl}/extensions/deployments/enable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(enabled.ok, true, "MCP enable should succeed");
  assert.equal(
    requireDeployment(await getJson(`${baseUrl}/extensions`), "mcp", "codex", "mcp.server_linear").status,
    "enabled",
  );
  assert.ok(fileText(join(codexHome, "config.toml")).includes("[mcp_servers.server_linear]"));
}

async function assertHookLifecycle(baseUrl: string, claudeHome: string): Promise<void> {
  const deployment = requireDeployment(
    await getJson(`${baseUrl}/extensions`),
    "hook",
    "claude-code",
    "hook.pretooluse-bash-echo-server-hook",
  );
  const disabled = await postJson(`${baseUrl}/extensions/deployments/disable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(disabled.ok, true, "hook disable should succeed");
  assert.equal(
    requireDeployment(
      await getJson(`${baseUrl}/extensions`),
      "hook",
      "claude-code",
      "hook.pretooluse-bash-echo-server-hook",
    ).status,
    "disabled",
  );
  assert.ok(!fileText(join(claudeHome, "settings.json")).includes("echo server-hook"));

  const enabled = await postJson(`${baseUrl}/extensions/deployments/enable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(enabled.ok, true, "hook enable should succeed");
  assert.equal(
    requireDeployment(
      await getJson(`${baseUrl}/extensions`),
      "hook",
      "claude-code",
      "hook.pretooluse-bash-echo-server-hook",
    ).status,
    "enabled",
  );
  assert.ok(fileText(join(claudeHome, "settings.json")).includes("echo server-hook"));
}

async function assertPluginLifecycle(baseUrl: string, pluginRoot: string): Promise<void> {
  const deployment = requireDeployment(
    await getJson(`${baseUrl}/extensions`),
    "plugin",
    "opencode",
    "plugin.server-plugin",
  );
  const disabled = await postJson(`${baseUrl}/extensions/deployments/disable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(disabled.ok, true, "plugin disable should succeed");
  assert.equal(
    requireDeployment(await getJson(`${baseUrl}/extensions`), "plugin", "opencode", "plugin.server-plugin").status,
    "disabled",
  );
  assert.ok(
    existsSync(join(pluginRoot, "plugin.json.disabled")),
    "plugin manifest should be renamed to disabled suffix",
  );

  const enabled = await postJson(`${baseUrl}/extensions/deployments/enable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(enabled.ok, true, "plugin enable should succeed");
  assert.equal(
    requireDeployment(await getJson(`${baseUrl}/extensions`), "plugin", "opencode", "plugin.server-plugin").status,
    "enabled",
  );
  assert.ok(existsSync(join(pluginRoot, "plugin.json")), "plugin manifest should be restored");
}

async function assertReadonlyToolLifecycle(baseUrl: string): Promise<void> {
  const deployment = requireDeployment(
    await getJson(`${baseUrl}/extensions`),
    "tool",
    undefined,
    "tool.room.ledger.read",
  );
  const disabled = await postJson(`${baseUrl}/extensions/deployments/disable`, {
    deploymentIds: [deployment.id],
  });
  assert.equal(disabled.ok, true, "tool disable request should be handled");
  assert.deepEqual(disabled.result?.records ?? [], [], "read-only tool disable should not mutate records");
  assert.ok(
    (disabled.result?.warnings ?? []).some((warning) => warning.includes("readonly_or_system_not_modified")),
    "read-only tool disable should return a readonly warning",
  );
  const after = requireDeployment(await getJson(`${baseUrl}/extensions`), "tool", undefined, "tool.room.ledger.read");
  assert.equal(after.status, "enabled", "OpenGrove tool should remain enabled");
}

function kernelSkillDeployments(response: ApiResponse): Array<Record<string, unknown>> {
  return (response.extensions?.deployments ?? []).filter(
    (deployment) =>
      deployment.kind === "skill" &&
      deployment.itemId === "skill.server-smoke" &&
      typeof deployment.kernelId === "string",
  );
}

function requireDeployment(
  response: ApiResponse,
  kind: string,
  kernelId: BridgeKernelId | undefined,
  itemId: string,
): Record<string, unknown> {
  const deployment = (response.extensions?.deployments ?? []).find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.itemId === itemId &&
      (kernelId === undefined || candidate.kernelId === kernelId),
  );
  assert.ok(deployment, `${kind} ${itemId} should be present${kernelId ? ` for ${kernelId}` : ""}`);
  return deployment;
}

function serverUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object", "server should have a bound address");
  return `http://127.0.0.1:${address.port}`;
}

async function getJson(url: string): Promise<ApiResponse> {
  const response = await fetch(url);
  assert.ok(response.ok, `${url} should return HTTP 2xx`);
  return (await response.json()) as ApiResponse;
}

async function postJson(url: string, body: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${url} should return HTTP 2xx`);
  return (await response.json()) as ApiResponse;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    setTimeout(() => resolve(), 1_000).unref();
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

main()
  .then(() => {
    console.log("extension-manager-server-harness ok");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
