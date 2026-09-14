import { websiteBrowserSDK } from "./website-browser-sdk.js";
import { appWebsiteReviewInputSchema } from "#protocol";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";
import {
  createAppWebsiteArtifact,
  getLocalAppWebsiteState,
  prepareAppWebsite,
  readWebsiteFile,
  recordAppWebsiteReview,
} from "./website.js";

const USAGE = `opengrove app web <prepare|check|review|preview> <app-root>

  prepare               Prepare browser configuration and inspect output.
  check                 Check output and print its exact artifact digest.
  review <report.json>  Record checks and summary against artifactSha256.
  preview [--port N]    Serve an isolated browser preview on loopback.

Run the App's documented build command before checking and reviewing.
The preview has no desktop bridge or account session. HTTP behavior must
also be tested against the intended API and account roles.
Publish reviewed output using: opengrove app website publish --help
`;
export async function runAppWebsiteCli(args: string[]): Promise<void> {
  if (!args[0] || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const [command, root, ...options] = args;
  if (!root) throw new Error("website_app_root_required");
  const appRoot = resolve(root);
  if (command === "prepare" && options.length === 0) {
    console.log(JSON.stringify(prepareAppWebsite(appRoot), null, 2));
  } else if (command === "check" && options.length === 0) {
    const state = getLocalAppWebsiteState(appRoot);
    console.log(JSON.stringify(state, null, 2));
    if (!state.inspection.ready) process.exitCode = 1;
  } else if (command === "review" && options.length === 1) {
    const input: unknown = JSON.parse(readWebsiteFile(resolve(options[0]!), 128 * 1024).toString("utf8"));
    console.log(JSON.stringify(recordAppWebsiteReview(appRoot, appWebsiteReviewInputSchema.parse(input)), null, 2));
  } else if (command === "preview" && (options.length === 0 || (options.length === 2 && options[0] === "--port"))) {
    const port = options.length ? Number(options[1]) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("website_preview_port_invalid");
    const server = await startAppWebsitePreview(appRoot, port);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("website_preview_failed");
    console.log(
      JSON.stringify({
        previewUrl: `http://127.0.0.1:${address.port}/`,
        previewOnly: true,
        message: "Isolated browser preview; login and Cloud API requests are unavailable here. Stop with Ctrl+C.",
      }),
    );
  } else {
    throw new Error("website_command_invalid");
  }
}

/** Serves only the validated immutable output; never shares the Host's origin or credentials. */
export async function startAppWebsitePreview(appRoot: string, port = 0): Promise<Server> {
  const artifact = createAppWebsiteArtifact(appRoot);
  const value = JSON.parse(artifact.bytes.toString("utf8")) as { files: { path: string; content: string }[] };
  const files = new Map(value.files.map((file) => [file.path, Buffer.from(file.content, "base64")]));
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    const address = server.address();
    if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let path: string;
    let search: string;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      path = decodeURIComponent(url.pathname);
      search = url.search;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (path === "/_og/sdk.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.writeHead(200).end(websiteBrowserSDK);
      return;
    }
    if (path.startsWith("/_og/")) {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(501).end(JSON.stringify({ error: "website_preview_has_no_account", previewOnly: true }));
      return;
    }
    const entry = artifact.inspection.config!.entry;
    if (path === "/" && entry.includes("/")) {
      const target = new URL("http://127.0.0.1");
      target.pathname = "/" + entry;
      response.writeHead(307, { Location: target.pathname + search }).end();
      return;
    }
    const file = path === "/" ? entry : path.slice(1);
    const bytes = files.get(file);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    response.setHeader("Content-Length", bytes.length);
    response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  return server;
}
