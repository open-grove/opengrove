import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { build } from "esbuild";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-workspace-resource-security-"));
const entryPath = join(tempDir, "entry.mjs");
const bundlePath = join(tempDir, "bundle.mjs");
const workspaceStoreImport = join(projectRoot, "src", "server", "workspace-store.ts");
const workspaceRootImport = join(projectRoot, "src", "server", "workspace-root.ts");
const workspaceRouteImport = join(projectRoot, "src", "server", "routes", "workspace-resources.ts");
const localResourceRouteImport = join(projectRoot, "src", "server", "routes", "local-resources.ts");
const localPathActionsImport = join(projectRoot, "src", "local-path-actions.ts");

await writeFile(
  entryPath,
  `
  import assert from "node:assert/strict";
  import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { Writable } from "node:stream";
  import { LocalFilesystemWorkspaceStore, resolveExistingContainedPath, safeResolveInside } from ${JSON.stringify(workspaceStoreImport)};
  import { resolveBridgeWorkspaceRoot, resolveConfiguredBridgeWorkspaceRoot } from ${JSON.stringify(workspaceRootImport)};
  import { handleWorkspaceResourceRoute } from ${JSON.stringify(workspaceRouteImport)};
  import { createLocalResourceRevealGate, handleLocalResourceRoute } from ${JSON.stringify(localResourceRouteImport)};
  import { openLocalPath } from ${JSON.stringify(localPathActionsImport)};

  export const done = (async () => {
  class FakeResponse extends Writable {
    status = 200;
    headers = {};
    chunks = [];
    done;
    #resolveDone;

    constructor() {
      super();
      this.done = new Promise((resolve) => {
        this.#resolveDone = resolve;
      });
      this.once("finish", () => this.#resolveDone());
    }

    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
      return this;
    }

    _write(chunk, _encoding, callback) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    }
  }

  const root = await mkdtemp(join(tmpdir(), "og-resource-root-"));
  const outside = await mkdtemp(join(tmpdir(), "og-resource-outside-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "docs", "note.md"), "# Note\\nhello\\n", "utf8");
    await writeFile(join(root, "docs", "large.txt"), "0123456789", "utf8");
    await writeFile(join(root, "assets", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    const outsideLinkPath = "docs/outside-link/secret.txt";
    const insideLinkPath = "docs-link/note.md";
    await symlink(outside, join(root, "docs", "outside-link"), directoryLinkType);
    await symlink(join(root, "docs"), join(root, "docs-link"), directoryLinkType);

    assert.equal(safeResolveInside(root, "../secret.txt"), undefined);
    assert.equal(safeResolveInside(root, join(root, "docs", "note.md")), undefined);
    assert.equal(resolveExistingContainedPath(root, outsideLinkPath), undefined);
    assert.ok(resolveExistingContainedPath(root, insideLinkPath));
    assert.equal(resolveConfiguredBridgeWorkspaceRoot({ workspaceRoot: root }), root);
    assert.notEqual(resolveBridgeWorkspaceRoot({ workspaceRoot: "" }), "");

    const store = new LocalFilesystemWorkspaceStore();
    const scope = { kind: "local", appId: "workspace", root };
    assert.equal(store.readFile(scope, outsideLinkPath), undefined);
    assert.equal(store.openRawFile(scope, outsideLinkPath), undefined);
    assert.ok(store.readFile(scope, insideLinkPath, { textSizeLimit: 100 })?.content?.includes("hello"));

    const metadata = await callRoute({ root, method: "POST", path: "/workspace/resource/metadata", body: { path: "docs/note.md" } });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.json.ok, true);
    assert.equal(metadata.json.exists, true);
    assert.equal(metadata.json.mimeType, "text/markdown; charset=utf-8");

    const missing = await callRoute({ root, method: "POST", path: "/workspace/resource/metadata", body: { path: "docs/missing.md" } });
    assert.equal(missing.status, 200);
    assert.equal(missing.json.ok, true);
    assert.equal(missing.json.exists, false);

    const dotdot = await callRoute({ root, method: "POST", path: "/workspace/resource/read", body: { path: "../secret.txt" } });
    assert.equal(dotdot.status, 403);
    assert.equal(dotdot.json.error, "workspace_resource_outside_root");

    const absolute = await callRoute({ root, method: "POST", path: "/workspace/resource/read", body: { path: join(root, "docs", "note.md") } });
    assert.equal(absolute.status, 403);

    const outsideLink = await callRoute({ root, method: "POST", path: "/workspace/resource/read", body: { path: outsideLinkPath } });
    assert.equal(outsideLink.status, 404);

    const insideLink = await callRoute({ root, method: "POST", path: "/workspace/resource/read", body: { path: insideLinkPath, maxBytes: 100 } });
    assert.equal(insideLink.status, 200);
    assert.equal(insideLink.json.file.content.includes("hello"), true);

    const truncated = await callRoute({ root, method: "POST", path: "/workspace/resource/read", body: { path: "docs/large.txt", maxBytes: 4 } });
    assert.equal(truncated.status, 200);
    assert.equal(truncated.json.file.content, undefined);
    assert.equal(truncated.json.file.contentTruncated, true);

    const raw = await callRoute({ root, method: "GET", path: "/workspace/resource/raw", search: { path: "assets/pixel.png" } });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["content-type"], "image/png");
    assert.equal(Buffer.concat(raw.chunks).length, 4);

    const rawOutside = await callRoute({ root, method: "GET", path: "/workspace/resource/raw", search: { path: "../secret.txt" } });
    assert.equal(rawOutside.status, 403);

    const unconfigured = await callRoute({
      root: "",
      method: "POST",
      path: "/workspace/resource/metadata",
      body: { path: "docs/note.md" },
    });
    assert.equal(unconfigured.status, 400);
    assert.equal(unconfigured.json.error, "workspace_root_not_configured");

    const outsideFile = join(outside, "secret.txt");
    const revealCalls = [];
    const revealed = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      body: { path: outsideFile },
      reveal: async (path) => revealCalls.push(path),
    });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.json.target, "file-manager");
    assert.deepEqual(revealCalls, [await realpath(outsideFile)]);

    const relativeReveal = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      body: { path: "secret.txt" },
    });
    assert.equal(relativeReveal.status, 400);
    assert.equal(relativeReveal.json.error, "local_resource_absolute_path_required");

    const missingReveal = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      body: { path: join(outside, "missing.txt") },
    });
    assert.equal(missingReveal.status, 404);
    assert.equal(missingReveal.json.error, "local_resource_not_found");

    const remoteReveal = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      profile: "server",
      body: { path: outsideFile },
    });
    assert.equal(remoteReveal.status, 501);
    assert.equal(remoteReveal.json.error, "local_resource_unsupported_for_profile");

    const unknownRemoteRoute = await callLocalResourceRoute({
      method: "GET",
      path: "/local-resource/anything",
      profile: "server",
    });
    assert.equal(unknownRemoteRoute.status, 404);
    assert.equal(unknownRemoteRoute.json.error, "not_found");

    const failedReveal = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      body: { path: outsideFile },
      reveal: async () => {
        throw new Error("platform launcher exploded");
      },
    });
    assert.equal(failedReveal.status, 500);
    assert.equal(failedReveal.json.error, "local_resource_reveal_failed");

    const revealGate = createLocalResourceRevealGate({ maxStarts: 2, windowMs: 1_000, now: () => 100 });
    for (let index = 0; index < 2; index += 1) {
      const response = await callLocalResourceRoute({
        method: "POST",
        path: "/local-resource/reveal",
        body: { path: outsideFile },
        reveal: async () => undefined,
        revealGate,
      });
      assert.equal(response.status, 200);
    }
    const rateLimitedReveal = await callLocalResourceRoute({
      method: "POST",
      path: "/local-resource/reveal",
      body: { path: outsideFile },
      reveal: async () => undefined,
      revealGate,
    });
    assert.equal(rateLimitedReveal.status, 429);
    assert.equal(rateLimitedReveal.json.error, "local_resource_rate_limited");

    const launchCalls = [];
    const actionDependencies = (platform, directory = false) => ({
      platform,
      stat: async () => ({ isDirectory: () => directory }),
      run: async (file, args) => launchCalls.push({ mode: "run", file, args }),
      launch: async (file, args) => launchCalls.push({ mode: "launch", file, args }),
    });
    await openLocalPath("C:\\\\work\\\\report.txt", "reveal", actionDependencies("win32"));
    assert.deepEqual(launchCalls.pop(), {
      mode: "launch",
      file: "explorer.exe",
      args: ["/select,C:\\\\work\\\\report.txt"],
    });
    await openLocalPath("/tmp/report.txt", "reveal", actionDependencies("linux"));
    assert.deepEqual(launchCalls.pop(), { mode: "run", file: "xdg-open", args: ["/tmp"] });
    await openLocalPath("/tmp/report.txt", "reveal", actionDependencies("darwin"));
    assert.deepEqual(launchCalls.pop(), { mode: "run", file: "open", args: ["-R", "/tmp/report.txt"] });

    console.log("workspace-resource-security-harness ok");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  async function callRoute(options) {
    const params = new URLSearchParams(options.search || {});
    const url = new URL("http://127.0.0.1" + options.path + (params.size ? "?" + params.toString() : ""));
    const request = { method: options.method, headers: options.headers || {} };
    const response = new FakeResponse();
    const state = {
      profile: options.profile || "local",
      settings: { workspaceRoot: options.root },
    };
    const security = options.security || { authMode: "bridge-token", allowedOrigins: [] };
    await handleWorkspaceResourceRoute({
      request,
      response,
      url,
      state,
      security,
      sendJson(target, status, data) {
        target.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        target.end(JSON.stringify(data));
      },
      readJsonBody: async () => options.body || {},
    });
    await response.done;
    return {
      status: response.status,
      headers: response.headers,
      chunks: response.chunks,
      text: Buffer.concat(response.chunks).toString("utf8"),
      get json() {
        return JSON.parse(Buffer.concat(response.chunks).toString("utf8") || "{}");
      },
    };
  }

  async function callLocalResourceRoute(options) {
    const url = new URL("http://127.0.0.1" + options.path);
    const request = { method: options.method, headers: options.headers || {} };
    const response = new FakeResponse();
    await handleLocalResourceRoute({
      request,
      response,
      url,
      state: { profile: options.profile || "local" },
      security: { authMode: "bridge-token", allowedOrigins: [] },
      sendJson(target, status, data) {
        target.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        target.end(JSON.stringify(data));
      },
      readJsonBody: async () => options.body || {},
    }, {
      reveal: options.reveal || (async () => {
        throw new Error("unexpected reveal");
      }),
      ...(options.revealGate ? { revealGate: options.revealGate } : {}),
    });
    await response.done;
    return {
      status: response.status,
      get json() {
        return JSON.parse(Buffer.concat(response.chunks).toString("utf8") || "{}");
      },
    };
  }

  })();
`,
  "utf8",
);

try {
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    absWorkingDir: projectRoot,
    alias: {
      "#agent-protocol/locale-registry": join(projectRoot, "packages/agent-protocol/src/locale-registry.ts"),
    },
    nodePaths: [join(projectRoot, "node_modules")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    banner: {
      js: "import { createRequire as __opengroveCreateRequire } from 'node:module'; const require = __opengroveCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(bundlePath).href);
  await module.done;
  assert.ok(true);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
