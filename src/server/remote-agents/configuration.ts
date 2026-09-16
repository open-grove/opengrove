import { AgentRouterClient } from "@agent-router/sdk";
import { readAppEnv } from "../../identity.js";
import type { BridgeSettings } from "../bridge-types.js";

/** Validate without connecting. Empty explicitly disables the local configuration. */
export function normalizeAgentRouterUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const url = value.trim();
  if (!url) return "";
  // URL.search/hash are empty for bare delimiters, but SDK request paths are appended to href.
  if (/[?#]/.test(url)) return undefined;
  try {
    return new AgentRouterClient({
      baseUrl: url,
      accessToken: "",
      allowLocalHTTP: readAppEnv("AGENT_ROUTER_ALLOW_LOCAL_HTTP") === "1",
    }).baseUrl;
  } catch {
    return undefined;
  }
}

export function agentRouterConfiguration(settings: Pick<BridgeSettings, "agentRouterUrl">): {
  url: string;
  managed: boolean;
} {
  const explicit = readAppEnv("AGENT_ROUTER_URL")?.trim();
  return { url: explicit || settings.agentRouterUrl || "", managed: Boolean(explicit) };
}
