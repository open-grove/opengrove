import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { build } from "esbuild";
import { _electron as electron } from "playwright";

const fixturePath = fileURLToPath(new URL("./fixtures/desktop-protocol-proxy-electron-main.ts", import.meta.url));
const expectedRequestBody = Buffer.concat([
  Buffer.from([0, 1, 2, 3, 255]),
  Buffer.from("OpenGrove:你好:"),
  Buffer.from([13, 10, 127, 128]),
]);
const expectedResponseBody = Buffer.from("bridge-first|bridge-second:完成");
const bridgeToken = "bridge-token-for-electron-smoke";
const proxyToken = "proxy-token-for-electron-smoke";
// Chromium 对同一个源最多开这么多条 HTTP/1.1 连接；占满之后新请求只能在内核里排队。
const MAX_SOCKETS_PER_GROUP = 6;
const upstreamRequests = [];
const hangingUpstreamRequests = [];
const abandonedUpstreamRequests = [];
const upstreamErrors = [];
let electronApp;
let temporaryRoot;

const server = createServer((request, response) => {
  void handleBridgeRequest(request, response).catch((error) => {
    upstreamErrors.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

try {
  const bridgePort = await listen(server);
  temporaryRoot = await mkdtemp(join(tmpdir(), "opengrove-electron-proxy-"));
  const appRoot = join(temporaryRoot, "app");
  const webRoot = join(temporaryRoot, "web");
  const userData = join(temporaryRoot, "user-data");
  await Promise.all([mkdir(appRoot), mkdir(webRoot), mkdir(userData)]);
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ main: "main.cjs" }));
  await writeFile(join(webRoot, "index.html"), '<!doctype html><meta charset="utf-8"><title>proxy smoke</title>');
  await build({
    entryPoints: [fixturePath],
    outfile: join(appRoot, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
  });

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, {
    OPENGROVE_SMOKE_BRIDGE_API_BASE: `http://127.0.0.1:${bridgePort}/api`,
    OPENGROVE_SMOKE_BRIDGE_TOKEN: bridgeToken,
    OPENGROVE_SMOKE_PROXY_TOKEN: proxyToken,
    OPENGROVE_SMOKE_USER_DATA: userData,
    OPENGROVE_SMOKE_WEB_ROOT: webRoot,
  });

  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [appRoot, "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: environment,
    timeout: 30_000,
  });
  const electronLogs = [];
  for (const output of [electronApp.process().stdout, electronApp.process().stderr]) {
    output?.on("data", (chunk) => electronLogs.push(String(chunk)));
  }

  const trustedPage = await electronApp.firstWindow();
  await trustedPage.waitForLoadState("domcontentloaded");
  const failedRequests = [];
  trustedPage.on("requestfailed", (request) => {
    failedRequests.push({ failure: request.failure(), url: request.url() });
  });
  const trustedResult = await trustedPage.evaluate(async () => {
    const encoder = new TextEncoder();
    const chunks = [
      new Uint8Array([0, 1, 2, 3, 255]),
      encoder.encode("OpenGrove:你好:"),
      new Uint8Array([13, 10, 127, 128]),
    ];
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunks[0]);
        setTimeout(() => {
          controller.enqueue(chunks[1]);
          setTimeout(() => {
            controller.enqueue(chunks[2]);
            controller.close();
          }, 5);
        }, 5);
      },
    });
    try {
      const response = await fetch("/api/stream-echo?case=trusted", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-opengrove-desktop-proxy-token": "renderer-spoof",
        },
        body,
        duplex: "half",
      });
      return {
        body: Array.from(new Uint8Array(await response.arrayBuffer())),
        status: response.status,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  assert.equal(
    trustedResult.error,
    undefined,
    JSON.stringify({ electronLogs, failedRequests, upstreamErrors, trustedResult }),
  );
  assert.equal(trustedResult.status, 200, JSON.stringify({ electronLogs, trustedResult }));
  assert.deepEqual(Buffer.from(trustedResult.body), expectedResponseBody);
  assert.equal(upstreamErrors.length, 0);
  assert.equal(upstreamRequests.length, 1);
  const [trustedRequest] = upstreamRequests;
  assert.equal(trustedRequest.method, "POST");
  assert.equal(trustedRequest.url, "/api/stream-echo?case=trusted");
  assert.deepEqual(trustedRequest.body, expectedRequestBody);
  assert.equal(trustedRequest.headers["x-opengrove-token"], bridgeToken);
  assert.equal(trustedRequest.headers.origin, undefined);
  assert.equal(trustedRequest.headers["x-opengrove-desktop-proxy-token"], undefined);

  const untrustedWindow = electronApp.waitForEvent("window");
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL("data:text/html,<title>untrusted</title>");
  });
  const untrustedPage = await untrustedWindow;
  await untrustedPage.evaluate(async () => {
    try {
      await fetch("opengrove-desktop://ui/api/stream-echo?case=untrusted", {
        headers: { "x-opengrove-desktop-proxy-token": "renderer-spoof" },
      });
    } catch {
      // A CORS failure is expected after the protocol handler rejects the request.
    }
  });
  const untrustedCompletion = await waitForCompletion(
    electronApp,
    "opengrove-desktop://ui/api/stream-echo?case=untrusted",
  );
  assert.equal(untrustedCompletion.statusCode, 403);
  assert.equal(upstreamRequests.length, 1, "untrusted renderer request reached the Bridge");

  // 连接组耗尽的端到端复现：真实 sandbox 源里的播放器连续放弃 Range 请求，
  // 然后立刻打开新 MCP App iframe。主进程若不把取消传下去，六条流会占满
  // mcp-app 源的连接组，新 sandbox 就会排队到面板超时。
  const sandboxEntry = await trustedPage.goto("opengrove-desktop://mcp-app/mcp-app-sandbox?case=connection-exhaustion");
  assert.equal(sandboxEntry?.status(), 200, "the test must actually enter the MCP App sandbox origin");
  const exhaustion = await trustedPage.evaluate(async (groupSize) => {
    const abandoned = Array.from({ length: groupSize }, () => new AbortController());
    // URL 必须各不相同：Chromium 会把并发的同 URL 请求合并成一条上游请求，
    // 那样就占不满连接组了。真实故障里每个 Range 请求的字节区间本来就不同。
    await Promise.all(
      abandoned.map((controller, slot) =>
        fetch(`/mcp-app-media/drip?slot=${slot}`, {
          headers: { range: `bytes=${slot * 1_048_576}-${(slot + 1) * 1_048_576 - 1}` },
          signal: controller.signal,
        }).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
    for (const controller of abandoned) controller.abort();
    const startedAt = performance.now();
    const iframe = document.createElement("iframe");
    iframe.src = "/mcp-app-sandbox?case=after-abandoned-media";
    document.body.append(iframe);
    return new Promise((resolve) => {
      const timeout = window.setTimeout(
        () =>
          resolve({
            elapsedMs: performance.now() - startedAt,
            stalled: "TimeoutError",
          }),
        5_000,
      );
      iframe.addEventListener(
        "load",
        () => {
          window.clearTimeout(timeout);
          resolve({
            elapsedMs: performance.now() - startedAt,
            ready: iframe.contentDocument?.body.dataset.mcpAppSandbox,
          });
        },
        { once: true },
      );
    });
  }, MAX_SOCKETS_PER_GROUP);
  assert.equal(
    hangingUpstreamRequests.length,
    MAX_SOCKETS_PER_GROUP,
    "abandoned requests must have actually reached the Bridge, otherwise this case is vacuous",
  );
  assert.equal(
    exhaustion.stalled,
    undefined,
    `a new MCP App panel must still open after abandoning ${MAX_SOCKETS_PER_GROUP} media requests: ${JSON.stringify({ electronLogs, exhaustion })}`,
  );
  assert.equal(exhaustion.ready, "ready", "the new iframe must actually load the sandbox document");
  assert.ok(
    exhaustion.elapsedMs < 1_000,
    `a new MCP App panel should open within 1s after abandoning ${MAX_SOCKETS_PER_GROUP} media requests: ${JSON.stringify(exhaustion)}`,
  );
  assert.equal(
    abandonedUpstreamRequests.length,
    MAX_SOCKETS_PER_GROUP,
    "every abandoned request must actually be aborted on the Bridge side rather than run to completion",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    electronLogs.join("").includes("Desktop custom-protocol request failed"),
    false,
    `a player's normal cancellation must not be logged as a request failure: ${JSON.stringify(electronLogs)}`,
  );
  assert.equal(
    upstreamErrors.length,
    0,
    `the connection-exhaustion regression must not mask Bridge fixture errors: ${JSON.stringify(upstreamErrors.map((error) => error.message))}`,
  );

  console.log("Electron custom-protocol proxy smoke passed.");
} finally {
  await electronApp?.close().catch(() => undefined);
  await close(server);
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}

async function handleBridgeRequest(request, response) {
  if (request.url?.startsWith("/mcp-app-sandbox")) {
    response
      .writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      })
      .end('<!doctype html><body data-mcp-app-sandbox="ready">sandbox ready</body>');
    return;
  }
  // 先回响应头并写出一块 body，然后一直不收尾：模拟一条正在传大文件、被中途放弃的上游请求。
  if (request.url?.startsWith("/mcp-app-media/drip")) {
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "");
    assert.ok(range, "the MCP App media reproduction must send a valid Range request");
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    hangingUpstreamRequests.push(request.url);
    response.once("close", () => {
      if (!response.writableEnded) abandonedUpstreamRequests.push(request.url);
    });
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${MAX_SOCKETS_PER_GROUP * 1_048_576}`,
      "content-type": "video/mp4",
    });
    response.write(Buffer.alloc(64 * 1024));
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  upstreamRequests.push({
    body: Buffer.concat(chunks),
    headers: request.headers,
    method: request.method,
    url: request.url,
  });
  if (request.method !== "POST" || request.url !== "/api/stream-echo?case=trusted") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.write(expectedResponseBody.subarray(0, 13));
  setTimeout(() => response.end(expectedResponseBody.subarray(13)), 5);
}

async function waitForCompletion(application, url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const completion = await application.evaluate(({ app }, targetUrl) => {
      const smokeApp = app;
      return smokeApp.__opengroveProtocolSmokeCompletions?.find((entry) => entry.url === targetUrl);
    }, url);
    if (completion) return completion;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Electron to complete ${url}`);
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.removeListener("error", reject);
      const address = target.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

function close(target) {
  return new Promise((resolve, reject) => {
    if (!target.listening) {
      resolve();
      return;
    }
    // 断言失败时可能还有挂着的请求；不主动掐断，close 的回调永远不会来。
    target.closeAllConnections();
    target.close((error) => (error ? reject(error) : resolve()));
  });
}
