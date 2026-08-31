export const APP_PRODUCT_NAME = "OpenGrove";
export const APP_PROTOCOL_ID = "opengrove";
export const APP_KNOWLEDGE_SCOPE = "app";
export const APP_ENV_PREFIX = "OPENGROVE";
export const APP_CONFIG_DIR = ".opengrove";
export const APP_VAULT_DIR = "opengrove-vault";
export const APP_VAULT_ROOT_NAME = APP_PRODUCT_NAME;
export const APP_BRIDGE_TOKEN_HEADER = "x-opengrove-token";
export const APP_DESKTOP_PROXY_TOKEN_HEADER = "x-opengrove-desktop-proxy-token";
export const APP_LOCAL_BRIDGE_NAME = `${APP_PROTOCOL_ID}-local-bridge`;
export const APP_DESKTOP_UI_ORIGIN = "opengrove-desktop://ui";
export const APP_DESKTOP_API_BASE = `${APP_DESKTOP_UI_ORIGIN}/api`;
export const APP_DESKTOP_MCP_APP_SANDBOX_ORIGIN = "opengrove-desktop://mcp-app";
export const APP_MCP_APP_SANDBOX_HOSTNAME = "mcp-app.localhost";
export const APP_MANAGED_BY = APP_PROTOCOL_ID;
export const APP_NATIVE_SKILL_MARKER_FILE = ".opengrove-native-skill.json";
export const APP_DEFAULT_WW_BASE_URL = "https://opengrove.creativefitting.cn";
export const APP_DEFAULT_RELEASE_CONTROL_URL = "https://opengrove-release.creativefitting.cn";

export function appEnvName(name: string): string {
  return `${APP_ENV_PREFIX}_${name}`;
}

export function readAppEnv(name: string): string | undefined {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return runtimeProcess?.env?.[appEnvName(name)];
}

export function normalizeHttpOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
