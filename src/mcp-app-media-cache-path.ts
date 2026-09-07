import { join } from "node:path";

export const MCP_APP_MEDIA_CACHE_WORKSPACE_DIRECTORY = ".cache/opengrove-media";

export function mcpAppMediaCachePath(workspaceRoot: string): string {
  return join(workspaceRoot, ...MCP_APP_MEDIA_CACHE_WORKSPACE_DIRECTORY.split("/"));
}
