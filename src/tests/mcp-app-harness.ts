import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { validateAppManifest } from "../app-builder/manifest.js";
import { packApp, validateAppRoot } from "../app-builder/cli.js";
import { createBridgeState } from "../server/bridge-state.js";
import { cacheAuthSessionUser } from "../server/bridge-security.js";
import { startOpenGroveServer } from "../server/create-server.js";
import { McpAppMediaCache } from "../server/mcp-app-media-cache.js";
import { serveMcpAppSandbox } from "../server/mcp-app-sandbox.js";
import {
  callMountedMcpAppTool,
  createMountedMcpAppContract,
  McpAppToolError,
  type McpAppContract,
} from "../server/mcp-app-runtime.js";
import {
  mountedAppManifestIssue,
  mountedAppRuntimeFingerprint,
  readMountedAppManifest,
  resolveMountedAppTarget,
  type MountedAppTarget,
} from "../server/mounted-apps.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-mcp-app-"));
const appRoot = join(root, "mcp-app-basic");
const workbenchAppRoot = join(root, "workbench-view-tab");
const undeclaredAuthAppRoot = join(root, "mcp-app-no-ww-auth");
const malformedAppRoot = join(root, "malformed-app");
const settingsPath = join(root, "bridge-settings.json");
const mcpAppsClientOptions = {
  capabilities: {
    extensions: {
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    },
  },
};
const previousEnv = {
  OPENGROVE_BRIDGE_SETTINGS_PATH: process.env.OPENGROVE_BRIDGE_SETTINGS_PATH,
  OPENGROVE_MCP_APP_SANDBOX_ORIGIN: process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN,
  OPENGROVE_WEB_AUTH_MODE: process.env.OPENGROVE_WEB_AUTH_MODE,
  OPENGROVE_WW_BASE_URL: process.env.OPENGROVE_WW_BASE_URL,
  MCP_FIXTURE_MISSING_KEY: process.env.MCP_FIXTURE_MISSING_KEY,
};

try {
  createTestApp(appRoot);
  createWorkbenchViewTabApp(workbenchAppRoot);
  createUndeclaredWwAuthTestApp(undeclaredAuthAppRoot);
  mkdirSync(malformedAppRoot, { recursive: true });
  writeFileSync(join(malformedAppRoot, "opengrove.app.json"), '{"id":"malformed-app","title":42', "utf8");
  process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = settingsPath;
  delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
  process.env.OPENGROVE_WEB_AUTH_MODE = "bridge-token";
  process.env.OPENGROVE_WW_BASE_URL = "https://registry.example.test";
  delete process.env.MCP_FIXTURE_MISSING_KEY;
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        mountedApps: [
          { id: "mcp-app-basic", title: "MCP App Basic", path: appRoot, enabled: true },
          { id: "workbench-view-tab", title: "Workbench View Tab", path: workbenchAppRoot, enabled: true },
          { id: "mcp-app-no-ww-auth", title: "MCP App No WW Auth", path: undeclaredAuthAppRoot, enabled: true },
          { id: "malformed-app", title: "Malformed App", path: malformedAppRoot, enabled: true },
        ],
      },
      null,
      2,
    ),
  );

  await testManifestRules();
  const state = createBridgeState({ statePath: join(root, "state.json") });
  const malformedManifest = readMountedAppManifest(malformedAppRoot);
  assert.equal(malformedManifest.status, "invalid");
  assert.equal(mountedAppManifestIssue(malformedAppRoot, malformedManifest), "app_manifest_invalid");
  assert.equal(
    resolveMountedAppTarget(state, "malformed-app"),
    undefined,
    "one malformed App must be isolated without preventing Bridge startup or healthy App mounts",
  );
  const target = resolveMountedAppTarget(state, "mcp-app-basic");
  assert.ok(target, "mcp-app fixture should resolve as a mounted target");
  const contract = createMountedMcpAppContract(target, ["https://bridge.example.test"]);
  assert.equal(contract.protocol, "mcp-apps");
  assert.match(contract.resource.uri, /^ui:\/\/opengrove\//u);
  assert.equal(contract.resource.mimeType, "text/html;profile=mcp-app");
  assert.equal(contract.launcherTool._meta?.ui && typeof contract.launcherTool._meta.ui === "object", true);
  assert.deepEqual(
    contract.tools.map((tool) => tool.name),
    [
      "opengrove.app.workspace.list",
      "opengrove.app.workspace.read",
      "opengrove.app.workspace.write",
      "opengrove.app.media.cache",
      "opengrove.app.command.run",
    ],
  );
  const mediaCacheTool = contract.tools.find((tool) => tool.name === "opengrove.app.media.cache");
  assert.ok(mediaCacheTool);
  assert.match(mediaCacheTool.description, /OPENGROVE_APP_WORKSPACE_ROOT/u);
  assert.deepEqual(mediaCacheTool.outputSchema, {
    type: "object",
    properties: {
      status: { type: "string", enum: ["downloading", "ready", "error"] },
      cachedBytes: { type: "integer", minimum: 0 },
      expectedSize: { type: "integer", minimum: 1 },
      mediaUrl: { type: "string" },
      workspacePath: {
        type: "string",
        pattern: "^\\.cache/opengrove-media/[A-Za-z0-9._-]+$",
      },
      error: { type: "string" },
    },
    required: ["status", "cachedBytes", "expectedSize"],
    additionalProperties: false,
  });
  assert.deepEqual(contract.resource._meta.ui.csp.connectDomains, ["https://api.example.org"]);

  const workbenchTarget = resolveMountedAppTarget(state, "workbench-view-tab");
  assert.ok(workbenchTarget, "file-workbench fixture should resolve as a mounted target");
  const workbenchContract = createMountedMcpAppContract(workbenchTarget, [], "work-management");
  assert.match(workbenchContract.resource.text, /Workbench-owned view/u);
  assert.deepEqual(
    workbenchContract.tools.map((tool) => tool.name),
    ["opengrove.app.workspace.list"],
  );
  const writeOnlyContract = createMountedMcpAppContract(workbenchTarget, [], "write-only");
  assert.deepEqual(
    writeOnlyContract.tools.map((tool) => tool.name),
    ["opengrove.app.workspace.write"],
  );
  const workbenchFingerprint = mountedAppRuntimeFingerprint(workbenchTarget);
  writeFileSync(
    join(workbenchAppRoot, "ui", "work-management.html"),
    "<!doctype html><title>Workbench-owned view rebuilt</title>",
  );
  assert.notEqual(
    mountedAppRuntimeFingerprint(workbenchTarget),
    workbenchFingerprint,
    "changing a View Tab bundle must advance the mounted App runtime revision",
  );
  await assert.rejects(
    () =>
      callMountedMcpAppTool(
        state,
        workbenchTarget,
        "opengrove.app.workspace.write",
        { path: "blocked.txt", content: "blocked" },
        { viewId: "work-management" },
      ),
    (error) => error instanceof McpAppToolError && error.status === 403,
    "a View Tab must only call tools allowlisted by that tab",
  );
  await assert.rejects(
    () => callMountedMcpAppTool(state, workbenchTarget, "opengrove.app.workspace.list", {}, { viewId: "write-only" }),
    (error) => error instanceof McpAppToolError && error.status === 403,
    "tool allowlists from sibling View Tabs must never be merged",
  );
  await assert.rejects(
    async () => createMountedMcpAppContract(workbenchTarget, [], "missing-view"),
    /mcp_app_view_not_found/u,
    "an unknown View Tab id must fail explicitly",
  );
  assert.throws(
    () =>
      createMountedMcpAppContract(
        {
          ...workbenchTarget,
          manifest: {
            ...workbenchTarget.manifest,
            ui: { ...(workbenchTarget.manifest.ui as Record<string, unknown>), surface: "none" },
          },
        },
        [],
        "work-management",
      ),
    /mcp_app_view_tab_requires_file_workbench/u,
    "the runtime must not expose a hidden View Tab from a non-workbench surface",
  );
  assert.throws(
    () => createMountedMcpAppContract(workbenchTarget, [], "bad/id"),
    /mcp_app_view_id_invalid/u,
    "dev-mounted View Tab ids must obey the same URL-safe runtime boundary as packed Apps",
  );
  assert.throws(
    () =>
      createMountedMcpAppContract(
        {
          ...workbenchTarget,
          manifest: {
            ...workbenchTarget.manifest,
            ui: {
              ...(workbenchTarget.manifest.ui as Record<string, unknown>),
              tabs: [
                {
                  id: "duplicate",
                  component: "view",
                  view: { protocol: "mcp-app", entry: "ui/work-management.html", tools: [] },
                },
                {
                  id: "duplicate",
                  component: "view",
                  view: { protocol: "mcp-app", entry: "ui/write-only.html", tools: [] },
                },
              ],
            },
          },
        },
        [],
        "duplicate",
      ),
    /mcp_app_view_id_duplicate/u,
    "dev-mounted View Tab ids must remain unique at runtime",
  );

  const listed = await callMountedMcpAppTool(state, target, "opengrove.app.workspace.list", {});
  assert.equal(Array.isArray((listed.structuredContent as { entries?: unknown[] }).entries), true);
  await callMountedMcpAppTool(state, target, "opengrove.app.workspace.write", {
    path: "runs/from-mcp-app.txt",
    content: "scoped write",
  });
  assert.equal(readFileSync(join(appRoot, "workspace", "runs", "from-mcp-app.txt"), "utf8"), "scoped write");
  const commandResult = await callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
    commandId: "fixture-json",
    args: ["direct"],
    parseJson: true,
  });
  assert.deepEqual(
    (commandResult.structuredContent as { json?: unknown }).json,
    { ok: true, argument: "direct" },
    "a declared command must execute through the MCP wrapper and return parsed JSON",
  );
  assert.equal(
    "stdout" in (commandResult.structuredContent as Record<string, unknown>),
    false,
    "a parsed command result must not duplicate its JSON as raw stdout",
  );
  const silentCommandResult = await callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
    commandId: "fixture-silent",
  });
  assert.equal(
    "stdout" in (silentCommandResult.structuredContent as Record<string, unknown>),
    false,
    "an empty structured result must not invent raw stdout",
  );
  assert.equal(
    "json" in (silentCommandResult.structuredContent as Record<string, unknown>),
    false,
    "an exit-zero command with empty stdout must remain successful without an invented JSON value",
  );
  await assert.rejects(
    () =>
      callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
        commandId: "fixture-invalid-json",
      }),
    (error) => error instanceof McpAppToolError && error.status === 422 && error.message === "command_output_not_json",
    "non-empty invalid JSON must still fail the structured-result contract",
  );
  await assert.rejects(
    () =>
      callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
        commandId: "fixture-large-json",
        parseJson: true,
      }),
    (error) =>
      error instanceof McpAppToolError && error.status === 413 && error.message === "structured_output_too_large",
    "an oversized structured result must fail explicitly instead of returning partial JSON",
  );
  const truncatedTextResult = await callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
    commandId: "fixture-large-json",
    parseJson: false,
  });
  assert.equal((truncatedTextResult.structuredContent as Record<string, unknown>).stdoutTruncated, true);
  assert.equal(typeof (truncatedTextResult.structuredContent as Record<string, unknown>).stdout, "string");
  await assert.rejects(
    () =>
      callMountedMcpAppTool(state, target, "opengrove.app.command.run", {
        commandId: "fixture-missing-env",
        parseJson: true,
      }),
    (error) =>
      error instanceof McpAppToolError && error.status === 409 && error.message.includes("MCP_FIXTURE_MISSING_KEY"),
    "the selected command must still fail with a specific readiness error when its own environment is missing",
  );
  const cachedFixture = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const cachedFixtureKey = "cached-media-fixture";
  const cachedFixtureDirectory = join(appRoot, "workspace", ".cache", "opengrove-media");
  mkdirSync(cachedFixtureDirectory, { recursive: true });
  writeFileSync(
    join(cachedFixtureDirectory, `${createHash("sha256").update(cachedFixtureKey).digest("hex")}.mp4`),
    cachedFixture,
  );
  const cachedMediaResult = await callMountedMcpAppTool(state, target, "opengrove.app.media.cache", {
    sourceUrl: "https://api.example.org/cached.mp4",
    cacheKey: cachedFixtureKey,
    expectedSize: cachedFixture.byteLength,
    contentType: "video/mp4",
  });
  const cachedMedia = cachedMediaResult.structuredContent as {
    mediaUrl?: string;
    workspacePath?: string;
  };
  const cachedMediaUrl = cachedMedia.mediaUrl;
  assert.match(cachedMediaUrl ?? "", /^\.\/mcp-app-media\/[A-Za-z0-9_-]+$/u);
  assert.match(cachedMedia.workspacePath ?? "", /^\.cache\/opengrove-media\/[0-9a-f]{64}\.mp4$/u);
  await assert.rejects(
    () => callMountedMcpAppTool(state, target, "opengrove.app.command.run", { commandId: "sh" }),
    (error) => error instanceof McpAppToolError && error.status === 403,
    "undeclared per-App tools must be rejected",
  );
  await assert.rejects(
    () =>
      callMountedMcpAppTool(state, target, "opengrove.app.media.cache", {
        sourceUrl: "https://attacker.invalid/video.mp4",
        cacheKey: "blocked-source",
        expectedSize: 8,
        contentType: "video/mp4",
      }),
    (error) => error instanceof McpAppToolError && error.status === 403 && error.message === "media_source_not_allowed",
    "media cache downloads must stay inside the App CSP allowlist",
  );
  await assert.rejects(
    () => callMountedMcpAppTool(state, target, "opengrove.app.workspace.read", { path: "../../outside" }),
    (error) => error instanceof McpAppToolError && error.status === 404,
    "workspace traversal must be rejected",
  );
  symlinkSync(root, join(appRoot, "workspace", "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () =>
      callMountedMcpAppTool(state, target, "opengrove.app.workspace.write", {
        path: "escape/outside.txt",
        content: "must not escape",
      }),
    (error) => error instanceof McpAppToolError && error.status === 400,
    "workspace writes through symlinks must be rejected",
  );

  await testIndependentHostReadsOpenGroveContract(contract);
  await testOpenGroveBridgeAcceptsOfficialUpstreamApp(contract);
  await testSandboxAndHttpBoundaries(settingsPath, cachedMediaUrl!);
  await testSandboxMediaLease();
  await testHostedSandboxCsp();
  console.log("MCP App harness passed.");
} finally {
  restoreEnv(previousEnv);
  rmSync(root, { recursive: true, force: true });
}

async function testManifestRules(): Promise<void> {
  const untrustedRoot = join(root, "untrusted-legacy");
  mkdirSync(join(untrustedRoot, "ui"), { recursive: true });
  writeFileSync(join(untrustedRoot, "ui", "index.html"), "<!doctype html>");
  writeFileSync(
    join(untrustedRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "third-party-dashboard",
      title: "Third Party Dashboard",
      ui: { kind: "web-app", entry: "ui/index.html" },
      store: { packageKey: "thirdparty.dashboard" },
    }),
  );
  assert.equal(validateAppRoot(untrustedRoot).ok, false, "validate must reject new legacy web Apps");
  assert.throws(
    () => packApp(untrustedRoot, { outputPath: join(root, "untrusted.tgz") }),
    /app_not_valid/u,
    "publish packaging must reject new legacy web Apps",
  );

  const untrustedLegacy = validateAppManifest({
    id: "third-party-dashboard",
    title: "Third Party Dashboard",
    ui: { kind: "web-app", entry: "ui/index.html" },
    store: { packageKey: "thirdparty.dashboard" },
  });
  assert.equal(untrustedLegacy.ok, false);
  assert.match(untrustedLegacy.issues.join("\n"), /no longer supported/u);
  assert.match(untrustedLegacy.issues.join("\n"), /ui\.surface=view/u);
  assert.match(untrustedLegacy.issues.join("\n"), /OPENGROVE_APP_SPEC\.md/u);

  const retiredKnowledgeVault = validateAppManifest({
    id: "knowledge-vault",
    title: "Knowledge Vault",
    ui: { surface: "file-workbench", workspace: "workspace" },
    workspace: { path: "workspace" },
    store: { packageKey: "opengrove.knowledge-vault" },
  });
  assert.equal(retiredKnowledgeVault.ok, false);
  assert.match(retiredKnowledgeVault.issues.join("\n"), /app identity is retired/u);
}

async function testIndependentHostReadsOpenGroveContract(contract: McpAppContract): Promise<void> {
  const server = createContractMcpServer(contract);
  const client = new Client({ name: "independent-host", version: "1.0.0" }, mcpAppsClientOptions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === contract.launcherTool.name),
      true,
    );
    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.mimeType, "text/html;profile=mcp-app");
    const resource = await client.readResource({ uri: contract.resource.uri });
    assert.equal(resource.contents[0]?.uri, contract.resource.uri);
    assert.equal("text" in resource.contents[0]!, true);
  } finally {
    await client.close();
    await server.close();
  }
}

async function testOpenGroveBridgeAcceptsOfficialUpstreamApp(contract: McpAppContract): Promise<void> {
  const mcpServer = createContractMcpServer(contract);
  const mcpClient = new Client({ name: "opengrove-host-test", version: "1.0.0" }, mcpAppsClientOptions);
  const [mcpClientTransport, mcpServerTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(mcpServerTransport);
  await mcpClient.connect(mcpClientTransport);

  const bridge = new AppBridge(
    mcpClient,
    { name: "OpenGrove", version: "0.5.4" },
    { serverTools: {}, serverResources: {}, logging: {} },
  );
  const upstreamApp = new App(
    { name: "upstream-official-app", version: "1.0.0" },
    {},
    { autoResize: false, strict: true },
  );
  const [bridgeTransport, appTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([bridge.connect(bridgeTransport), upstreamApp.connect(appTransport)]);
    const result = await upstreamApp.callServerTool({
      name: "opengrove.app.workspace.list",
      arguments: {},
    });
    assert.equal(result.structuredContent?.source, "independent-contract-server");
  } finally {
    await appTransport.close();
    await bridgeTransport.close();
    await mcpClient.close();
    await mcpServer.close();
  }
}

function createContractMcpServer(contract: McpAppContract): Server {
  const server = new Server(
    { name: "independent-contract-server", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {} } },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: contract.resource.uri,
        name: "OpenGrove App UI",
        mimeType: contract.resource.mimeType,
        _meta: contract.resource._meta,
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    assert.equal(request.params.uri, contract.resource.uri);
    return { contents: [contract.resource] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [contract.launcherTool, ...contract.tools],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: request.params.name }],
    structuredContent: { source: "independent-contract-server", name: request.params.name },
  }));
  return server;
}

async function testSandboxAndHttpBoundaries(_settingsPath: string, cachedMediaUrl: string): Promise<void> {
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    statePath: join(root, "http-state.json"),
  });
  try {
    if (!server.listening) await new Promise<void>((resolvePromise) => server.once("listening", resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const contractResponse = await fetch(`${baseUrl}/api/apps/mcp-app-basic/mcp-app/contract`, {
      headers: {
        "x-forwarded-host": "bridge.example.test",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(contractResponse.status, 200);
    const contractPayload = (await contractResponse.json()) as { contract?: McpAppContract };
    assert.deepEqual(
      contractPayload.contract?.resource._meta.ui.csp.connectDomains,
      ["https://api.example.org"],
      "the externally visible HTTPS Bridge origin must be removed behind a reverse proxy",
    );

    const workbenchContractResponse = await fetch(
      `${baseUrl}/api/apps/workbench-view-tab/mcp-app/contract?view=work-management`,
    );
    assert.equal(workbenchContractResponse.status, 200);
    const workbenchContractPayload = (await workbenchContractResponse.json()) as { contract?: McpAppContract };
    assert.match(workbenchContractPayload.contract?.resource.text ?? "", /Workbench-owned view/u);
    assert.deepEqual(
      workbenchContractPayload.contract?.tools.map((tool) => tool.name),
      ["opengrove.app.workspace.list"],
    );
    assert.deepEqual(
      workbenchContractPayload.contract?.resource._meta.ui.csp.connectDomains,
      ["https://app-api.example.test"],
      "a View Tab CSP must never approve direct access to the configured WW origin",
    );

    const workbenchDeniedTool = await fetch(
      `${baseUrl}/api/apps/workbench-view-tab/mcp-app/call-tool?view=work-management`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "opengrove.app.workspace.write",
          arguments: { path: "blocked.txt", content: "blocked" },
        }),
      },
    );
    assert.equal(workbenchDeniedTool.status, 403);

    const deniedTool = await fetch(`${baseUrl}/api/apps/mcp-app-basic/mcp-app/call-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "opengrove.app.command.run", arguments: { commandId: "sh" } }),
    });
    assert.equal(deniedTool.status, 403);

    const allowedCommand = await fetch(`${baseUrl}/api/apps/mcp-app-basic/mcp-app/call-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "opengrove.app.command.run",
        arguments: { commandId: "fixture-json", args: ["http"], parseJson: true },
      }),
    });
    assert.equal(allowedCommand.status, 200);
    const allowedCommandPayload = (await allowedCommand.json()) as {
      result?: { structuredContent?: { json?: unknown } };
    };
    assert.deepEqual(allowedCommandPayload.result?.structuredContent?.json, { ok: true, argument: "http" });

    const accessToken = "mcp-app-route-access";
    const sessionId = "mcp-app-route-session";
    cacheAuthSessionUser(
      sessionId,
      accessToken,
      {
        userId: "mcp-app-route-user",
        email: "mcp-app-route@example.test",
        displayName: "MCP App Route User",
        role: "user",
      },
      3_600,
    );
    const authenticatedCommand = await fetch(`${baseUrl}/api/apps/mcp-app-basic/mcp-app/call-tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `opengrove_auth_access=${accessToken}; opengrove_auth_refresh=mcp-app-route-refresh; opengrove_auth_session=${sessionId}`,
      },
      body: JSON.stringify({
        name: "opengrove.app.command.run",
        arguments: { commandId: "fixture-auth", parseJson: true },
      }),
    });
    assert.equal(authenticatedCommand.status, 200);
    const authenticatedCommandPayload = (await authenticatedCommand.json()) as {
      result?: { structuredContent?: { json?: unknown } };
    };
    assert.deepEqual(
      authenticatedCommandPayload.result?.structuredContent?.json,
      {
        accessToken,
        baseUrl: "https://registry.example.test",
        userId: "mcp-app-route-user",
      },
      "an MCP App command must receive the current signed-in user's declared WW runtime auth",
    );

    const authenticatedUndeclaredCommand = await fetch(`${baseUrl}/api/apps/mcp-app-no-ww-auth/mcp-app/call-tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `opengrove_auth_access=${accessToken}; opengrove_auth_refresh=mcp-app-route-refresh; opengrove_auth_session=${sessionId}`,
      },
      body: JSON.stringify({
        name: "opengrove.app.command.run",
        arguments: { commandId: "fixture-auth", parseJson: true },
      }),
    });
    assert.equal(authenticatedUndeclaredCommand.status, 200);
    const authenticatedUndeclaredPayload = (await authenticatedUndeclaredCommand.json()) as {
      result?: { structuredContent?: { json?: unknown } };
    };
    assert.deepEqual(
      authenticatedUndeclaredPayload.result?.structuredContent?.json,
      {
        baseUrl: "https://registry.example.test",
      },
      "a signed-in user must not grant WW credentials to an App that did not declare runtimeEnv.wwAuth",
    );

    const settingsLegacyWorkbenchRoot = join(root, "settings-legacy-workbench");
    mkdirSync(join(settingsLegacyWorkbenchRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(settingsLegacyWorkbenchRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "settings-legacy-workbench",
        title: "Settings Legacy Workbench",
        ui: { kind: "file-workbench", workspace: "workspace" },
      }),
      "utf8",
    );
    const mountLegacyWorkbench = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mountedApps: [
          { id: "mcp-app-basic", title: "MCP App Basic", path: appRoot, enabled: true },
          {
            id: "settings-legacy-workbench",
            title: "Settings Legacy Workbench",
            path: settingsLegacyWorkbenchRoot,
            enabled: true,
          },
        ],
      }),
    });
    assert.equal(
      mountLegacyWorkbench.status,
      200,
      "the settings mount boundary must migrate a supported legacy App before enabling it",
    );
    const settingsMigratedManifest = JSON.parse(
      readFileSync(join(settingsLegacyWorkbenchRoot, "opengrove.app.json"), "utf8"),
    ) as { ui?: { kind?: string; surface?: string } };
    assert.equal(settingsMigratedManifest.ui?.kind, undefined);
    assert.equal(settingsMigratedManifest.ui?.surface, "file-workbench");
    assert.equal(existsSync(join(settingsLegacyWorkbenchRoot, "opengrove.app.json.pre-ui-surface-v1.bak")), true);

    const removeLegacyMount = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mountedApps: [{ id: "mcp-app-basic", title: "MCP App Basic", path: appRoot, enabled: true }],
      }),
    });
    assert.equal(removeLegacyMount.status, 200, "the quarantined legacy mount must remain removable");

    const sandbox = await requestWithHost(address.port, "/mcp-app-sandbox", `mcp-app.localhost:${address.port}`);
    assert.equal(sandbox.status, 200);
    assert.match(sandbox.headers["content-security-policy"] ?? "", /connect-src 'none'/u);
    assert.match(
      sandbox.headers["content-security-policy"] ?? "",
      /media-src[^;]+'self'/u,
      "the opaque View may load capability media only from its isolated sandbox origin",
    );
    const trailingSlashSandbox = await requestWithHost(
      address.port,
      "/mcp-app-sandbox/?hostOrigin=https%3A%2F%2Fhost.example.test",
      `mcp-app.localhost:${address.port}`,
    );
    assert.equal(trailingSlashSandbox.status, 307, "the directory-shaped sandbox URL must be canonicalized");
    assert.equal(
      trailingSlashSandbox.headers.location,
      "../mcp-app-sandbox?hostOrigin=https%3A%2F%2Fhost.example.test",
      "the relative redirect must preserve both a reverse-proxy mount prefix and the sandbox query",
    );
    const sandboxScript = await requestWithHost(
      address.port,
      "/mcp-app-sandbox.js",
      `mcp-app.localhost:${address.port}`,
    );
    assert.equal(sandboxScript.status, 200);
    assert.match(sandboxScript.body, /allow-scripts allow-forms/u);
    assert.doesNotMatch(sandboxScript.body, /allow-same-origin/u);

    const sameOriginBridgeAttempt = await requestWithHost(
      address.port,
      "/api/bootstrap",
      `mcp-app.localhost:${address.port}`,
    );
    assert.equal(sameOriginBridgeAttempt.status, 404, "sandbox origin must not expose any Bridge API");
    const unknownMediaCapability = await requestWithHost(
      address.port,
      "/mcp-app-media/not-a-capability",
      `mcp-app.localhost:${address.port}`,
    );
    assert.equal(unknownMediaCapability.status, 404, "local media paths require an unguessable Host capability");
    const cachedMediaRange = await requestWithHost(
      address.port,
      new URL(cachedMediaUrl, `${baseUrl}/mcp-app-sandbox`).pathname,
      `mcp-app.localhost:${address.port}`,
      { range: "bytes=10-19" },
    );
    assert.equal(cachedMediaRange.status, 206);
    assert.equal(cachedMediaRange.headers["content-range"], "bytes 10-19/36");
    assert.equal(cachedMediaRange.headers["access-control-allow-origin"], "*");
    assert.equal(cachedMediaRange.body, "abcdefghij");
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
}

async function testHostedSandboxCsp(): Promise<void> {
  const sandboxOrigin = "https://sandbox.example.test";
  process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN = sandboxOrigin;
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    statePath: join(root, "hosted-sandbox-state.json"),
  });
  try {
    if (!server.listening) await new Promise<void>((resolvePromise) => server.once("listening", resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const sandbox = await requestWithHost(address.port, "/mcp-app-sandbox", "sandbox.example.test");
    assert.equal(sandbox.status, 200);
    assert.match(
      sandbox.headers["content-security-policy"] ?? "",
      /media-src[^;]+'self'/u,
      "hosted sandbox must allow the opaque View to play capability media from the real sandbox origin via self",
    );
  } finally {
    delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
}

async function testSandboxMediaLease(): Promise<void> {
  const mediaSize = 32 * 1024 * 1024;
  const workspaceRoot = join(root, "lease-http-workspace");
  const cacheDirectory = join(workspaceRoot, ".cache", "opengrove-media");
  const sourceKey = "lease-http-source";
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(
    join(cacheDirectory, `${createHash("sha256").update(sourceKey).digest("hex")}.mp4`),
    Buffer.alloc(mediaSize),
  );
  const target = {
    localAppId: "lease-http-app",
    id: "lease-http-app",
    title: "Lease HTTP app",
    appRoot: join(root, "lease-http-app"),
    workspaceRoot,
    workspace: { kind: "local", appId: "lease-http-app", root: workspaceRoot },
    manifest: {
      id: "lease-http-app",
      title: "Lease HTTP app",
      ui: {
        surface: "view",
        view: {
          protocol: "mcp-app",
          entry: "ui/index.html",
          tools: ["opengrove.app.media.cache"],
          csp: { connectDomains: ["https://media.example.test"] },
        },
      },
    },
  } satisfies MountedAppTarget;
  const cache = new McpAppMediaCache({
    maxBytes: 48 * 1024 * 1024,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () =>
      new Response(Buffer.alloc(mediaSize), {
        status: 200,
        headers: { "content-length": String(mediaSize), "content-type": "video/mp4" },
      }),
  });
  const sourceInput = {
    sourceUrl: "https://media.example.test/source.mp4",
    cacheKey: sourceKey,
    expectedSize: mediaSize,
    contentType: "video/mp4",
  };
  const replacementInput = {
    sourceUrl: "https://media.example.test/replacement.mp4",
    cacheKey: "lease-http-replacement",
    expectedSize: mediaSize,
    contentType: "video/mp4",
  };
  const ready = await cache.prepare(target, sourceInput);
  assert.equal(ready.status, "ready");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "mcp-app.localhost"}`);
    serveMcpAppSandbox(
      request,
      response,
      url,
      {
        authMode: "bridge-token",
        allowedOrigins: [],
      },
      cache,
    );
  });
  try {
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const host = `mcp-app.localhost:${address.port}`;
    const activeRange = await openPausedRange(
      address.port,
      new URL(ready.mediaUrl ?? "", `http://${host}/mcp-app-sandbox`).pathname,
      host,
      `bytes=0-${mediaSize - 1}`,
    );
    const parallelRange = await requestWithHost(
      address.port,
      new URL(ready.mediaUrl ?? "", `http://${host}/mcp-app-sandbox`).pathname,
      host,
      { range: "bytes=32-47" },
    );
    assert.equal(
      parallelRange.status,
      206,
      "parallel Range requests for the same media must stay available during playback",
    );
    await assert.rejects(
      cache.prepare(target, replacementInput),
      /media_cache_capacity_exceeded/u,
      "LRU must not delete a file being played while an active Range holds its lease",
    );
    activeRange.response.destroy();
    await activeRange.closed;

    let replacementStarted = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const result = await cache.prepare(target, replacementInput);
        replacementStarted = result.status === "downloading" || result.status === "ready";
        if (replacementStarted) break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "media_cache_capacity_exceeded") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(replacementStarted, true, "the lease must be released after the Range response disconnects");
    assert.equal(
      cache.open(ready.mediaUrl ?? ""),
      undefined,
      "the original file becomes LRU-evictable only after the lease is released",
    );
    let replacementReady = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await cache.prepare(target, replacementInput);
      replacementReady = result.status === "ready";
      if (replacementReady) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(replacementReady, true, "the replacement file must be fully written after the lease is released");
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
}

function openPausedRange(
  port: number,
  path: string,
  host: string,
  range: string,
): Promise<{ response: import("node:http").IncomingMessage; closed: Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host, range } }, (response) => {
      const closed = new Promise<void>((resolveClosed) => response.once("close", resolveClosed));
      response.once("data", () => {
        response.pause();
        resolvePromise({ response, closed });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function requestWithHost(
  port: number,
  path: string,
  host: string,
  extraHeaders: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path, headers: { host, ...extraHeaders } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [key, String(value ?? "")]),
            ),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function createTestApp(targetRoot: string): void {
  mkdirSync(join(targetRoot, "ui"), { recursive: true });
  mkdirSync(join(targetRoot, "workspace"), { recursive: true });
  mkdirSync(join(targetRoot, "bin"), { recursive: true });
  writeFileSync(
    join(targetRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "mcp-app-basic",
        title: "MCP App Basic",
        version: "0.1.0",
        ui: {
          surface: "view",
          workspace: "workspace",
          view: {
            protocol: "mcp-app",
            entry: "ui/index.html",
            tools: [
              "opengrove.app.workspace.list",
              "opengrove.app.workspace.read",
              "opengrove.app.workspace.write",
              "opengrove.app.media.cache",
              "opengrove.app.command.run",
            ],
            csp: {
              connectDomains: ["https://*.example.test", "https://api.example.org"],
              resourceDomains: [],
              frameDomains: [],
              baseUriDomains: [],
            },
          },
        },
        workspace: { path: "workspace" },
        capabilities: {
          cli: [
            { id: "fixture-json", path: "bin/fixture-json.js" },
            { id: "fixture-large-json", path: "bin/fixture-large-json.js" },
            { id: "fixture-silent", path: "bin/fixture-silent.js" },
            { id: "fixture-invalid-json", path: "bin/fixture-invalid-json.js" },
            {
              id: "fixture-missing-env",
              path: "bin/fixture-json.js",
              env: ["MCP_FIXTURE_MISSING_KEY"],
            },
            {
              id: "fixture-auth",
              path: "bin/fixture-auth.js",
            },
          ],
        },
        runtimeEnv: { wwAuth: true },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(targetRoot, "ui", "index.html"), "<!doctype html><title>MCP App fixture</title>");
  writeFileSync(join(targetRoot, "workspace", "hello.txt"), "hello");
  writeFileSync(
    join(targetRoot, "bin", "fixture-json.js"),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, argument: process.argv[2] || "" }));\n',
  );
  chmodSync(join(targetRoot, "bin", "fixture-json.js"), 0o755);
  writeFileSync(
    join(targetRoot, "bin", "fixture-large-json.js"),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ payload: "暗".repeat(100000) }));\n',
  );
  chmodSync(join(targetRoot, "bin", "fixture-large-json.js"), 0o755);
  writeFileSync(join(targetRoot, "bin", "fixture-silent.js"), "#!/usr/bin/env node\n");
  chmodSync(join(targetRoot, "bin", "fixture-silent.js"), 0o755);
  writeFileSync(
    join(targetRoot, "bin", "fixture-invalid-json.js"),
    "#!/usr/bin/env node\nprocess.stdout.write('not-json');\n",
  );
  chmodSync(join(targetRoot, "bin", "fixture-invalid-json.js"), 0o755);
  writeFileSync(
    join(targetRoot, "bin", "fixture-auth.js"),
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ accessToken: process.env.OPENGROVE_WW_ACCESS_TOKEN, baseUrl: process.env.OPENGROVE_WW_BASE_URL, userId: process.env.OPENGROVE_WW_USER_ID }));\n",
  );
  chmodSync(join(targetRoot, "bin", "fixture-auth.js"), 0o755);
}

function createWorkbenchViewTabApp(targetRoot: string): void {
  mkdirSync(join(targetRoot, "ui"), { recursive: true });
  mkdirSync(join(targetRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(targetRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "workbench-view-tab",
        title: "Workbench View Tab",
        version: "0.1.0",
        ui: {
          surface: "file-workbench",
          workspace: "workspace",
          tabs: [
            { component: "file-tree", label: "Files" },
            {
              id: "work-management",
              component: "view",
              label: "Work management",
              view: {
                protocol: "mcp-app",
                entry: "ui/work-management.html",
                tools: ["opengrove.app.workspace.list"],
                csp: {
                  connectDomains: ["https://registry.example.test", "https://app-api.example.test"],
                },
              },
            },
            {
              id: "write-only",
              component: "view",
              label: "Write only",
              view: {
                protocol: "mcp-app",
                entry: "ui/work-management.html",
                tools: ["opengrove.app.workspace.write"],
              },
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(targetRoot, "ui", "work-management.html"), "<!doctype html><title>Workbench-owned view</title>");
}

function createUndeclaredWwAuthTestApp(targetRoot: string): void {
  mkdirSync(join(targetRoot, "ui"), { recursive: true });
  mkdirSync(join(targetRoot, "workspace"), { recursive: true });
  mkdirSync(join(targetRoot, "bin"), { recursive: true });
  writeFileSync(
    join(targetRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "mcp-app-no-ww-auth",
        title: "MCP App No WW Auth",
        version: "0.1.0",
        ui: {
          surface: "view",
          workspace: "workspace",
          view: {
            protocol: "mcp-app",
            entry: "ui/index.html",
            tools: ["opengrove.app.command.run"],
          },
        },
        workspace: { path: "workspace" },
        capabilities: {
          cli: [{ id: "fixture-auth", path: "bin/fixture-auth.js" }],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(targetRoot, "ui", "index.html"), "<!doctype html><title>MCP App no auth fixture</title>");
  writeFileSync(
    join(targetRoot, "bin", "fixture-auth.js"),
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ accessToken: process.env.OPENGROVE_WW_ACCESS_TOKEN, baseUrl: process.env.OPENGROVE_WW_BASE_URL, userId: process.env.OPENGROVE_WW_USER_ID }));\n",
  );
  chmodSync(join(targetRoot, "bin", "fixture-auth.js"), 0o755);
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
