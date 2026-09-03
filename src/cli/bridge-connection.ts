import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_DISCOVERY_FILE_NAME } from "../bridge-discovery.js";
import { defaultOpenGroveDataDir } from "../storage/default-data-dir.js";
import { OpenGroveCliError } from "./errors.js";

export const DEFAULT_CLI_BRIDGE_API_URL = "http://127.0.0.1:37371/api";

export type CliBridgeBaseUrlSource = "flag" | "environment" | "default";

export interface CliBridgeConnection {
  apiUrl: string;
  stateId: string;
}

export async function resolveCliBridge(options: {
  baseUrl: string;
  baseUrlSource: CliBridgeBaseUrlSource;
  savedApiUrl?: string;
  expectedStateId?: string;
  fetch?: typeof globalThis.fetch;
  discoveryPaths?: readonly string[];
}): Promise<CliBridgeConnection> {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);

  const explicit = options.baseUrlSource !== "default";
  const candidates = explicit
    ? [normalizeApiUrl(options.baseUrl)]
    : [
        ...(options.discoveryPaths ?? cliBridgeDiscoveryPaths()).flatMap((path) => {
          const value = readDiscoveryApiUrl(path);
          return value ? [value] : [];
        }),
        ...(options.savedApiUrl ? safeNormalizedApiUrl(options.savedApiUrl) : []),
        normalizeApiUrl(options.baseUrl || DEFAULT_CLI_BRIDGE_API_URL),
      ];

  const tried: string[] = [];
  const mismatched: string[] = [];
  for (const candidate of new Set(candidates)) {
    if (!isLoopbackApiUrl(candidate)) {
      if (explicit) {
        throw new OpenGroveCliError(
          "authentication",
          "bridge_url_not_local",
          `Stored account credentials are only sent to a local OpenGrove Bridge: ${candidate}`,
        );
      }
      continue;
    }
    tried.push(candidate);
    const probe = await probeBridge(candidate, fetchImplementation);
    if (!probe) continue;
    if (!probe.stateId) {
      mismatched.push(candidate);
      continue;
    }
    if (options.expectedStateId && probe.stateId !== options.expectedStateId) {
      mismatched.push(candidate);
      continue;
    }
    return { apiUrl: candidate, stateId: probe.stateId };
  }

  if (mismatched.length > 0) {
    throw new OpenGroveCliError(
      "authentication",
      "bridge_identity_mismatch",
      "The running Bridge is not the one paired with this CLI. Run `opengrove auth login` to pair again.",
      { candidates: mismatched },
    );
  }
  throw new OpenGroveCliError(
    "network",
    "bridge_not_found",
    "No local OpenGrove Bridge is running. Start OpenGrove and try again.",
    { candidates: tried },
  );
}

export function isLoopbackApiUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
}

function cliBridgeDiscoveryPaths(): string[] {
  const paths = [join(defaultOpenGroveDataDir(), BRIDGE_DISCOVERY_FILE_NAME)];
  const home = homedir();
  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "OpenGroveDev", "data", BRIDGE_DISCOVERY_FILE_NAME));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    paths.push(join(appData, "OpenGroveDev", "data", BRIDGE_DISCOVERY_FILE_NAME));
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    paths.push(join(configHome, "opengrove-dev", "data", BRIDGE_DISCOVERY_FILE_NAME));
  }
  return paths;
}

function readDiscoveryApiUrl(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.apiUrl === "string") return normalizeApiUrl(parsed.apiUrl);
    if (typeof parsed.url === "string") return normalizeApiUrl(`${parsed.url.replace(/\/+$/u, "")}/api`);
  } catch {
    // non-critical-fallback: discovery files are hints and are always verified by the probe.
  }
  return undefined;
}

function safeNormalizedApiUrl(value: string): string[] {
  try {
    return [normalizeApiUrl(value)];
  } catch {
    return [];
  }
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenGroveCliError("validation", "invalid_base_url", `Invalid Bridge API base URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenGroveCliError("validation", "invalid_base_url", `Bridge API URL must use http or https: ${value}`);
  }
  if (url.search || url.hash) {
    throw new OpenGroveCliError(
      "validation",
      "invalid_base_url",
      `Bridge API URL must not contain a query or fragment: ${value}`,
    );
  }
  return value.replace(/\/+$/u, "");
}

async function probeBridge(
  apiUrl: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<{ stateId?: string } | undefined> {
  try {
    const response = await fetchImplementation(new URL("/opengrove-probe", apiUrl), {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.product !== "OpenGrove") return undefined;
    return { ...(typeof payload.stateId === "string" ? { stateId: payload.stateId } : {}) };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
