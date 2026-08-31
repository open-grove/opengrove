import { appEnvName } from "../identity.js";
import type { JsonObject } from "../core.js";

export interface KernelProxySettings {
  enabled?: boolean;
  proxyUrl?: string;
  noProxy?: string;
  nodeUseEnvProxy?: boolean;
}

export interface ResolvedKernelProxySettings {
  enabled: boolean;
  injected: boolean;
  proxyUrl: string;
  noProxy: string;
  nodeUseEnvProxy: boolean;
  environmentProxyUrl: string;
  source: "opengrove" | "environment" | "none";
}

export const DEFAULT_KERNEL_PROXY_URL = "http://127.0.0.1:7890";
export const DEFAULT_KERNEL_NO_PROXY = "127.0.0.1,localhost,::1";

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

export function resolveKernelProxySettings(
  settings: KernelProxySettings | undefined,
  env: NodeJS.ProcessEnv | undefined = process.env,
): ResolvedKernelProxySettings {
  const enabled = settings?.enabled ?? isEnabledFlag(env?.[appEnvName("KERNEL_PROXY")]);
  const proxyUrl =
    settings?.proxyUrl?.trim() || env?.[appEnvName("KERNEL_PROXY_URL")]?.trim() || DEFAULT_KERNEL_PROXY_URL;
  const noProxy =
    settings?.noProxy?.trim() || env?.[appEnvName("KERNEL_PROXY_NO_PROXY")]?.trim() || DEFAULT_KERNEL_NO_PROXY;
  const nodeUseEnvProxy =
    settings?.nodeUseEnvProxy ?? isEnabledFlag(env?.[appEnvName("KERNEL_PROXY_NODE_USE_ENV_PROXY")]);
  const environmentProxyUrl = firstProxyUrl(env);

  return {
    enabled,
    injected: enabled && Boolean(proxyUrl),
    proxyUrl,
    noProxy,
    nodeUseEnvProxy,
    environmentProxyUrl,
    source: enabled ? "opengrove" : environmentProxyUrl ? "environment" : "none",
  };
}

export function applyKernelProxyEnv(input: NodeJS.ProcessEnv, proxy: ResolvedKernelProxySettings): NodeJS.ProcessEnv {
  if (!proxy.enabled || !proxy.proxyUrl) {
    return input;
  }

  const env: NodeJS.ProcessEnv = { ...input };
  env.HTTP_PROXY = proxy.proxyUrl;
  env.HTTPS_PROXY = proxy.proxyUrl;
  env.ALL_PROXY = proxy.proxyUrl;
  env.http_proxy = proxy.proxyUrl;
  env.https_proxy = proxy.proxyUrl;
  env.all_proxy = proxy.proxyUrl;
  env.NO_PROXY = proxy.noProxy;
  env.no_proxy = proxy.noProxy;
  env[appEnvName("KERNEL_PROXY_ACTIVE")] = "1";

  if (proxy.nodeUseEnvProxy) {
    env.NODE_USE_ENV_PROXY = "1";
    env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, "--use-env-proxy");
  }

  return env;
}

export function kernelProxySummary(proxy: ResolvedKernelProxySettings): JsonObject {
  return {
    enabled: proxy.enabled,
    injected: proxy.injected,
    proxyUrl: proxy.proxyUrl,
    noProxy: proxy.noProxy,
    nodeUseEnvProxy: proxy.nodeUseEnvProxy,
    environmentProxyUrl: proxy.environmentProxyUrl,
    source: proxy.source,
  };
}

function firstProxyUrl(env: NodeJS.ProcessEnv | undefined): string {
  return (
    env?.HTTPS_PROXY ||
    env?.https_proxy ||
    env?.HTTP_PROXY ||
    env?.http_proxy ||
    env?.ALL_PROXY ||
    env?.all_proxy ||
    ""
  ).trim();
}

function appendNodeOption(current: string | undefined, option: string): string {
  const parts = (current ?? "").split(/\s+/).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

function isEnabledFlag(value: string | undefined): boolean {
  return value !== undefined && !DISABLED_VALUES.has(value.trim().toLowerCase());
}
