// Isolated UI fixture. It never contacts a real Host, WW account or publisher.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(tmpdir(), "opengrove-website-ui-"));
const digest = "a".repeat(64);
const config = {
  schemaVersion: 1,
  appId: "website-preview",
  title: "Website preview",
  output: "ui",
  entry: "index.html",
  mode: "static",
  audience: { mode: "authenticated" },
  permissions: [],
  includedFeatures: ["展示页面（测试内容）"],
  desktopOnlyFeatures: [],
};
let website = {
  inspection: { ready: true, config, findings: [], fileCount: 1, totalBytes: 100 },
  artifactSha256: digest,
  reviewStatus: "current",
  review: {
    schemaVersion: 1,
    artifactSha256: digest,
    summary: "这是界面测试用的检查记录，不代表真实 App 已验证。",
    checks: ["UI fixture"],
    reviewedAt: "2026-09-14T00:00:00Z",
  },
};
const requests = [];
await build({
  stdin: {
    contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
      import {AppWebsitePublishPanel} from "./web/src/components/network/app-website-publish-panel";
      import "./web/src/styles/tokens.css";
      import "./web/src/styles/reset.css";
      import "./web/src/styles/primitives.css";
      createRoot(document.getElementById("root")).render(
        <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>
          <h1>发布界面测试</h1><p>使用合成数据；不会登录或发布真实网页。</p>
          <AppWebsitePublishPanel appId="website-preview"/>
        </QueryClientProvider>
      );
    `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  tsconfig: join(root, "web/tsconfig.json"),
  outfile: join(output, "preview.js"),
  alias: {
    "#protocol": join(root, "packages/protocol/src/index.ts"),
    "@opengrove/protocol": join(root, "packages/protocol/src/index.ts"),
    "@opengrove/client": join(root, "packages/client/src/index.ts"),
    "@opengrove/agent-protocol/locale-registry": join(root, "packages/agent-protocol/src/locale-registry.ts"),
  },
  define: { "import.meta.env.DEV": "false", __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: "false" },
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  const send = (status, value) => {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  };
  if (url.pathname === "/fixture/requests") {
    send(200, requests);
    return;
  }
  if (url.pathname === "/fixture/review") {
    website = { ...website, reviewStatus: "current" };
    send(200, { ok: true });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    let body = "";
    for await (const part of request) body += part;
    const value = body ? JSON.parse(body) : undefined;
    requests.push({ method: request.method, path: url.pathname, body: value });
    if (request.method === "GET") {
      send(200, { ok: true, website });
      return;
    }
    if (url.pathname.endsWith("/audience")) {
      website = {
        ...website,
        inspection: { ...website.inspection, config: { ...config, audience: value.audience } },
        reviewStatus: "stale",
      };
      send(200, { ok: true, website });
      return;
    }
    if (url.pathname.endsWith("/publish")) {
      const site = {
        appId: config.appId,
        host: "preview.apps.example.test",
        url: "https://preview.apps.example.test",
        sha256: digest,
        updatedAt: new Date().toISOString(),
      };
      website = { ...website, site };
      send(200, { ok: true, site });
      return;
    }
    send(409, { ok: false, error: "fixture_operation_unavailable" });
    return;
  }
  if (url.pathname === "/preview.js" || url.pathname === "/preview.css") {
    response.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css" });
    response.end(await readFile(join(output, url.pathname.slice(1))));
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="opengrove-api-base" content="/api/"><title>Website publishing UI fixture</title><link rel="stylesheet" href="/preview.css"><style>body{font-family:system-ui;background:var(--c-bg);color:var(--c-text);padding:32px}#root{max-width:860px;margin:auto}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>`,
  );
});
server.listen(0, "127.0.0.1", () =>
  console.log(JSON.stringify({ previewUrl: `http://127.0.0.1:${server.address().port}/`, fixtureOnly: true })),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => void rm(output, { recursive: true, force: true }).then(() => process.exit(0)));
  });
