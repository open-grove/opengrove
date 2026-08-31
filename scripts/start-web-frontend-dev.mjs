import { resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = resolve(import.meta.dirname, "..");
const host = process.env.OPENGROVE_WEB_DEV_FRONTEND_HOST?.trim() || "127.0.0.1";
const port = parsePort(process.env.OPENGROVE_WEB_DEV_FRONTEND_PORT, 5173);
process.env.OPENGROVE_WEB_DEV_BACKEND_URL =
  process.env.OPENGROVE_WEB_DEV_BACKEND_URL?.trim() || "http://127.0.0.1:37371";

const server = await createServer({
  configFile: resolve(projectRoot, "vite.config.ts"),
  server: { host, port, strictPort: true },
});
await server.listen();
server.printUrls();

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  });
}

function parsePort(value, fallback) {
  const port = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OPENGROVE_WEB_DEV_FRONTEND_PORT must be an integer between 1 and 65535.");
  }
  return port;
}
