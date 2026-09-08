import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

const status = requiredElement<HTMLParagraphElement>("status");
const output = requiredElement<HTMLPreElement>("output");
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const app = new App(
  { name: "OpenGrove MCP App build fixture", version: "1.0.0" },
  {},
  { autoResize: false, strict: true },
);

app.onteardown = async () => ({});
app.ontoolinput = () => {
  status.textContent = "App 已就绪";
};
app.ontoolresult = () => {
  buttons.forEach((button) => {
    button.disabled = false;
  });
};

requiredElement<HTMLButtonElement>("list-files").addEventListener("click", () =>
  runAction(() =>
    app.callServerTool({
      name: "opengrove.app.workspace.list",
      arguments: { maxDepth: 3, maxEntries: 100 },
    }),
  ),
);
requiredElement<HTMLButtonElement>("write-read-file").addEventListener("click", () =>
  runAction(async () => {
    const path = "runs/mcp-app-demo.txt";
    const current = await app.callServerTool({
      name: "opengrove.app.workspace.read",
      arguments: { path },
    });
    const missing =
      current.isError &&
      current.content.some((item) => item.type === "text" && item.text === "workspace_file_not_found");
    if (current.isError && !missing) return current;
    const revision = missing ? "missing" : current.structuredContent?.revision;
    if (typeof revision !== "string") throw new Error("读取结果缺少文件版本，无法安全保存");
    // Append to the content we actually read, preserving previous clicks/edits.
    const previous = missing ? "" : current.structuredContent?.content;
    if (typeof previous !== "string") throw new Error("未能完整读取文本，无法安全保存");
    const saved = await app.callServerTool({
      name: "opengrove.app.workspace.write",
      arguments: {
        path,
        content: previous + "workspace round trip complete\n",
        expectedRevision: revision,
      },
    });
    // Surface a concurrent change; retrying with a new revision requires a new read.
    if (saved.isError) return saved;
    return app.callServerTool({
      name: "opengrove.app.workspace.read",
      arguments: { path },
    });
  }),
);
requiredElement<HTMLButtonElement>("run-command").addEventListener("click", () =>
  runAction(() =>
    app.callServerTool({
      name: "opengrove.app.command.run",
      arguments: { commandId: "describe-demo", args: ["from-ui"], parseJson: true },
    }),
  ),
);

void app.connect(new PostMessageTransport(window.parent, window.parent)).catch((error) => {
  status.textContent = `连接失败：${String(error)}`;
});

async function runAction(action: () => Promise<unknown>): Promise<void> {
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = (await action()) as { structuredContent?: unknown };
    output.textContent = JSON.stringify(result.structuredContent ?? result, null, 2);
  } catch (error) {
    output.textContent = String(error);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}
