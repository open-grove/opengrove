export function minimalMcpAppHtml(title: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: transparent; }
    main { max-width: 720px; margin: 0 auto; }
    button { font: inherit; padding: 8px 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p id="status">正在连接 Host…</p>
    <button id="list-files" type="button" disabled>读取 App 工作区</button>
    <pre id="output"></pre>
  </main>
  <script type="module">
    const status = document.querySelector("#status");
    const output = document.querySelector("#output");
    const button = document.querySelector("#list-files");
    const pending = new Map();
    let nextId = 1;

    function send(message) { window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*"); }
    function request(method, params) {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/tool-input") status.textContent = "App 已就绪";
      if (message.method === "ui/notifications/tool-result") button.disabled = false;
      if (message.id !== undefined && message.method === "ui/resource-teardown") {
        send({ id: message.id, result: {} });
      }
    });

    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await request("tools/call", {
          name: "opengrove.app.workspace.list",
          arguments: { maxDepth: 3, maxEntries: 100 },
        });
        output.textContent = JSON.stringify(result.structuredContent ?? result, null, 2);
      } catch (error) {
        output.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    });

    await request("ui/initialize", {
      appInfo: { name: ${JSON.stringify(title)}, version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    });
    send({ method: "ui/notifications/initialized", params: {} });
  <\/script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
