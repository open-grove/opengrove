import { APP_DESKTOP_MCP_APP_SANDBOX_ORIGIN, APP_MCP_APP_SANDBOX_HOSTNAME } from "../../../../src/identity";

interface McpAppSandboxUrlInput {
  bridgeBootstrapUrl: string;
  sandboxOrigin?: string;
}

export function resolveMcpAppSandboxUrl(input: McpAppSandboxUrlInput): string {
  const bridgeUrl = new URL(input.bridgeBootstrapUrl);
  const sandboxUrl = new URL("../mcp-app-sandbox", bridgeUrl);

  if (input.sandboxOrigin) {
    const sandboxOrigin = new URL(input.sandboxOrigin);
    sandboxUrl.protocol = sandboxOrigin.protocol;
    sandboxUrl.host = sandboxOrigin.host;
    return sandboxUrl.toString();
  }

  if (bridgeUrl.protocol === "opengrove-desktop:") {
    const desktopSandboxOrigin = new URL(APP_DESKTOP_MCP_APP_SANDBOX_ORIGIN);
    sandboxUrl.protocol = desktopSandboxOrigin.protocol;
    sandboxUrl.host = desktopSandboxOrigin.host;
    return sandboxUrl.toString();
  }

  if (bridgeUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(bridgeUrl.hostname)) {
    throw new Error("mcp_app_sandbox_origin_required");
  }
  sandboxUrl.hostname = APP_MCP_APP_SANDBOX_HOSTNAME;
  return sandboxUrl.toString();
}
