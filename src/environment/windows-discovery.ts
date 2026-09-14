import { win32 } from "node:path";
import {
  readWindowsQuery,
  refreshWindowsQuery,
  windowsEnvironmentValue,
  type WindowsEnvironmentProbe,
} from "./windows-query.js";
export {
  queryWindowsCommand,
  windowsEnvironmentValue,
  type WindowsCommandQuery,
  type WindowsEnvironmentProbe,
} from "./windows-query.js";

// PowerShell emits UTF-8 explicitly; reg.exe's console code page can corrupt
// non-ASCII user/install directories when Node decodes redirected output.
const REGISTRY_PATH_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = @(
  [string][Environment]::GetEnvironmentVariable('Path', 'Machine')
  [string][Environment]::GetEnvironmentVariable('Path', 'User')
)
ConvertTo-Json -InputObject $paths -Compress
`;

const REGISTRY_PATH_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", REGISTRY_PATH_QUERY];

/** Ordinary reads use the last snapshot and never spawn PowerShell. */
export function readWindowsPath(
  environment: NodeJS.ProcessEnv,
  probe: WindowsEnvironmentProbe = {},
): NodeJS.ProcessEnv {
  if ((probe.platform ?? process.platform) !== "win32") return environment;
  const output = readWindowsQuery(REGISTRY_PATH_ARGS, environment, probe.query);
  return mergeWindowsPath(environment, output);
}

/** Login status probes must not block the Host while Windows reads its registry. */
export async function refreshWindowsPath(
  environment: NodeJS.ProcessEnv,
  probe: WindowsEnvironmentProbe = {},
): Promise<NodeJS.ProcessEnv> {
  if ((probe.platform ?? process.platform) !== "win32") return environment;
  const output = await refreshWindowsQuery(REGISTRY_PATH_ARGS, environment, probe);
  return mergeWindowsPath(environment, output);
}

function mergeWindowsPath(environment: NodeJS.ProcessEnv, output: string | undefined): NodeJS.ProcessEnv {
  const paths = [windowsEnvironmentValue(environment, "PATH") ?? ""];
  if (output?.trim()) {
    try {
      const values: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
      if (!Array.isArray(values) || !values.every((value) => typeof value === "string"))
        throw new Error("expected PATH strings");
      paths.push(
        ...values.map((value: string) =>
          value.replace(
            /%([^%]+)%/g,
            (reference: string, name: string) => windowsEnvironmentValue(environment, name) ?? reference,
          ),
        ),
      );
    } catch {
      console.warn("[windows-discovery] Registry PATH query returned invalid JSON");
    }
  }
  // Node passes only one case-insensitive PATH key to Windows children.
  const merged = { ...environment };
  for (const key of Object.keys(merged)) if (key.toLowerCase() === "path") delete merged[key];
  merged.PATH = windowsPathEntries(paths.join(";")).join(";");
  return merged;
}

export function windowsPathEntries(path: string | undefined): string[] {
  const unique = new Map<string, string>();
  for (const entry of (path ?? "").split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const key = win32.normalize(directory).toLowerCase();
    if (!unique.has(key)) unique.set(key, directory);
  }
  return [...unique.values()];
}

export function windowsPathFingerprint(path: string | undefined): string {
  return windowsPathEntries(path)
    .map((directory) => win32.normalize(directory).toLowerCase())
    .join(";");
}
