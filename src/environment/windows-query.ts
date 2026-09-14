import { execFile } from "node:child_process";
import { join } from "node:path";

export type WindowsCommandQuery = (
  executable: "powershell.exe",
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<string | undefined> | string | undefined;

export interface WindowsEnvironmentProbe {
  platform?: NodeJS.Platform;
  query?: WindowsCommandQuery;
  force?: boolean;
}

interface QuerySnapshot {
  output?: string;
  checkedAt?: number;
  pending?: Promise<string | undefined>;
  pendingForced?: boolean;
}

const snapshots = new WeakMap<WindowsCommandQuery, Map<string, QuerySnapshot>>();

export function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return (
    environment[name] ?? Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  );
}

/** Discovery helpers need Windows identity/system paths, never Provider credentials. */
export function windowsProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "ALLUSERSPROFILE",
    "COMPUTERNAME",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "TEMP",
    "TMP",
    "PSModulePath",
    "PSModuleAnalysisCachePath",
  ]) {
    const value = windowsEnvironmentValue(environment, key);
    if (value !== undefined) result[key] = value;
  }
  const systemRoot = result.SystemRoot || result.WINDIR;
  if (systemRoot) {
    result.PATH = join(systemRoot, "System32");
    // Preserve configured module lookup and analysis-cache paths: dropping
    // either can stall PowerShell 5.1 startup or Appx command discovery.
    result.PSModulePath ??= join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  }
  return result;
}

function querySnapshot(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  query: WindowsCommandQuery,
): QuerySnapshot {
  let cache = snapshots.get(query);
  if (!cache) {
    cache = new Map();
    snapshots.set(query, cache);
  }
  const key = `${JSON.stringify(windowsProbeEnvironment(environment))}\0${JSON.stringify(args)}`;
  let snapshot = cache.get(key);
  if (!snapshot) {
    snapshot = {};
    cache.set(key, snapshot);
  }
  return snapshot;
}

/** Reading a snapshot never starts a subprocess, including on a cold cache. */
export function readWindowsQuery(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  query: WindowsCommandQuery = queryWindowsCommand,
): string | undefined {
  return querySnapshot(args, environment, query).output;
}

export function refreshWindowsQuery(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  probe: WindowsEnvironmentProbe = {},
  ttlMs = 60_000,
): Promise<string | undefined> {
  const query = probe.query ?? queryWindowsCommand;
  const snapshot = querySnapshot(args, environment, query);
  if (snapshot.pending) {
    return probe.force && !snapshot.pendingForced
      ? snapshot.pending.then(() => refreshWindowsQuery(args, environment, probe, ttlMs))
      : snapshot.pending;
  }
  if (!probe.force && snapshot.checkedAt !== undefined && Date.now() - snapshot.checkedAt < ttlMs)
    return Promise.resolve(snapshot.output);
  const refresh = Promise.resolve()
    .then(() => query("powershell.exe", args, windowsProbeEnvironment(environment)))
    .then((output) => {
      // A failed query must not erase a previously observed install. Successful
      // empty output still records absence, and failures are throttled too.
      if (output !== undefined) snapshot.output = output;
      return snapshot.output;
    })
    .catch((error: unknown) => {
      console.warn(`[windows-discovery] query failed: ${error instanceof Error ? error.message : String(error)}`);
      return snapshot.output;
    })
    .finally(() => {
      snapshot.checkedAt = Date.now();
      snapshot.pending = undefined;
    });
  snapshot.pendingForced = probe.force === true;
  snapshot.pending = refresh;
  return refresh;
}

/** Fixed system executable and bounded asynchronous query; never use a project PATH. */
export const queryWindowsCommand: WindowsCommandQuery = (executable, args, environment) => {
  const safeEnvironment = windowsProbeEnvironment(environment);
  const systemRoot = safeEnvironment.SystemRoot || safeEnvironment.WINDIR;
  if (!systemRoot) return undefined;
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", executable);
  return new Promise<string | undefined>((resolve) => {
    const child = execFile(
      command,
      [...args],
      { env: safeEnvironment, encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.warn(
            `[windows-discovery] powershell.exe probe failed (code=${error.code ?? "unknown"}, killed=${error.killed ?? false}): ${error.message}`,
          );
          resolve(undefined);
        } else resolve(stdout);
      },
    );
    // These fixed queries accept no input; close the pipe so a helper cannot
    // wait for stdin until the query timeout.
    child.stdin?.end();
  });
};
