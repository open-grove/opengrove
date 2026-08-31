export type McpAppDisplayMode = "inline" | "fullscreen";

export function resolveMcpAppDisplayMode(requestedMode: string): McpAppDisplayMode {
  return requestedMode === "fullscreen" ? "fullscreen" : "inline";
}
