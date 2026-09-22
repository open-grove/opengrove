import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const assets = fileURLToPath(new URL(".", import.meta.url));
const sdkRoot = dirname(fileURLToPath(import.meta.resolve("@opengrove/sdk")));

/** Trusted loopback companion; the Host token never goes into the browser bundle. */
export async function startEditor({
  port = 37430,
  hostUrl = "http://127.0.0.1:37371/api",
  token,
  workspace = resolve("editor-project"),
} = {}) {
  const upstream = new URL(hostUrl.endsWith("/") ? hostUrl : `${hostUrl}/`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)) throw new Error("local_host_required");
  if (upstream.protocol !== "http:") throw new Error("local_http_host_required");
  await mkdir(workspace, { recursive: true });
  const projectFile = join(workspace, "timeline.json");
  try {
    await writeFile(
      projectFile,
      JSON.stringify(
        { sessionId: `editor-${randomUUID()}`, title: "未命名项目", clips: ["开场", "主体", "结尾"], receipts: {} },
        null,
        2,
      ),
      { flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const readProject = async () => JSON.parse(await readFile(projectFile, "utf8"));
  let mutation = Promise.resolve();
  const headers = { "content-type": "application/json", ...(token ? { "x-opengrove-token": token } : {}) };
  let origin;
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        return reply(403, { error: "origin_not_allowed" });
      const url = new URL(request.url, origin);
      const productApi = url.pathname.startsWith("/product/") || url.pathname.startsWith("/api/");
      if (productApi && request.headers["x-editor-client"] !== "1")
        return reply(403, { error: "editor_header_required" });
      if (url.pathname === "/product/project" && request.method === "GET") {
        const { receipts: _receipts, ...project } = await readProject();
        return reply(200, { ...project, workspace });
      }
      if (url.pathname === "/product/rename" && request.method === "POST") {
        const { runId, callId, title } = JSON.parse(await body(request));
        if (
          typeof title !== "string" ||
          !title.trim() ||
          title.length > 120 ||
          typeof callId !== "string" ||
          typeof runId !== "string"
        )
          return reply(400, { error: "invalid_rename" });
        // Serialize business writes; persist each receipt atomically with the mutation.
        const operation = mutation.then(async () => {
          const project = await readProject();
          const saved = project.receipts[callId];
          if (saved) {
            if (saved.runId !== runId || saved.title !== title.trim()) throw new Error("receipt_conflict");
            return saved.result;
          }
          const readHost = async (path) => {
            const result = await fetch(new URL(path, upstream), { headers, redirect: "error" });
            if (!result.ok) throw new Error("host_task_unavailable");
            return result.json();
          };
          const task = await readHost(`runs/${encodeURIComponent(runId)}/result`);
          if (task.run.sessionId !== project.sessionId || task.finalized) throw new Error("task_not_active");
          const { calls } = await readHost(`runs/${encodeURIComponent(runId)}/tool-calls`);
          const call = calls.find((item) => item.id === callId);
          if (
            !call ||
            call.status !== "pending" ||
            call.toolId !== "client.renameTimeline" ||
            call.input.title !== title ||
            Date.parse(call.deadlineAt) <= Date.now()
          )
            throw new Error("tool_call_not_pending");
          project.title = title.trim();
          const result = { ok: true, value: { title: project.title } };
          project.receipts[callId] = { runId, title: project.title, result };
          const temporary = `${projectFile}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(project, null, 2));
          await rename(temporary, projectFile);
          return result;
        });
        mutation = operation.catch(() => {}); // Queue continuation only; the caller receives the error below.
        return reply(200, await operation);
      }
      if (url.pathname.startsWith("/api/")) {
        const path = url.pathname.slice("/api/".length);
        // This demo proxies only the operations used by its SDK. It is not a general Host gateway.
        const allowed =
          /^(bootstrap|sessions|runtime(?:\/inspect)?|runs(?:\/[^/]+\/(?:result|tool-calls(?:\/[^/]+\/result)?))?|events|approvals(?:\/[^/]+\/(?:approve|reject|cancel))?|questions(?:\/[^/]+\/(?:answer|decline|cancel))?|ask\/(?:cancel|guide))$/;
        if (!allowed.test(path) || !["GET", "POST"].includes(request.method)) return reply(404, { error: "not_found" });
        const result = await fetch(new URL(`${path}${url.search}`, upstream), {
          method: request.method,
          headers,
          redirect: "error",
          ...(request.method === "POST" ? { body: await body(request) } : {}),
        });
        response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(await result.text());
        return;
      }
      if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
      const files = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      let filename, contentType;
      if (url.pathname.startsWith("/sdk/") && url.pathname.endsWith(".js")) {
        filename = resolve(sdkRoot, url.pathname.slice(5));
        if (!filename.startsWith(`${sdkRoot}${sep}`)) return reply(404, { error: "not_found" });
        contentType = "text/javascript";
      } else if (files[url.pathname]) {
        const [file, type] = files[url.pathname];
        filename = join(assets, file);
        contentType = type;
      } else return reply(404, { error: "not_found" });
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      });
      response.end(await readFile(filename));
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, workspace };
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const editor = await startEditor({
    port: Number(process.env.EDITOR_PORT ?? 37430),
    hostUrl: process.env.OPENGROVE_BRIDGE_URL,
    token: process.env.OPENGROVE_BRIDGE_TOKEN,
    workspace: process.env.EDITOR_WORKSPACE,
  });
  console.log(`Editor: ${editor.url}`);
  const stop = () => editor.server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
