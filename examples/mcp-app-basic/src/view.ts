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
    await app.callServerTool({
      name: "opengrove.app.workspace.write",
      arguments: {
        path: "runs/mcp-app-demo.txt",
        content: "workspace round trip complete",
      },
    });
    return app.callServerTool({
      name: "opengrove.app.workspace.read",
      arguments: { path: "runs/mcp-app-demo.txt" },
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
